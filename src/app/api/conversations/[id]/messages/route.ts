import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { requireTeamMember } from "@/lib/auth/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendMessage, WindowClosedError } from "@/lib/whatsapp/outbound/service";
import { listApprovedTemplates } from "@/lib/whatsapp/outbound/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Envía un mensaje desde la bandeja (una persona del equipo).
 * Cuerpo: { content: OutboundContent, clientRef?: string, replyTo?: wamid }
 * Al enviar, la conversación pasa a modo humano y el agente se pausa.
 * 409 window_closed → incluye las plantillas aprobadas para ofrecerlas.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const db = supabaseAdmin();
  try {
    const user = await requireTeamMember(req);
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { content?: unknown; clientRef?: string; replyTo?: string };

    const message = await sendMessage(db, {
      conversationId: id,
      content: body.content,
      author: "human",
      sentBy: user.id,
      clientRef: typeof body.clientRef === "string" ? body.clientRef.slice(0, 100) : null,
      replyToWaMessageId: typeof body.replyTo === "string" ? body.replyTo : null,
    });
    return NextResponse.json({ message }, { status: message.status === "failed" ? 422 : 201 });
  } catch (e) {
    if (e instanceof WindowClosedError) {
      const templates = await listApprovedTemplates(db).catch(() => []);
      return errorResponse(e, { templates });
    }
    return errorResponse(e);
  }
}
