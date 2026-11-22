import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api/respond";
import { requireTeamMember } from "@/lib/auth/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { windowState } from "@/lib/whatsapp/window";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause_agent") }),
  z.object({ action: z.literal("resume_agent") }),
  z.object({ action: z.literal("assign"), userId: z.string().uuid().nullable() }),
  z.object({ action: z.literal("read") }),
  z.object({ action: z.literal("close") }),
  z.object({ action: z.literal("reopen") }),
]);

/**
 * Acciones de la bandeja sobre una conversación:
 * pausar/reactivar el agente, asignar, marcar como leída, cerrar/reabrir.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const me = await requireTeamMember(req);
    const { id } = await ctx.params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Acción no válida", code: "validation" }, { status: 400 });
    const body = parsed.data;
    const db = supabaseAdmin();

    const { data: conv } = await db.from("conversations").select("id, status, agent_active, last_inbound_at").eq("id", id).maybeSingle();
    if (!conv) return NextResponse.json({ error: "La conversación no existe", code: "not_found" }, { status: 404 });

    const actor = `user:${me.id}`;
    let patch: Record<string, unknown> = {};
    let event: string | null = null;
    let eventData: Record<string, unknown> = {};

    switch (body.action) {
      case "pause_agent":
        patch = { agent_active: false, status: conv.status === "closed" ? "closed" : "human" };
        event = "agent.paused";
        eventData = { reason: "manual" };
        break;
      case "resume_agent":
        patch = { agent_active: true, status: "bot", handoff_reason: null, closed_at: null };
        event = "agent.resumed";
        break;
      case "assign":
        patch = { assigned_to: body.userId };
        event = "conversation.assigned";
        eventData = { to: body.userId };
        break;
      case "read":
        patch = { unread_count: 0 };
        break;
      case "close":
        patch = { status: "closed", closed_at: new Date().toISOString() };
        event = "conversation.closed";
        break;
      case "reopen":
        patch = { status: conv.agent_active ? "bot" : "human", closed_at: null };
        event = "conversation.reopened";
        break;
    }

    const { data: updated, error } = await db.from("conversations").update(patch).eq("id", id).select("id, status, agent_active, assigned_to, unread_count").single();
    if (error) throw new Error(error.message);
    if (event) await db.from("events").insert({ type: event, actor, conversation_id: id, data: eventData });

    // Al reactivar el agente, si el cliente está esperando respuesta, que conteste ya
    if (body.action === "resume_agent" && windowState(conv.last_inbound_at as string | null).open) {
      const { data: last } = await db.from("messages").select("direction").eq("conversation_id", id).neq("type", "reaction").order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (last?.direction === "inbound") await db.rpc("schedule_agent_run", { p_conversation_id: id, p_delay_seconds: 1 });
    }

    return NextResponse.json({ conversation: updated });
  } catch (e) {
    return errorResponse(e);
  }
}
