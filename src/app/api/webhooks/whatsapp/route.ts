import { after, NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { runJobs } from "@/lib/jobs/runner";
import { log } from "@/lib/log";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ingestWebhook } from "@/lib/whatsapp/inbound/ingest";
import { isValidSignature, verifySubscription } from "@/lib/whatsapp/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // margen para el procesado en after()

/** Verificación del webhook al configurarlo en Meta. */
export async function GET(req: NextRequest) {
  const challenge = verifySubscription(req.nextUrl.searchParams, env().WHATSAPP_VERIFY_TOKEN);
  if (challenge === null) {
    log.warn("webhook.verify_failed");
    return new NextResponse("Forbidden", { status: 403 });
  }
  log.info("webhook.verified");
  return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

/** Notificaciones de Meta: validar firma → guardar → 200 → procesar en segundo plano. */
export async function POST(req: NextRequest) {
  const rawBody = await req.text(); // cuerpo exacto: imprescindible para la firma

  if (!isValidSignature(rawBody, req.headers.get("x-hub-signature-256"), env().WHATSAPP_APP_SECRET)) {
    log.warn("webhook.invalid_signature", { bytes: rawBody.length });
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.warn("webhook.invalid_json");
    return new NextResponse("Bad request", { status: 400 });
  }

  try {
    const { eventId } = await ingestWebhook(supabaseAdmin(), rawBody, payload);
    log.debug("webhook.queued", { eventId });
  } catch (e) {
    // Sin guardar no respondemos 200: Meta reintentará y no perdemos el mensaje.
    log.error("webhook.ingest_failed", { error: e });
    return new NextResponse("Temporary error", { status: 500 });
  }

  // Procesado inmediato tras responder. Si falla o se corta, el worker
  // programado (/api/jobs/run) lo recoge en el siguiente minuto.
  after(async () => {
    try {
      await runJobs({ maxJobs: 15, budgetMs: 45_000 });
    } catch (e) {
      log.error("webhook.after_run_failed", { error: e });
    }
  });

  return NextResponse.json({ ok: true });
}
