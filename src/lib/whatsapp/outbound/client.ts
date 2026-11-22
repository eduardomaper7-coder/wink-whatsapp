import { env } from "@/lib/env";
import { AmbiguousSendError, toApiError, WhatsAppApiError } from "../errors";
import { graphUrl } from "../graph";

export interface SendResponse {
  messaging_product: "whatsapp";
  contacts?: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: string }>;
}

/**
 * POST /{phone-number-id}/messages.
 * La respuesta solo indica que Meta ACEPTÓ el envío; la entrega llega por webhook.
 * Distingue errores de Meta (WhatsAppApiError) de timeouts/red (AmbiguousSendError).
 */
export async function postMessage(payload: Record<string, unknown>, timeoutMs = 20_000): Promise<SendResponse> {
  // Ensayo sin Meta (chat de terminal, pruebas del agente): no envía nada
  if (process.env.WHATSAPP_DRY_RUN === "true") {
    return { messaging_product: "whatsapp", messages: [{ id: `wamid.DRYRUN${Date.now()}${Math.floor(Math.random() * 1e6)}` }] };
  }
  let res: Response;
  try {
    res = await fetch(graphUrl(`${env().WHATSAPP_PHONE_NUMBER_ID}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${env().WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AmbiguousSendError(e);
  }
  if (!res.ok) throw await toApiError(res);
  const json = (await res.json()) as SendResponse;
  if (!json.messages?.[0]?.id) throw new WhatsAppApiError("Respuesta sin id de mensaje", res.status);
  return json;
}

/**
 * Sube un archivo a Meta (POST /{phone-number-id}/media, multipart) y devuelve su id.
 * Meta recomienda enviar por id en lugar de por URL. Los ids duran 30 días.
 */
export async function uploadMedia(bytes: Uint8Array<ArrayBuffer>, mimeType: string, filename: string): Promise<string> {
  if (process.env.WHATSAPP_DRY_RUN === "true") return `${Date.now()}`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([bytes], { type: mimeType }), filename);

  let res: Response;
  try {
    res = await fetch(graphUrl(`${env().WHATSAPP_PHONE_NUMBER_ID}/media`), {
      method: "POST",
      headers: { Authorization: `Bearer ${env().WHATSAPP_TOKEN}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    // Subir dos veces no tiene efectos visibles para el cliente: se trata como reintentable
    throw new WhatsAppApiError(`Fallo de red subiendo media: ${e instanceof Error ? e.message : e}`, 503);
  }
  if (!res.ok) throw await toApiError(res);
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new WhatsAppApiError("Subida sin id de media", res.status);
  return json.id;
}

/**
 * Tipos y tamaños admitidos para ENVIAR. Tomados de la tabla "Supported media types"
 * de Meta (imágenes 5 MB, documentos 100 MB…). Si Meta cambia los límites, ajustar aquí.
 */
export const OUTBOUND_MEDIA_RULES = {
  image: { mimes: ["image/jpeg", "image/png"], maxBytes: 5 * 1024 * 1024 },
  document: {
    mimes: [
      "application/pdf",
      "text/plain",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    maxBytes: 100 * 1024 * 1024,
  },
} as const;

export function checkOutboundMedia(kind: "image" | "document", mimeType: string, size: number): string | null {
  const rule = OUTBOUND_MEDIA_RULES[kind];
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  if (!(rule.mimes as readonly string[]).includes(mime)) {
    return kind === "image"
      ? "WhatsApp solo admite imágenes JPG o PNG. Envíala como documento si es otro formato."
      : "Formato de documento no admitido por WhatsApp (usa PDF, Word, Excel, PowerPoint o TXT).";
  }
  if (size > rule.maxBytes) return `El archivo supera el máximo de ${Math.round(rule.maxBytes / 1024 / 1024)} MB para ${kind === "image" ? "imágenes" : "documentos"}.`;
  return null;
}
