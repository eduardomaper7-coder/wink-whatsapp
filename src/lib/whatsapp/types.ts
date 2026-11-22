/**
 * Tipos del webhook "messages" de la WhatsApp Cloud API.
 * Basados en la referencia oficial (developers.facebook.com → WhatsApp → Webhooks → messages).
 * Se tipan de forma permisiva: Meta añade campos con frecuencia y no queremos romper por ello.
 */

export interface WebhookPayload {
  object: string; // "whatsapp_business_account"
  entry?: WebhookEntry[];
}

export interface WebhookEntry {
  id: string; // WABA ID
  changes?: WebhookChange[];
}

export interface WebhookChange {
  field: string; // "messages", "message_template_status_update", …
  value: WebhookValue;
}

export interface WebhookValue {
  messaging_product?: "whatsapp";
  metadata?: { display_phone_number: string; phone_number_id: string };
  contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
  messages?: WaInboundMessage[];
  statuses?: WaStatus[];
  errors?: WaError[];
}

export interface WaError {
  code: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
  href?: string;
}

export interface WaMediaObject {
  id: string;
  mime_type?: string;
  sha256?: string;
  url?: string;
  caption?: string;
  filename?: string; // documentos
  voice?: boolean; // audio: true si es nota de voz
  animated?: boolean; // stickers
}

export interface WaInboundMessage {
  from: string;
  id: string; // wamid.*
  timestamp: string; // unix (s)
  type: string;
  context?: { from?: string; id?: string; forwarded?: boolean; frequently_forwarded?: boolean };
  referral?: Record<string, unknown>; // anuncios click-to-WhatsApp
  errors?: WaError[];
  text?: { body: string };
  image?: WaMediaObject;
  document?: WaMediaObject;
  audio?: WaMediaObject;
  video?: WaMediaObject;
  sticker?: WaMediaObject;
  location?: { latitude: number; longitude: number; name?: string; address?: string; url?: string };
  interactive?: {
    type: "button_reply" | "list_reply" | string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { payload?: string; text?: string };
  reaction?: { message_id: string; emoji?: string };
  unsupported?: { type?: string };
  [key: string]: unknown;
}

export interface WaStatus {
  id: string; // wamid del mensaje saliente
  status: "sent" | "delivered" | "read" | "failed" | "played" | string;
  timestamp: string;
  recipient_id: string;
  errors?: WaError[];
  conversation?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  biz_opaque_callback_data?: string;
}

// ---------------------------------------------------------------------
// Forma normalizada (independiente de Meta) que guardamos en messages.content
// ---------------------------------------------------------------------

export type MessageType =
  | "text" | "image" | "document" | "audio" | "video" | "sticker" | "location"
  | "interactive" | "button" | "reaction" | "template" | "unsupported" | "system";

export type MediaKind = "image" | "document" | "audio" | "video" | "sticker";

export interface NormalizedInbound {
  waMessageId: string;
  from: string;
  profileName?: string;
  timestamp: Date;
  type: MessageType;
  /** Contenido normalizado; se guarda tal cual en messages.content (jsonb). */
  content: Record<string, unknown>;
  /** Texto plano para la lista de conversaciones, búsquedas y el agente. */
  textPreview: string | null;
  media?: { id: string; kind: MediaKind; mimeType?: string; sha256?: string; filename?: string; caption?: string; voice?: boolean };
  replyToWaMessageId?: string;
  reaction?: { targetWaMessageId: string; emoji: string | null };
  /** Para tipos no soportados: aviso visible en la bandeja. */
  notice?: string;
}

export interface NormalizedStatus {
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "played" | "failed";
  timestamp: Date;
  recipient: string;
  error?: { code: number; title?: string; details?: string; message_es?: string; kind?: string };
  /** Nuestro id interno devuelto por Meta (biz_opaque_callback_data). */
  callbackRef?: string;
}

/** Valor del webhook message_template_status_update. */
export interface TemplateStatusUpdate {
  event: string; // APPROVED, REJECTED, PAUSED, DISABLED, …
  message_template_id: number | string;
  message_template_name: string;
  message_template_language: string;
  reason?: string | null;
  message_template_category?: string;
  rejection_info?: { reason?: string; recommendation?: string };
  disable_info?: { disable_date?: string | number };
}
