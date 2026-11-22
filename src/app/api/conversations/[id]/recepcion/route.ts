import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api/respond";
import { requireTeamMember } from "@/lib/auth/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { windowState } from "@/lib/whatsapp/window";
import { effectiveMode, recepcion, recepcionEnabled, refreshRecepcionInfo, REPLY_MODES, type ReplyMode } from "@/lib/integrations/recepcion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function load(id: string) {
  const { data } = await supabaseAdmin()
    .from("conversations")
    .select("id, status, last_inbound_at, reply_mode_override, recepcion_kind, recepcion_mode, recepcion_mode_source, recepcion_project_id, recepcion_project_code, recepcion_project_url, recepcion_staff_name, staff_project_code, staff_project_at, contact:contacts!inner(wa_id)")
    .eq("id", id)
    .maybeSingle();
  return data;
}

function view(c: NonNullable<Awaited<ReturnType<typeof load>>>) {
  return {
    enabled: recepcionEnabled(),
    kind: c.recepcion_kind,
    staffName: c.recepcion_staff_name,
    project: c.recepcion_project_id ? { id: c.recepcion_project_id, code: c.recepcion_project_code, url: c.recepcion_project_url } : null,
    staffProject: c.staff_project_code ? { code: c.staff_project_code, at: c.staff_project_at } : null,
    recepcionMode: c.recepcion_mode,
    recepcionModeSource: c.recepcion_mode_source,
    override: c.reply_mode_override,
    effective: effectiveMode(c),
    modes: REPLY_MODES,
  };
}

/** Qué sabe Recepción de este contacto (se refresca al abrir la ficha). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireTeamMember(req);
    const { id } = await ctx.params;
    let c = await load(id);
    if (!c) return NextResponse.json({ error: "La conversación no existe", code: "not_found" }, { status: 404 });
    if (recepcionEnabled()) {
      try {
        await refreshRecepcionInfo(supabaseAdmin(), id, (c.contact as unknown as { wa_id: string }).wa_id);
        c = (await load(id))!;
      } catch {
        // Recepción no disponible: se muestra lo último conocido
      }
    }
    return NextResponse.json(view(c));
  } catch (e) {
    return errorResponse(e);
  }
}

const patchSchema = z.object({ mode: z.enum(["solo_recibir", "borrador", "asistente", "solo_equipo"]).nullable() });

/**
 * Cambiar cómo se responde a este contacto por WhatsApp.
 * Con expediente: se guarda en el expediente (Recepción). Sin expediente: solo en esta conversación.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const me = await requireTeamMember(req);
    const { id } = await ctx.params;
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Modo no válido", code: "validation" }, { status: 400 });
    const db = supabaseAdmin();
    const c = await load(id);
    if (!c) return NextResponse.json({ error: "La conversación no existe", code: "not_found" }, { status: 404 });
    if (c.recepcion_kind === "personal") return NextResponse.json({ error: "Las conversaciones del personal de Wink no las atiende el asistente", code: "validation" }, { status: 400 });

    const mode = parsed.data.mode as ReplyMode | null;
    if (c.recepcion_project_id && recepcionEnabled()) {
      await recepcion.setMode(c.recepcion_project_id, mode, me.fullName ?? me.id);
      await db.from("conversations").update({ reply_mode_override: null }).eq("id", id);
      await refreshRecepcionInfo(db, id, (c.contact as unknown as { wa_id: string }).wa_id);
    } else {
      await db.from("conversations").update({ reply_mode_override: mode }).eq("id", id);
    }

    // El asistente se activa solo en modo «asistente»
    const updated = (await load(id))!;
    const eff = effectiveMode(updated);
    if (updated.status !== "closed") {
      if (eff === "asistente") {
        await db.from("conversations").update({ agent_active: true, status: "bot", handoff_reason: null }).eq("id", id);
        const { data: last } = await db.from("messages").select("direction").eq("conversation_id", id).neq("type", "reaction").order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (last?.direction === "inbound" && windowState(updated.last_inbound_at as string | null).open) await db.rpc("schedule_agent_run", { p_conversation_id: id, p_delay_seconds: 1 });
      } else {
        await db.from("conversations").update({ agent_active: false, status: "human", handoff_reason: `modo_${eff}` }).eq("id", id);
      }
    }
    await db.from("events").insert({ type: "reply_mode.changed", actor: `user:${me.id}`, conversation_id: id, data: { mode, effective: eff } });
    return NextResponse.json(view((await load(id))!));
  } catch (e) {
    return errorResponse(e);
  }
}
