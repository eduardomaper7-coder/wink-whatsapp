import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueJob } from "@/lib/jobs/queue";
import { PUSH_JOB } from "./constants";
import { notifyTeam, unreadBadge, type PushPayload, type PushResult } from "./push";

/**
 * Qué se notifica y a quién (la decisión se toma en el trabajo push_notify,
 * fuera del webhook, para que este siga respondiendo en milisegundos):
 *  - message: mensaje del cliente en una conversación en modo humano
 *             → a la persona asignada (o a todo el equipo si no hay asignación)
 *  - handoff: el asistente deriva → a todo el equipo (urgente si lo es)
 *  - auth_error: WhatsApp sin token válido → a los administradores
 *  - test: prueba desde la bandeja → a quien la pide
 */
export type PushJob =
  | { kind: "message"; conversationId: string; messageId: string }
  | { kind: "handoff"; conversationId: string; categoria: string; resumen: string; urgente: boolean }
  | { kind: "auth_error"; message: string }
  | { kind: "test"; userId: string };

const HANDOFF_TITLE: Record<string, string> = {
  lo_pide_cliente: "quiere hablar con una persona",
  cliente_molesto: "está molesto",
  obra_en_curso: "tiene una obra en curso",
  proveedor: "es un proveedor",
  urgencia: "tiene una urgencia",
  duda: "necesita a alguien del equipo",
  error: "necesita a alguien del equipo",
  otro: "necesita a alguien del equipo",
};

export async function enqueuePush(db: SupabaseClient, job: PushJob, dedupeKey?: string) {
  await enqueueJob(db, PUSH_JOB, job as unknown as Record<string, unknown>, { dedupeKey, maxAttempts: 3 });
}

async function contactName(db: SupabaseClient, conversationId: string) {
  const { data } = await db.from("conversations").select("status, assigned_to, contact:contacts!inner(name, profile_name, wa_id)").eq("id", conversationId).maybeSingle();
  const c = data?.contact as unknown as { name: string | null; profile_name: string | null; wa_id: string } | undefined;
  return { conv: data, name: c?.name || c?.profile_name || `+${c?.wa_id ?? ""}` };
}

export async function runPushJob(db: SupabaseClient, job: PushJob): Promise<PushResult> {
  switch (job.kind) {
    case "message": {
      const { conv, name } = await contactName(db, job.conversationId);
      // Si entretanto la conversación volvió al asistente, no hace falta avisar
      if (!conv || conv.status !== "human") return { recipients: 0, sent: 0, removed: 0, skipped: "no está en modo humano" };
      const { data: msg } = await db.from("messages").select("text_preview").eq("id", job.messageId).maybeSingle();
      const payload: PushPayload = {
        title: name,
        body: msg?.text_preview ?? "Nuevo mensaje",
        url: `/inbox/${job.conversationId}`,
        tag: `conv:${job.conversationId}`,
        badge: await unreadBadge(db),
      };
      return notifyTeam(db, payload, conv.assigned_to ? { userIds: [conv.assigned_to as string] } : {});
    }
    case "handoff": {
      const { name } = await contactName(db, job.conversationId);
      return notifyTeam(db, {
        title: `${job.urgente ? "Urgente · " : ""}${name} ${HANDOFF_TITLE[job.categoria] ?? HANDOFF_TITLE.otro}`,
        body: job.resumen || "El asistente ha pasado la conversación al equipo.",
        url: `/inbox/${job.conversationId}`,
        tag: `conv:${job.conversationId}`,
        urgent: job.urgente,
        badge: await unreadBadge(db),
      });
    }
    case "auth_error":
      return notifyTeam(db, { title: "WhatsApp: hay que revisar la conexión", body: job.message, url: "/ajustes", tag: "auth_error", urgent: true }, { adminsOnly: true });
    case "test":
      return notifyTeam(db, { title: "Notificaciones activadas", body: "Así te avisaremos cuando un cliente necesite al equipo.", url: "/inbox", tag: "test" }, { userIds: [job.userId] });
  }
}
