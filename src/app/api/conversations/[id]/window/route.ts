import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { requireTeamMember } from "@/lib/auth/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getConversationWindow } from "@/lib/whatsapp/outbound/service";
import { listApprovedTemplates } from "@/lib/whatsapp/outbound/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Estado de la ventana de 24 h y, si está cerrada, plantillas disponibles. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireTeamMember(req);
    const { id } = await ctx.params;
    const db = supabaseAdmin();
    const window = await getConversationWindow(db, id);
    if (!window) return NextResponse.json({ error: "La conversación no existe", code: "not_found" }, { status: 404 });
    const templates = window.open ? [] : await listApprovedTemplates(db);
    return NextResponse.json({ window, templates });
  } catch (e) {
    return errorResponse(e);
  }
}
