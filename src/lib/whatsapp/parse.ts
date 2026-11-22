import { describeErrorCode } from "./errors";
import type {
  MediaKind,
  NormalizedInbound,
  NormalizedStatus,
  TemplateStatusUpdate,
  WaInboundMessage,
  WaStatus,
  WebhookPayload,
  WebhookValue,
} from "./types";

const MEDIA_KINDS: MediaKind[] = ["image", "document", "audio", "video", "sticker"];
const KNOWN_STATUSES = new Set(["sent", "delivered", "read", "played", "failed"]);

const MEDIA_LABEL: Record<MediaKind, string> = {
  image: "📷 Imagen",
  document: "📄 Documento",
  audio: "🎤 Audio",
  video: "🎬 Vídeo",
  sticker: "Sticker",
};

function toDate(unixSeconds: string | undefined): Date {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

/** Extrae los bloques "messages" del payload (ignora otros campos suscritos). */
export function extractMessageValues(payload: WebhookPayload): WebhookValue[] {
  if (payload?.object !== "whatsapp_business_account") return [];
  const out: WebhookValue[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === "messages" && change.value) out.push(change.value);
    }
  }
  return out;
}

export function normalizeInbound(msg: WaInboundMessage, profileName?: string): NormalizedInbound {
  const base = {
    waMessageId: msg.id,
    from: msg.from,
    profileName,
    timestamp: toDate(msg.timestamp),
    replyToWaMessageId: msg.context?.id,
  };
  const extras: Record<string, unknown> = {};
  if (msg.referral) extras.referral = msg.referral; // anuncio de origen → útil para el lead
  if (msg.context?.forwarded) extras.forwarded = true;

  switch (msg.type) {
    case "text": {
      const body = msg.text?.body ?? "";
      return { ...base, type: "text", content: { body, ...extras }, textPreview: body };
    }

    case "image":
    case "document":
    case "audio":
    case "video":
    case "sticker": {
      const kind = msg.type as MediaKind;
      const m = msg[kind];
      if (!m?.id) return unsupported(base, msg, extras, `Mensaje de ${kind} sin id de media`);
      const content: Record<string, unknown> = {
        media_id: m.id,
        mime_type: m.mime_type ?? null,
        ...(m.caption ? { caption: m.caption } : {}),
        ...(m.filename ? { filename: m.filename } : {}),
        ...(kind === "audio" ? { voice: m.voice === true } : {}),
        ...extras,
      };
      const label = kind === "audio" && m.voice ? "🎤 Nota de voz" : MEDIA_LABEL[kind];
      const preview = m.caption ? `${label}: ${m.caption}` : m.filename ? `${label}: ${m.filename}` : label;
      return {
        ...base,
        type: kind,
        content,
        textPreview: preview,
        media: { id: m.id, kind, mimeType: m.mime_type, sha256: m.sha256, filename: m.filename, caption: m.caption, voice: m.voice },
      };
    }

    case "location": {
      const l = msg.location;
      if (!l) return unsupported(base, msg, extras, "Ubicación vacía");
      const content = { latitude: l.latitude, longitude: l.longitude, name: l.name ?? null, address: l.address ?? null, url: l.url ?? null, ...extras };
      const label = l.name || l.address || `${l.latitude.toFixed(5)}, ${l.longitude.toFixed(5)}`;
      return { ...base, type: "location", content, textPreview: `📍 ${label}` };
    }

    case "interactive": {
      const i = msg.interactive;
      if (i?.type === "button_reply" && i.button_reply) {
        return {
          ...base,
          type: "interactive",
          content: { kind: "button_reply", id: i.button_reply.id, title: i.button_reply.title, ...extras },
          textPreview: i.button_reply.title,
        };
      }
      if (i?.type === "list_reply" && i.list_reply) {
        return {
          ...base,
          type: "interactive",
          content: { kind: "list_reply", id: i.list_reply.id, title: i.list_reply.title, description: i.list_reply.description ?? null, ...extras },
          textPreview: i.list_reply.title,
        };
      }
      // nfm_reply (Flows), product, etc.: no soportados en este proyecto
      return unsupported(base, msg, extras, `Respuesta interactiva no soportada (${i?.type ?? "desconocida"})`);
    }

    // Botón de respuesta rápida de una PLANTILLA (y en algunos casos de botones de respuesta)
    case "button": {
      const text = msg.button?.text ?? msg.button?.payload ?? "";
      return {
        ...base,
        type: "button",
        content: { payload: msg.button?.payload ?? null, text, ...extras },
        textPreview: text,
      };
    }

    case "reaction": {
      const r = msg.reaction;
      if (!r?.message_id) return unsupported(base, msg, extras, "Reacción sin mensaje de referencia");
      const emoji = r.emoji ?? null; // sin emoji = el cliente quitó la reacción
      return {
        ...base,
        type: "reaction",
        content: { target_wa_message_id: r.message_id, emoji, ...extras },
        textPreview: emoji ? `Reaccionó ${emoji}` : "Quitó una reacción",
        reaction: { targetWaMessageId: r.message_id, emoji },
      };
    }

    case "unsupported": {
      const sub = msg.unsupported?.type;
      return unsupported(base, msg, extras, `Tipo de mensaje no soportado por WhatsApp Cloud API${sub ? ` (${sub})` : ""}`);
    }

    default:
      // contacts, order, system, request_welcome… → se guardan con aviso
      return unsupported(base, msg, extras, `Tipo de mensaje no soportado: ${msg.type}`);
  }
}

function unsupported(
  base: Pick<NormalizedInbound, "waMessageId" | "from" | "profileName" | "timestamp" | "replyToWaMessageId">,
  msg: WaInboundMessage,
  extras: Record<string, unknown>,
  notice: string,
): NormalizedInbound {
  const err = msg.errors?.[0];
  return {
    ...base,
    type: "unsupported",
    content: {
      original_type: msg.type,
      ...(msg.unsupported?.type ? { unsupported_type: msg.unsupported.type } : {}),
      ...(err ? { error: { code: err.code, title: err.title ?? err.message, details: err.error_data?.details } } : {}),
      notice,
      ...extras,
    },
    textPreview: `⚠️ ${notice}`,
    notice,
  };
}

export function normalizeStatus(s: WaStatus): NormalizedStatus | null {
  if (!KNOWN_STATUSES.has(s.status)) return null;
  const err = s.errors?.[0];
  return {
    waMessageId: s.id,
    status: s.status as NormalizedStatus["status"],
    timestamp: toDate(s.timestamp),
    recipient: s.recipient_id,
    ...(s.biz_opaque_callback_data ? { callbackRef: s.biz_opaque_callback_data } : {}),
    ...(err
      ? {
          error: {
            code: err.code,
            title: err.title ?? err.message,
            details: err.error_data?.details,
            kind: describeErrorCode(err.code).kind,
            message_es: describeErrorCode(err.code).es,
          },
        }
      : {}),
  };
}

/** Extrae los cambios de estado de plantillas (campo message_template_status_update). */
export function extractTemplateStatusUpdates(payload: WebhookPayload): TemplateStatusUpdate[] {
  if (payload?.object !== "whatsapp_business_account") return [];
  const out: TemplateStatusUpdate[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field === "message_template_status_update" && change.value) out.push(change.value as unknown as TemplateStatusUpdate);
    }
  }
  return out;
}

export { MEDIA_KINDS };
