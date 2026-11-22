import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { runJobs } from "@/lib/jobs/runner";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Worker de la cola. Lo llaman:
 *  - Supabase pg_cron cada minuto (supabase/sql/schedule_worker.sql), y
 *  - Vercel Cron como respaldo (vercel.json).
 * Protegido con "Authorization: Bearer <CRON_SECRET>" (formato que usa Vercel Cron).
 */
function authorized(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${env().CRON_SECRET}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("Unauthorized", { status: 401 });
  try {
    const result = await runJobs({ maxJobs: 50, budgetMs: 50_000 });
    return NextResponse.json(result);
  } catch (e) {
    log.error("jobs.run_failed", { error: e });
    return NextResponse.json({ error: "run_failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
