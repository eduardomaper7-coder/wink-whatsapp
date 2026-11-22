import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import { JOB, processWebhookPayload } from "@/lib/whatsapp/inbound/process";
import { SupabaseInboundStore } from "@/lib/whatsapp/inbound/supabase-store";
import { downloadMedia, extensionFor, sha256Matches, storagePathFor } from "@/lib/whatsapp/media";
import type { NormalizedStatus, WebhookPayload } from "@/lib/whatsapp/types";
import { deliverMessage, SEND_JOB, SYNC_TEMPLATES_JOB } from "@/lib/whatsapp/outbound/service";
import { syncTemplates } from "@/lib/whatsapp/outbound/templates";
import { generateAndSendBriefing } from "@/lib/agent/briefing";
import { agentFailedHandoff, AGENT_JOB, runAgent } from "@/lib/agent/run";
import { BRIEFING_JOB } from "@/lib/agent/tools";
import { transcribe, TranscriptionError, transcriptionEnabled } from "@/lib/transcription/groq";
import { PUSH_JOB } from "@/lib/notify/constants";
import { runPushJob, type PushJob } from "@/lib/notify/triggers";
import { enqueueJob, PermanentJobError, RetryLaterError } from "../queue";
import { RECEPCION_FORWARD_JOB, RECEPCION_LEAD_JOB, runForwardJob, runLeadJob } from "@/lib/integrations/recepcion";

export interface JobContext {
  db: SupabaseClient;
}

export interface JobHandler {
  run(payload: Record<string, unknown>, ctx: JobContext): Promise<void>;
  /** Se llama cuando el trabajo agota los reintentos. */
  onDead?(payload: Record<string, unknown>, ctx: JobContext, error: string): Promise<void>;
}

// ---------------------------------------------------------------------
// process_webhook: procesa un webhook guardado en wa_webhook_events
// ---------------------------------------------------------------------
const processWebhook: JobHandler = {
  async run(payload, { db }) {
    const eventId = Number(payload.eventId);
    const { data, error } = await db.from("wa_webhook_events").select("payload").eq("id", eventId).single();
    if (error || !data) throw new PermanentJobError(`Webhook ${eventId} no encontrado`);

    const summary = await processWebhookPayload(data.payload as WebhookPayload, new SupabaseInboundStore(db), {
      phoneNumberId: env().WHATSAPP_PHONE_NUMBER_ID,
    });
    await db.from("wa_webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", eventId);
    log.info("webhook.processed", { eventId, ...summary });
  },
};

// ---------------------------------------------------------------------
// download_media: Meta → Supabase Storage → attachments
// ---------------------------------------------------------------------
const downloadMediaHandler: JobHandler = {
  async run(p, { db }) {
    const messageId = String(p.messageId);
    const conversationId = String(p.conversationId);
    const bucket = env().SUPABASE_MEDIA_BUCKET;

    let file;
    try {
      file = await downloadMedia(String(p.mediaId));
    } catch (e) {
      // 4xx no reintentable (media borrada, id inválido…) → no insistir
      if (e instanceof WhatsAppApiError && !e.retryable && e.httpStatus < 500) {
        throw new PermanentJobError(`Media no disponible (HTTP ${e.httpStatus}, code ${e.code ?? "-"})`);
      }
      throw e;
    }

    const match = sha256Matches(file.sha256Hex, (p.sha256 as string | null) ?? file.info.sha256);
    if (match === false) log.warn("media.sha256_mismatch", { messageId });

    const ext = extensionFor(file.mimeType, p.filename as string | null);
    const path = storagePathFor(conversationId, messageId, new Date(String(p.at)), ext);

    const { error: upErr } = await db.storage.from(bucket).upload(path, file.bytes, { contentType: file.mimeType, upsert: true });
    if (upErr) throw new Error(`[storage] ${upErr.message}`);

    // Enlazar al expediente abierto de la conversación, si ya existe (fase 3 lo creará)
    const { data: lead } = await db
      .from("leads")
      .select("id")
      .eq("conversation_id", conversationId)
      .not("status", "in", "(closed,lost)")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { error: attErr } = await db.from("attachments").upsert(
      {
        message_id: messageId,
        conversation_id: conversationId,
        lead_id: lead?.id ?? null,
        storage_bucket: bucket,
        storage_path: path,
        kind: String(p.kind),
        mime_type: file.mimeType,
        size_bytes: file.bytes.length,
        sha256: file.sha256Hex,
        original_filename: (p.filename as string | null) ?? null,
        caption: (p.caption as string | null) ?? null,
      },
      { onConflict: "storage_bucket,storage_path" },
    );
    if (attErr) throw new Error(`[db:attachments] ${attErr.message}`);

    const { error: msgErr } = await db
      .from("messages")
      .update({ media_status: "stored" })
      .eq("id", messageId);
    if (msgErr) throw new Error(`[db:messages] ${msgErr.message}`);

    if (p.kind === "audio" && transcriptionEnabled()) {
      await enqueueJob(db, TRANSCRIBE_JOB, { messageId, path, bucket, mimeType: file.mimeType }, { dedupeKey: `transcribe:${messageId}`, maxAttempts: 4 });
    }

    await db.from("events").insert({
      type: "media.stored",
      conversation_id: conversationId,
      message_id: messageId,
      lead_id: lead?.id ?? null,
      data: { kind: p.kind, mime_type: file.mimeType, size_bytes: file.bytes.length },
    });
  },

  async onDead(p, { db }, error) {
    await db.from("messages").update({ media_status: "failed" }).eq("id", String(p.messageId));
    await db.from("events").insert({
      type: "media.failed",
      conversation_id: String(p.conversationId),
      message_id: String(p.messageId),
      data: { error },
    });
  },
};

// ---------------------------------------------------------------------
// apply_status: estado que llegó antes que el mensaje saliente
// ---------------------------------------------------------------------
const applyStatus: JobHandler = {
  async run(p, { db }) {
    const status: NormalizedStatus = {
      waMessageId: String(p.waMessageId),
      status: p.status as NormalizedStatus["status"],
      timestamp: new Date(String(p.timestamp)),
      recipient: String(p.recipient),
      ...(p.error ? { error: p.error as NormalizedStatus["error"] } : {}),
      ...(p.callbackRef ? { callbackRef: String(p.callbackRef) } : {}),
    };
    const found = await new SupabaseInboundStore(db).applyStatus(status);
    if (!found) throw new Error("Mensaje saliente aún no registrado");
  },
  async onDead(p, { db }) {
    // Mensaje enviado fuera de este sistema (p. ej. desde el panel de Meta): solo se registra.
    await db.from("events").insert({ type: "status.orphan", data: { wamid: p.waMessageId, status: p.status } });
  },
};

// ---------------------------------------------------------------------
// send_message: (re)intento de envío de un mensaje saliente ya guardado
// ---------------------------------------------------------------------
const sendMessageHandler: JobHandler = {
  async run(p, { db }) {
    const outcome = await deliverMessage(db, String(p.messageId));
    if (outcome.kind === "retry") throw new RetryLaterError(String(outcome.error.title ?? "reintento"), outcome.retryAfterMs);
    // sent / failed / skipped: el trabajo termina (el fallo ya quedó registrado en el mensaje)
  },
  async onDead(p, { db }, error) {
    const id = String(p.messageId);
    const { data } = await db.from("messages").select("conversation_id, wa_message_id, error").eq("id", id).maybeSingle();
    if (!data || data.wa_message_id) return; // se envió al final (enlazado por webhook)
    const record = {
      ...((data.error as Record<string, unknown> | null) ?? {}),
      retrying: false,
      message_es: "No se pudo enviar tras varios intentos. Revisa el error y vuelve a intentarlo.",
      last_error: error,
    };
    await db.from("messages").update({ status: "failed", error: record, status_updated_at: new Date().toISOString() }).eq("id", id);
    await db.from("events").insert({ type: "message.failed", conversation_id: data.conversation_id, message_id: id, data: record });
  },
};

// ---------------------------------------------------------------------
// sync_templates: refresca la caché de plantillas desde Meta
// ---------------------------------------------------------------------
const syncTemplatesHandler: JobHandler = {
  async run(_p, { db }) {
    await syncTemplates(db);
  },
};

// ---------------------------------------------------------------------
// agent_reply: el agente responde a la conversación
// ---------------------------------------------------------------------
const agentReplyHandler: JobHandler = {
  async run(p, { db }) {
    const r = await runAgent(db, String(p.conversationId));
    log.info("agent.run", { conversationId: p.conversationId, outcome: r.outcome, reason: r.reason ?? null, sent: r.sent });
  },
  async onDead(p, { db }, error) {
    // Nunca dejar a un cliente sin respuesta: pasa a una persona
    await agentFailedHandoff(db, String(p.conversationId), error);
  },
};

// ---------------------------------------------------------------------
// transcribe_audio: nota de voz → texto (Groq Whisper)
// ---------------------------------------------------------------------
export const TRANSCRIBE_JOB = "transcribe_audio";
const transcribeHandler: JobHandler = {
  async run(p, { db }) {
    const messageId = String(p.messageId);
    const { data: blob, error } = await db.storage.from(String(p.bucket)).download(String(p.path));
    if (error || !blob) throw new Error(`[storage] ${error?.message ?? "audio no encontrado"}`);
    let text: string;
    try {
      text = await transcribe(new Uint8Array(await blob.arrayBuffer()), String(p.mimeType ?? "audio/ogg"));
    } catch (e) {
      if (e instanceof TranscriptionError && !e.retryable) throw new PermanentJobError(e.message);
      throw e;
    }
    const { data: msg } = await db.from("messages").select("content, conversation_id").eq("id", messageId).single();
    const content = { ...((msg?.content as Record<string, unknown>) ?? {}), transcript: text };
    await db.from("messages").update({ content, text_preview: `🎤 «${text.slice(0, 120)}${text.length > 120 ? "…" : ""}»` }).eq("id", messageId);
    await db.from("events").insert({ type: "media.transcribed", conversation_id: msg?.conversation_id, message_id: messageId, data: { chars: text.length } });
  },
  async onDead(p, { db }) {
    const { data: msg } = await db.from("messages").select("content").eq("id", String(p.messageId)).single();
    await db.from("messages").update({ content: { ...((msg?.content as Record<string, unknown>) ?? {}), transcript_status: "failed" } }).eq("id", String(p.messageId));
  },
};

// ---------------------------------------------------------------------
// generate_briefing: briefing del arquitecto (modelo potente) + email
// ---------------------------------------------------------------------
const briefingHandler: JobHandler = {
  async run(p, { db }) {
    await generateAndSendBriefing(db, String(p.leadId));
  },
  async onDead(p, { db }, error) {
    await db.from("leads").update({ briefing_error: error.slice(0, 500) }).eq("id", String(p.leadId));
    await db.from("events").insert({ type: "briefing.failed", lead_id: String(p.leadId), data: { error: error.slice(0, 500) } });
  },
};

// ---------------------------------------------------------------------
// push_notify: notificaciones push al equipo
// ---------------------------------------------------------------------
const pushHandler: JobHandler = {
  async run(p, { db }) {
    const r = await runPushJob(db, p as unknown as PushJob);
    log.info("push.sent", { kind: p.kind, ...r });
  },
};

// ---------------------------------------------------------------------
// Recepción del encargo: reenvío de mensajes y alta de expediente
// ---------------------------------------------------------------------
const recepcionForwardHandler: JobHandler = {
  async run(p, { db }) {
    await runForwardJob(db, String(p.conversationId));
  },
  async onDead(p, { db }, error) {
    await db.from("events").insert({ type: "recepcion.failed", conversation_id: String(p.conversationId), data: { error: error.slice(0, 500) } });
  },
};
const recepcionLeadHandler: JobHandler = {
  async run(p, { db }) {
    await runLeadJob(db, String(p.leadId));
  },
  async onDead(p, { db }, error) {
    await db.from("events").insert({ type: "recepcion.lead_failed", lead_id: String(p.leadId), data: { error: error.slice(0, 500) } });
  },
};

export const handlers: Record<string, JobHandler> = {
  [RECEPCION_FORWARD_JOB]: recepcionForwardHandler,
  [RECEPCION_LEAD_JOB]: recepcionLeadHandler,
  [JOB.PROCESS_WEBHOOK]: processWebhook,
  [JOB.DOWNLOAD_MEDIA]: downloadMediaHandler,
  [JOB.APPLY_STATUS]: applyStatus,
  [SEND_JOB]: sendMessageHandler,
  [SYNC_TEMPLATES_JOB]: syncTemplatesHandler,
  [AGENT_JOB]: agentReplyHandler,
  [TRANSCRIBE_JOB]: transcribeHandler,
  [BRIEFING_JOB]: briefingHandler,
  [PUSH_JOB]: pushHandler,
};
