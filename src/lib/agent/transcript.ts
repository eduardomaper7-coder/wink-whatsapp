import type { ClaudeMessage } from "@/lib/ai/anthropic";

/** Fila de messages tal como la carga el agente. */
export interface HistoryMessage {
  id: string;
  direction: "inbound" | "outbound";
  author: "customer" | "agent" | "human" | "system";
  type: string;
  content: Record<string, unknown>;
  text_preview: string | null;
  created_at: string;
  sender_name?: string | null; // nombre del miembro del equipo (author = human)
  attachment_id?: string | null;
  media_status?: string | null;
}

/** Texto que ve el agente para un mensaje del cliente. */
export function describeInbound(m: HistoryMessage): string | null {
  const c = m.content ?? {};
  switch (m.type) {
    case "text":
      return String(c.body ?? "");
    case "interactive":
      return `[Pulsó: "${String(c.title ?? "")}" (id: ${String(c.id ?? "")})]`;
    case "button":
      return `[Pulsó: "${String(c.text ?? "")}"]`;
    case "location": {
      const where = [c.name, c.address].filter(Boolean).join(", ");
      return `[Compartió una ubicación: ${where || "sin nombre"} (${c.latitude}, ${c.longitude})]`;
    }
    case "image":
    case "document":
    case "video":
    case "sticker": {
      const kind = { image: "una imagen", document: "un documento", video: "un vídeo", sticker: "un sticker" }[m.type as "image"];
      const parts = [`[Envió ${kind}`];
      if (c.filename) parts.push(`«${String(c.filename)}»`);
      if (m.attachment_id) parts.push(`(adjunto_id: ${m.attachment_id})`);
      else parts.push("(aún descargándose)");
      let s = parts.join(" ") + "]";
      if (c.caption) s += ` ${String(c.caption)}`;
      return s;
    }
    case "audio": {
      if (typeof c.transcript === "string" && c.transcript.trim()) return `[Nota de voz transcrita] ${c.transcript.trim()}`;
      return "[Envió una nota de voz que no se ha podido transcribir]";
    }
    case "reaction":
      return c.emoji ? `[Reaccionó con ${String(c.emoji)} a un mensaje]` : null;
    case "unsupported":
      return `[Mensaje no soportado: ${String(c.notice ?? "tipo desconocido")}]`;
    default:
      return m.text_preview;
  }
}

/** Texto que ve el agente para un mensaje saliente. */
export function describeOutbound(m: HistoryMessage): string {
  const text = m.text_preview ?? "";
  if (m.author === "human") return `[Mensaje de ${m.sender_name ?? "una persona"} (equipo Wink)] ${text}`;
  if (m.author === "system") return `[Mensaje automático] ${text}`;
  return text;
}

/**
 * Convierte el historial en mensajes para Claude:
 * cliente → user, salientes → assistant; une mensajes seguidos del mismo rol
 * y garantiza que empiece y termine en "user".
 */
export function buildTranscript(history: HistoryMessage[]): ClaudeMessage[] {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const m of history) {
    const role = m.direction === "inbound" ? "user" : "assistant";
    const text = m.direction === "inbound" ? describeInbound(m) : describeOutbound(m);
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.text += `\n${text}`;
    else out.push({ role, text });
  }
  if (out[0]?.role === "assistant") out.unshift({ role: "user", text: "[Inicio de la conversación]" });
  return out.map((m) => ({ role: m.role, content: m.text }));
}

/** ¿Hay mensajes del cliente pendientes de respuesta? (el último mensaje es suyo) */
export function hasPendingCustomerMessages(history: HistoryMessage[]): boolean {
  const relevant = history.filter((m) => !(m.direction === "inbound" && m.type === "reaction"));
  return relevant.at(-1)?.direction === "inbound";
}
