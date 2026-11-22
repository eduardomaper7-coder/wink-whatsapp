import { log, maskPhone } from "@/lib/log";
import { PUSH_JOB } from "@/lib/notify/constants";
import { RECEPCION_FORWARD_JOB, recepcionEnabled } from "@/lib/integrations/recepcion";
import { extractMessageValues, extractTemplateStatusUpdates, normalizeInbound, normalizeStatus } from "../parse";
import type { WebhookPayload } from "../types";
import type { InboundStore } from "./store";

export const JOB = {
  PROCESS_WEBHOOK: "process_webhook",
  DOWNLOAD_MEDIA: "download_media",
  APPLY_STATUS: "apply_status",
} as const;

/** Segundos de espera antes de que responda el agente (agrupa mensajes seguidos). */
export const AGENT_DELAY_S = Number(process.env.AGENT_DEBOUNCE_SECONDS ?? 6);
export const AGENT_DELAY_MEDIA_S = AGENT_DELAY_S + 6;

export interface ProcessSummary {
  messagesStored: number;
  duplicates: number;
  statusesApplied: number;
  statusesDeferred: number;
  ignoredForeignNumber: number;
  systemErrors: number;
  templateUpdates: number;
  agentScheduled: number;
}

/**
 * Procesa un payload del webhook "messages" ya validado:
 * contactos → conversación → mensajes (idempotente por wamid) → media → estados.
 * Es seguro llamarlo varias veces con el mismo payload.
 */
export async function processWebhookPayload(
  payload: WebhookPayload,
  store: InboundStore,
  opts: { phoneNumberId: string },
): Promise<ProcessSummary> {
  const summary: ProcessSummary = {
    messagesStored: 0,
    duplicates: 0,
    statusesApplied: 0,
    statusesDeferred: 0,
    ignoredForeignNumber: 0,
    systemErrors: 0,
    templateUpdates: 0,
    agentScheduled: 0,
  };

  // ---------------- Cambios de estado de plantillas ----------------
  for (const u of extractTemplateStatusUpdates(payload)) {
    summary.templateUpdates++;
    await store.updateTemplateStatus(u);
    await store.logEvent({
      type: "template.status",
      data: {
        name: u.message_template_name,
        language: u.message_template_language,
        event: u.event,
        reason: u.rejection_info?.reason ?? u.reason ?? null,
        recommendation: u.rejection_info?.recommendation ?? null,
      },
    });
  }

  for (const value of extractMessageValues(payload)) {
    // Solo atendemos al número configurado (prueba o producción). Evita mezclar datos
    // si la misma app de Meta tiene varios números suscritos.
    const phoneId = value.metadata?.phone_number_id;
    if (phoneId && phoneId !== opts.phoneNumberId) {
      summary.ignoredForeignNumber += (value.messages?.length ?? 0) + (value.statuses?.length ?? 0);
      log.warn("webhook.foreign_phone_number", { phone_number_id: phoneId });
      continue;
    }

    // Errores de sistema / cuenta (no ligados a un mensaje)
    for (const err of value.errors ?? []) {
      summary.systemErrors++;
      await store.logEvent({ type: "whatsapp.system_error", data: { code: err.code, title: err.title ?? err.message, details: err.error_data?.details } });
    }

    const profileByWaId = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));

    // ---------------- Mensajes entrantes ----------------
    for (const raw of value.messages ?? []) {
      const msg = normalizeInbound(raw, profileByWaId.get(raw.from));
      const contact = await store.upsertContact(msg.from, msg.profileName);
      const conversation = await store.getOrCreateConversation(contact.id);

      const inserted = await store.insertInboundMessage({
        conversationId: conversation.id,
        type: msg.type,
        content: msg.content,
        textPreview: msg.textPreview,
        waMessageId: msg.waMessageId,
        replyToWaMessageId: msg.replyToWaMessageId,
        mediaId: msg.media?.id,
        waTimestamp: msg.timestamp,
      });

      if (!inserted) {
        summary.duplicates++;
        log.debug("webhook.duplicate_message", { wamid: msg.waMessageId });
        continue; // Reintento de Meta: ya procesado, sin efectos secundarios
      }
      summary.messagesStored++;

      const isReaction = msg.type === "reaction";
      if (msg.reaction) await store.setCustomerReaction(msg.reaction.targetWaMessageId, msg.reaction.emoji);

      // Las reacciones no cuentan como "no leído" ni cambian la vista previa
      await store.touchConversationInbound(conversation.id, msg.timestamp, isReaction ? null : msg.textPreview, !isReaction);

      if (msg.media) {
        await store.enqueueJob(
          JOB.DOWNLOAD_MEDIA,
          {
            messageId: inserted.id,
            conversationId: conversation.id,
            mediaId: msg.media.id,
            kind: msg.media.kind,
            mimeType: msg.media.mimeType ?? null,
            sha256: msg.media.sha256 ?? null,
            filename: msg.media.filename ?? null,
            caption: msg.media.caption ?? null,
            at: msg.timestamp.toISOString(),
          },
          { dedupeKey: `media:${msg.waMessageId}`, maxAttempts: 6 },
        );
      }

      await store.logEvent({
        type: msg.notice ? "message.unsupported" : "message.received",
        actor: "customer",
        conversationId: conversation.id,
        messageId: inserted.id,
        data: { type: msg.type, ...(msg.notice ? { notice: msg.notice } : {}) },
      });

      // Conversación atendida por el equipo → notificación push a la persona asignada
      if (!isReaction && conversation.status === "human") {
        await store.enqueueJob(PUSH_JOB, { kind: "message", conversationId: conversation.id, messageId: inserted.id }, { dedupeKey: `push:${msg.waMessageId}`, maxAttempts: 3 });
      }

      // Recepción del encargo: ¿es personal de Wink o un cliente con expediente? (se decide en el trabajo)
      if (!isReaction && recepcionEnabled()) {
        await store.enqueueJob(
          RECEPCION_FORWARD_JOB,
          { conversationId: conversation.id },
          { dedupeKey: `rcp:${msg.waMessageId}`, runAfter: new Date(Date.now() + (msg.media ? AGENT_DELAY_MEDIA_S : AGENT_DELAY_S) * 1000), maxAttempts: 8 },
        );
      }

      // Agente: espera unos segundos por si el cliente sigue escribiendo (ráfagas).
      // Con multimedia se espera algo más para que dé tiempo a descargarla/transcribirla.
      if (!isReaction) {
        const delay = msg.media ? AGENT_DELAY_MEDIA_S : AGENT_DELAY_S;
        const scheduled = await store.scheduleAgent(conversation.id, delay);
        if (scheduled) summary.agentScheduled++;
      }
    }

    // ---------------- Estados de mensajes salientes ----------------
    for (const raw of value.statuses ?? []) {
      const status = normalizeStatus(raw);
      if (!status) {
        log.info("webhook.unknown_status", { status: raw.status });
        continue;
      }
      const found = await store.applyStatus(status);
      if (found) {
        summary.statusesApplied++;
        if (status.status === "failed") {
          await store.logEvent({ type: "message.failed", data: { wamid: status.waMessageId, error: status.error ?? null } });
        }
      } else {
        // El estado puede llegar antes de que hayamos guardado el saliente: reintento diferido.
        summary.statusesDeferred++;
        await store.enqueueJob(
          JOB.APPLY_STATUS,
          { ...status, timestamp: status.timestamp.toISOString() },
          { dedupeKey: `status:${status.waMessageId}:${status.status}`, runAfter: new Date(Date.now() + 30_000), maxAttempts: 4 },
        );
        log.debug("webhook.status_deferred", { wamid: status.waMessageId, recipient: maskPhone(status.recipient) });
      }
    }
  }

  return summary;
}
