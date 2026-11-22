import type { SupabaseClient } from "@supabase/supabase-js";
import { log, scrubString } from "@/lib/log";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { handlers } from "./handlers";
import { backoffMs, PermanentJobError, RetryLaterError, type JobRow } from "./queue";

export interface RunResult {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
}

/**
 * Ejecuta trabajos pendientes hasta agotar la cola, el máximo o el tiempo disponible.
 * Seguro con varios workers a la vez (claim_jobs usa FOR UPDATE SKIP LOCKED).
 */
export async function runJobs(opts: { maxJobs?: number; budgetMs?: number; db?: SupabaseClient } = {}): Promise<RunResult> {
  const db = opts.db ?? supabaseAdmin();
  const maxJobs = opts.maxJobs ?? 25;
  const deadline = Date.now() + (opts.budgetMs ?? 25_000);
  const result: RunResult = { claimed: 0, done: 0, retried: 0, dead: 0 };

  while (result.claimed < maxJobs && Date.now() < deadline) {
    const { data, error } = await db.rpc("claim_jobs", { p_limit: Math.min(5, maxJobs - result.claimed) });
    if (error) throw new Error(`[db:claim_jobs] ${error.message}`);
    const jobs = (data ?? []) as JobRow[];
    if (jobs.length === 0) break;
    result.claimed += jobs.length;

    // Los trabajos de un mismo lote son independientes entre sí
    const outcomes = await Promise.all(jobs.map((job) => runOne(db, job)));
    for (const o of outcomes) result[o]++;
  }

  if (result.claimed > 0) log.info("jobs.run", { ...result });
  return result;
}

async function runOne(db: SupabaseClient, job: JobRow): Promise<"done" | "retried" | "dead"> {
  const handler = handlers[job.type];
  const started = Date.now();
  try {
    if (!handler) throw new PermanentJobError(`Tipo de trabajo desconocido: ${job.type}`);
    await handler.run(job.payload, { db });
    await db.from("jobs").update({ status: "done", locked_at: null, last_error: null }).eq("id", job.id);
    log.debug("job.done", { id: job.id, type: job.type, ms: Date.now() - started });
    return "done";
  } catch (e) {
    const message = scrubString(e instanceof Error ? e.message : String(e)).slice(0, 1000);
    const permanent = e instanceof PermanentJobError;
    const exhausted = job.attempts >= job.max_attempts;

    if (permanent || exhausted) {
      await db.from("jobs").update({ status: "dead", locked_at: null, last_error: message }).eq("id", job.id);
      log.error("job.dead", { id: job.id, type: job.type, attempts: job.attempts, error: message });
      try {
        await handler?.onDead?.(job.payload, { db }, message);
      } catch (hookErr) {
        log.error("job.on_dead_failed", { id: job.id, error: hookErr });
      }
      return "dead";
    }

    const wait = e instanceof RetryLaterError ? Math.max(e.ms, backoffMs(job.attempts)) : backoffMs(job.attempts);
    const runAfter = new Date(Date.now() + wait);
    await db
      .from("jobs")
      .update({ status: "queued", locked_at: null, last_error: message, run_after: runAfter.toISOString() })
      .eq("id", job.id);
    log.warn("job.retry", { id: job.id, type: job.type, attempts: job.attempts, next: runAfter.toISOString(), error: message });
    return "retried";
  }
}
