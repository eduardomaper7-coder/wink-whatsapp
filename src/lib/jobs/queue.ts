import type { SupabaseClient } from "@supabase/supabase-js";
import type { EnqueueOptions } from "@/lib/whatsapp/inbound/store";

export interface JobRow {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  run_after: string;
  last_error: string | null;
  dedupe_key: string | null;
}

/** Encola un trabajo. Con dedupeKey, encolar dos veces lo mismo no duplica. */
export async function enqueueJob(
  db: SupabaseClient,
  type: string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<void> {
  const row = {
    type,
    payload,
    dedupe_key: opts.dedupeKey ?? null,
    run_after: (opts.runAfter ?? new Date()).toISOString(),
    ...(opts.maxAttempts ? { max_attempts: opts.maxAttempts } : {}),
  };
  const query = opts.dedupeKey
    ? db.from("jobs").upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: true })
    : db.from("jobs").insert(row);
  const { error } = await query;
  if (error) throw new Error(`[db:enqueueJob] ${error.message}`);
}

/** Reintento exponencial con jitter: 15 s, 30 s, 1 min, 2 min… hasta 1 h. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(15_000 * 2 ** Math.max(0, attempt - 1), 60 * 60_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

/** Reintentar no antes de `ms` (p. ej. límites de envío de WhatsApp). */
export class RetryLaterError extends Error {
  constructor(message: string, readonly ms: number) {
    super(message);
    this.name = "RetryLaterError";
  }
}

/** Error que no tiene sentido reintentar (el trabajo pasa a "dead" directamente). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
