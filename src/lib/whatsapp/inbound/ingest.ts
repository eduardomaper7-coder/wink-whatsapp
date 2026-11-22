import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueJob } from "@/lib/jobs/queue";
import { JOB } from "./process";

/**
 * Guarda el webhook crudo y encola su procesado. Es lo único que se hace
 * antes de responder 200 a Meta, para contestar en milisegundos.
 *
 * Idempotencia (capa 1): Meta reintenta con el mismo cuerpo → mismo sha256 →
 * misma fila y mismo trabajo (dedupe_key). Si un intento anterior guardó el
 * evento pero falló al encolar, el reintento lo completa.
 * (Capa 2: messages.wa_message_id es único.)
 */
export async function ingestWebhook(db: SupabaseClient, rawBody: string, payload: unknown): Promise<{ eventId: number }> {
  const bodySha = createHash("sha256").update(rawBody).digest("hex");

  const { data, error } = await db
    .from("wa_webhook_events")
    .upsert({ body_sha256: bodySha, payload }, { onConflict: "body_sha256" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`[db:wa_webhook_events] ${error?.message ?? "sin datos"}`);

  const eventId = Number(data.id);
  await enqueueJob(db, JOB.PROCESS_WEBHOOK, { eventId }, { dedupeKey: `webhook:${eventId}`, maxAttempts: 10 });
  return { eventId };
}
