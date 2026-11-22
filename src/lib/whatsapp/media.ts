import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { toApiError } from "./errors";
import { graphFetch } from "./graph";

/**
 * Descarga de multimedia entrante (doc oficial "Media"):
 *   1) GET /{MEDIA_ID}?phone_number_id=… → { url, mime_type, sha256, file_size }
 *   2) GET {url} con el mismo Bearer token → binario
 * La URL caduca a los 5 minutos, por eso ambos pasos se hacen en el mismo trabajo.
 */
export interface MediaInfo {
  url: string;
  mime_type: string;
  sha256?: string;
  file_size?: number | string;
  id: string;
}

export async function getMediaInfo(mediaId: string): Promise<MediaInfo> {
  const phoneId = env().WHATSAPP_PHONE_NUMBER_ID;
  return graphFetch<MediaInfo>(`${encodeURIComponent(mediaId)}?phone_number_id=${phoneId}`);
}

export async function downloadMedia(mediaId: string): Promise<{ bytes: Buffer; mimeType: string; sha256Hex: string; info: MediaInfo }> {
  const info = await getMediaInfo(mediaId);
  const res = await fetch(info.url, {
    headers: { Authorization: `Bearer ${env().WHATSAPP_TOKEN}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw await toApiError(res);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha256Hex = createHash("sha256").update(bytes).digest("hex");
  return { bytes, mimeType: info.mime_type || res.headers.get("content-type") || "application/octet-stream", sha256Hex, info };
}

/**
 * Compara el hash calculado con el que manda Meta. Meta no deja claro si lo envía
 * en hex o en base64, así que aceptamos ambos. Si no coincide solo se avisa.
 */
export function sha256Matches(computedHex: string, given?: string): boolean | null {
  if (!given) return null;
  const g = given.trim();
  if (g.toLowerCase() === computedHex) return true;
  try {
    return Buffer.from(computedHex, "hex").toString("base64") === g;
  } catch {
    return false;
  }
}

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
};

export function extensionFor(mimeType: string, filename?: string | null): string {
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  if (EXT_BY_MIME[base]) return EXT_BY_MIME[base]!;
  const fromName = filename?.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return fromName ? fromName.toLowerCase() : "bin";
}

/** Ruta en Storage: {conversation}/{yyyy}/{mm}/{message}.{ext} (sin datos personales). */
export function storagePathFor(conversationId: string, messageId: string, at: Date, ext: string): string {
  const yyyy = at.getUTCFullYear();
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${conversationId}/${yyyy}/${mm}/${messageId}.${ext}`;
}
