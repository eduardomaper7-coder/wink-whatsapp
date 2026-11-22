import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs/queue";
import { log } from "@/lib/log";
import { enqueuePush } from "@/lib/notify/triggers";
import { AmbiguousSendError, WhatsAppApiError } from "../errors";
import { extensionFor } from "../media";
import type { MessageType } from "../types";
import { windowState, type WindowState } from "../window";
import { checkOutboundMedia, postMessage, uploadMedia } from "./client";
import { buildMessagePayload, previewOf, type ResolvedMedia } from "./payload";
import { parseOutbound, ValidationError, type MediaRef, type OutboundContent } from "./schema";
import { checkTemplateValues, findTemplate, templateShape } from "./templates";

export const SEND_JOB = "send_message";
export const SYNC_TEMPLATES_JOB = "sync_templates";

export type Author = "agent" | "human" | "system";

export interface SendInput {
  conversationId: string;
  content: unknown; // se valida aquí
  author: Author;
  sentBy?: string | null; // usuario del equipo si author = human
  clientRef?: string | null; // idempotencia (doble clic)
  replyToWaMessageId?: string | null;
  /** true (por defecto): intenta enviar ya y, si falla de forma temporal, encola el reintento. */
  deliverInline?: boolean;
}

export interface OutboundMessage {
  id: string;
  conversation_id: string;
  direction: "outbound";
  author: Author;
  sent_by: string | null;
  type: MessageType;
  content: Record<string, unknown>;
  text_preview: string | null;
  wa_message_id: string | null;
  status: string;
  error: Record<string, unknown> | null;
  created_at: string;
}

const MESSAGE_COLUMNS = "id, conversation_id, direction, author, sent_by, type, content, text_preview, wa_message_id, status, error, created_at";

// ---------------------------------------------------------------------
// Errores de negocio (los traducen las rutas API a 4xx)
// ---------------------------------------------------------------------
export class WindowClosedError extends Error {
  readonly httpStatus = 409;
  constructor(readonly window: WindowState) {
    super("Han pasado más de 24 h desde el último mensaje del cliente: solo se pueden enviar plantillas aprobadas.");
    this.name = "WindowClosedError";
  }
}

export class SendRejectedError extends Error {
  constructor(message: string, readonly httpStatus = 422, readonly code = "send_rejected") {
    super(message);
    this.name = "SendRejectedError";
  }
}

function fail(op: string, error: { message: string } | null): never {
  throw new Error(`[db:${op}] ${error?.message ?? "sin datos"}`);
}

function messageTypeOf(c: OutboundContent): MessageType {
  if (c.type === "buttons" || c.type === "list") return "interactive";
  return c.type;
}

// ---------------------------------------------------------------------
// sendMessage: punto de entrada único (interfaz, agente y sistema)
// ---------------------------------------------------------------------
export async function sendMessage(db: SupabaseClient, input: SendInput): Promise<OutboundMessage> {
  const content = parseOutbound(input.content);

  if (input.clientRef) {
    const existing = await findByClientRef(db, input.clientRef);
    if (existing) return existing;
  }

  const { data: conv, error: convErr } = await db
    .from("conversations")
    .select("id, status, agent_active, last_inbound_at, contact:contacts!inner(id, wa_id, opted_out_at)")
    .eq("id", input.conversationId)
    .maybeSingle();
  if (convErr) fail("conversation", convErr);
  if (!conv) throw new SendRejectedError("La conversación no existe", 404, "not_found");
  const contact = conv.contact as unknown as { id: string; wa_id: string; opted_out_at: string | null };

  const win = windowState(conv.last_inbound_at as string | null);
  if (content.type !== "template" && !win.open) throw new WindowClosedError(win);
  if (contact.opted_out_at && !win.open) {
    throw new SendRejectedError("El cliente pidió no ser contactado. Solo se le puede responder si vuelve a escribir.", 422, "opted_out");
  }

  let templateBody: string | null = null;
  if (content.type === "template") {
    const tpl = await findTemplate(db, content.name, content.language);
    if (tpl) {
      if (tpl.status !== "APPROVED") {
        throw new SendRejectedError(`La plantilla «${content.name}» no está aprobada (estado: ${tpl.status}).`, 422, "template_not_approved");
      }
      const shape = templateShape(tpl.components);
      const problems = checkTemplateValues(shape, content);
      if (problems.length) throw new ValidationError(problems);
      templateBody = shape.bodyText;
    } else {
      // No sincronizada aún: se intenta igualmente; si no existe, Meta responderá 132001.
      log.warn("send.template_not_cached", { name: content.name, language: content.language });
    }
  }

  const preview = previewOf(content, templateBody);
  const { data: inserted, error: insErr } = await db
    .from("messages")
    .insert({
      conversation_id: conv.id,
      direction: "outbound",
      author: input.author,
      sent_by: input.author === "human" ? (input.sentBy ?? null) : null,
      type: messageTypeOf(content),
      content,
      text_preview: preview,
      status: "queued",
      client_ref: input.clientRef ?? null,
      reply_to_wa_message_id: input.replyToWaMessageId ?? null,
      media_status: content.type === "image" || content.type === "document" ? "pending" : "none",
    })
    .select(MESSAGE_COLUMNS)
    .single();

  if (insErr) {
    // Carrera con otro envío del mismo clientRef → devolver el existente
    if (insErr.code === "23505" && input.clientRef) {
      const existing = await findByClientRef(db, input.clientRef);
      if (existing) return existing;
    }
    fail("insert message", insErr);
  }
  const message = inserted as OutboundMessage;

  const byHuman = input.author === "human";
  const { error: touchErr } = await db.rpc("touch_conversation_outbound", {
    p_conversation_id: conv.id,
    p_at: message.created_at,
    p_preview: preview,
    p_by_human: byHuman,
    p_user: input.sentBy ?? null,
  });
  if (touchErr) fail("touch_conversation_outbound", touchErr);

  const actor = byHuman && input.sentBy ? `user:${input.sentBy}` : input.author;
  const events: Record<string, unknown>[] = [
    { type: "message.queued", actor, conversation_id: conv.id, message_id: message.id, data: { type: content.type } },
  ];
  if (byHuman && conv.agent_active) {
    events.push({ type: "agent.paused", actor, conversation_id: conv.id, data: { reason: "human_reply" } });
  }
  await db.from("events").insert(events);

  if (input.deliverInline === false) {
    await enqueueJob(db, SEND_JOB, { messageId: message.id }, { dedupeKey: `send:${message.id}`, maxAttempts: 6 });
  } else {
    const outcome = await deliverMessage(db, message.id);
    if (outcome.kind === "retry") {
      await enqueueJob(db, SEND_JOB, { messageId: message.id }, {
        dedupeKey: `send:${message.id}`,
        runAfter: new Date(Date.now() + outcome.retryAfterMs),
        maxAttempts: 6,
      });
    }
  }

  return (await getMessage(db, message.id)) ?? message;
}

// ---------------------------------------------------------------------
// deliverMessage: hace la llamada a Meta para un mensaje ya guardado.
// Seguro de llamar varias veces (no reenvía si ya tiene wamid).
// ---------------------------------------------------------------------
export type DeliveryOutcome =
  | { kind: "sent"; waMessageId: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; error: Record<string, unknown> }
  | { kind: "retry"; retryAfterMs: number; error: Record<string, unknown> };

export async function deliverMessage(db: SupabaseClient, messageId: string): Promise<DeliveryOutcome> {
  const { data: row, error } = await db
    .from("messages")
    .select("id, conversation_id, content, status, wa_message_id, reply_to_wa_message_id, conversation:conversations!inner(last_inbound_at, contact:contacts!inner(wa_id))")
    .eq("id", messageId)
    .maybeSingle();
  if (error) fail("load message", error);
  if (!row) return { kind: "skipped", reason: "not_found" };
  if (row.wa_message_id) return { kind: "skipped", reason: "already_sent" };
  if (row.status === "failed") return { kind: "skipped", reason: "already_failed" };

  const conversation = row.conversation as unknown as { last_inbound_at: string | null; contact: { wa_id: string } };
  const content = row.content as OutboundContent;

  try {
    // La ventana pudo cerrarse mientras el mensaje esperaba un reintento
    if (content.type !== "template" && !windowState(conversation.last_inbound_at).open) {
      return await markFailed(db, row.id, row.conversation_id, {
        code: 131047,
        kind: "window_closed",
        title: "Ventana de 24 h cerrada",
        message_es: "La ventana de 24 h se cerró antes de poder enviar el mensaje. Envía una plantilla.",
      });
    }

    const media = await resolveMedia(db, row.id, row.conversation_id, content);
    const payload = buildMessagePayload(content, {
      to: conversation.contact.wa_id,
      callbackRef: row.id,
      replyToWaMessageId: row.reply_to_wa_message_id ?? undefined,
      media,
    });

    const res = await postMessage(payload);
    const wamid = res.messages[0]!.id;

    // Si un webhook de estado ya enlazó el wamid (vía callback), no se pisa
    const { error: upErr } = await db
      .from("messages")
      .update({ wa_message_id: wamid, error: null, ...(media ? { media_status: "stored" } : {}) })
      .eq("id", row.id)
      .is("wa_message_id", null);
    if (upErr) fail("save wamid", upErr);

    const returnedWaId = res.contacts?.[0]?.wa_id;
    if (returnedWaId && returnedWaId !== conversation.contact.wa_id) {
      log.info("send.wa_id_differs", { input: conversation.contact.wa_id, wa_id: returnedWaId });
    }
    return { kind: "sent", waMessageId: wamid };
  } catch (e) {
    if (e instanceof WhatsAppApiError) {
      const record = e.toRecord();
      if (e.retryable) {
        await db.from("messages").update({ error: { ...record, retrying: true } }).eq("id", row.id);
        log.warn("send.retry", { messageId: row.id, code: e.code });
        return { kind: "retry", retryAfterMs: e.info.retryAfterMs ?? 15_000, error: record };
      }
      await handlePermanentSideEffects(db, e, row.conversation_id);
      return await markFailed(db, row.id, row.conversation_id, record);
    }
    if (e instanceof AmbiguousSendError) {
      // Sin respuesta: puede que Meta lo enviara. Esperamos a que un webhook de estado
      // traiga nuestro id (biz_opaque_callback_data) antes de reintentar.
      const record = { kind: "ambiguous", title: e.message, message_es: "Sin respuesta de WhatsApp; comprobando si se envió…", retrying: true };
      await db.from("messages").update({ error: record }).eq("id", row.id);
      return { kind: "retry", retryAfterMs: 90_000, error: record };
    }
    if (e instanceof ValidationError || e instanceof SendRejectedError) {
      return await markFailed(db, row.id, row.conversation_id, { kind: "invalid_request", title: e.message, message_es: e.message });
    }
    throw e; // errores de BD/Storage: los reintenta la cola
  }
}

async function markFailed(db: SupabaseClient, messageId: string, conversationId: string, record: Record<string, unknown>): Promise<DeliveryOutcome> {
  await db.from("messages").update({ status: "failed", error: record, status_updated_at: new Date().toISOString() }).eq("id", messageId);
  await db.from("events").insert({ type: "message.failed", conversation_id: conversationId, message_id: messageId, data: record });
  log.warn("send.failed", { messageId, code: record.code ?? null, kind: record.kind ?? null });
  return { kind: "failed", error: record };
}

async function handlePermanentSideEffects(db: SupabaseClient, e: WhatsAppApiError, conversationId: string) {
  if (e.kind === "auth") {
    // Token caducado o sin permisos: afecta a todo el sistema → alerta (push a admins en fase 5)
    await db.from("events").insert({ type: "whatsapp.auth_error", data: { code: e.code ?? null, message_es: e.info.es } });
    await enqueuePush(db, { kind: "auth_error", message: e.info.es }, `push:auth:${Math.floor(Date.now() / 3_600_000)}`);
  }
  if (e.kind === "template") {
    // Plantilla pausada/desactivada/inexistente: refrescar la caché de plantillas
    const bucket = Math.floor(Date.now() / 600_000); // como mucho una sincronización cada 10 min
    await enqueueJob(db, SYNC_TEMPLATES_JOB, {}, { dedupeKey: `sync_templates:${bucket}`, maxAttempts: 3 });
  }
  if (e.kind === "window_closed") {
    await db.from("events").insert({ type: "window.closed_by_meta", conversation_id: conversationId, data: { code: e.code } });
  }
}

// ---------------------------------------------------------------------
// Media saliente: Storage → subida a Meta (una sola vez; el id se cachea)
// ---------------------------------------------------------------------
async function resolveMedia(db: SupabaseClient, messageId: string, conversationId: string, content: OutboundContent): Promise<ResolvedMedia | undefined> {
  let ref: MediaRef | undefined;
  let kind: "image" | "document" | undefined;
  let filename: string | undefined;

  if (content.type === "image" || content.type === "document") {
    ref = content.media;
    kind = content.type;
    filename = content.type === "document" ? content.filename : undefined;
  } else if (content.type === "template" && content.header && content.header.type !== "text") {
    ref = content.header.media;
    kind = content.header.type;
    filename = content.header.type === "document" ? content.header.filename : undefined;
  }
  if (!ref || !kind) return undefined;
  if ("waMediaId" in ref) return { id: ref.waMediaId };
  if ("link" in ref) return { link: ref.link };

  // Reutilizar el id si ya se subió en un intento anterior (válido 30 días; usamos 25)
  const cached = (content as { _wa_media?: { id: string; at: string } })._wa_media;
  if (cached && Date.now() - new Date(cached.at).getTime() < 25 * 86_400_000) return { id: cached.id };

  const bucket = env().SUPABASE_MEDIA_BUCKET;
  const { data: blob, error } = await db.storage.from(bucket).download(ref.storagePath);
  if (error || !blob) throw new Error(`[storage] No se pudo leer ${ref.storagePath}: ${error?.message ?? "vacío"}`);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mimeType = blob.type || "application/octet-stream";

  const problem = checkOutboundMedia(kind, mimeType, bytes.length);
  if (problem) throw new SendRejectedError(problem);

  const name = filename ?? ref.storagePath.split("/").pop() ?? `archivo.${extensionFor(mimeType)}`;
  const mediaId = await uploadMedia(bytes, mimeType, name);

  await db.from("messages").update({ content: { ...content, _wa_media: { id: mediaId, at: new Date().toISOString() } }, media_id: mediaId }).eq("id", messageId);

  // Registrar el adjunto (aparece en el expediente junto a los del cliente)
  const { data: lead } = await db
    .from("leads")
    .select("id")
    .eq("conversation_id", conversationId)
    .not("status", "in", "(closed,lost)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  await db.from("attachments").upsert(
    {
      message_id: messageId,
      conversation_id: conversationId,
      lead_id: lead?.id ?? null,
      storage_bucket: bucket,
      storage_path: ref.storagePath,
      kind,
      mime_type: mimeType,
      size_bytes: bytes.length,
      original_filename: name,
      caption: "caption" in content ? (content.caption ?? null) : null,
    },
    { onConflict: "storage_bucket,storage_path" },
  );

  return { id: mediaId };
}

// ---------------------------------------------------------------------
// Utilidades de lectura
// ---------------------------------------------------------------------
async function findByClientRef(db: SupabaseClient, clientRef: string): Promise<OutboundMessage | null> {
  const { data } = await db.from("messages").select(MESSAGE_COLUMNS).eq("client_ref", clientRef).maybeSingle();
  return (data as OutboundMessage | null) ?? null;
}

async function getMessage(db: SupabaseClient, id: string): Promise<OutboundMessage | null> {
  const { data } = await db.from("messages").select(MESSAGE_COLUMNS).eq("id", id).maybeSingle();
  return (data as OutboundMessage | null) ?? null;
}

/** Estado de la ventana para la interfaz (y el agente). */
export async function getConversationWindow(db: SupabaseClient, conversationId: string): Promise<WindowState | null> {
  const { data } = await db.from("conversations").select("last_inbound_at").eq("id", conversationId).maybeSingle();
  return data ? windowState(data.last_inbound_at as string | null) : null;
}
