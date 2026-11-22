import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendMessage, WindowClosedError } from "@/lib/whatsapp/outbound/service";
import { errorResponse } from "@/lib/api/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  text: z.string().min(1).max(4096),
  clientRef: z.string().min(1).max(100),
  approvedBy: z.string().nullish(),
});

function authorized(req: NextRequest): boolean {
  const secret = process.env.INTEGRATION_SECRET;
  if (!secret) return false;
  const got = Buffer.from((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Recepción del encargo envía por WhatsApp una respuesta ya APROBADA por un arquitecto.
 * Se registra como mensaje del equipo (pausa el asistente en esa conversación).
 * clientRef hace el envío idempotente (un reintento no duplica el mensaje).
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "No autorizado", code: "auth" }, { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Petición no válida", code: "validation" }, { status: 400 });
  const db = supabaseAdmin();
  try {
    const message = await sendMessage(db, {
      conversationId: parsed.data.conversationId,
      content: { type: "text", body: parsed.data.text },
      author: "human",
      sentBy: null,
      clientRef: `rcp:${parsed.data.clientRef}`,
    });
    await db.from("events").insert({
      type: "recepcion.sent",
      actor: "system",
      conversation_id: parsed.data.conversationId,
      message_id: message.id,
      data: { approved_in: "recepcion", approved_by: parsed.data.approvedBy ?? null },
    });
    if (message.status === "failed") return NextResponse.json({ error: "WhatsApp rechazó el mensaje", code: "failed", messageId: message.id }, { status: 422 });
    return NextResponse.json({ messageId: message.id, status: message.status });
  } catch (e) {
    if (e instanceof WindowClosedError) return NextResponse.json({ error: e.message, code: "window_closed" }, { status: 409 });
    return errorResponse(e);
  }
}
