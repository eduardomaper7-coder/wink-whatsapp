import { env } from "@/lib/env";
import { toApiError } from "./errors";

export const GRAPH_HOST = "https://graph.facebook.com";

export function graphUrl(path: string): string {
  const { WHATSAPP_GRAPH_VERSION } = env();
  return `${GRAPH_HOST}/${WHATSAPP_GRAPH_VERSION}/${path.replace(/^\//, "")}`;
}

/** Petición autenticada a la Graph API. Lanza WhatsAppApiError si no es 2xx. */
export async function graphFetch<T>(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(graphUrl(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${env().WHATSAPP_TOKEN}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}
