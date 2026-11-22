import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { requireTeamMember } from "@/lib/auth/server";
import { pushConfigured } from "@/lib/notify/push";
import { runPushJob } from "@/lib/notify/triggers";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Envía una notificación de prueba a los dispositivos del usuario actual. */
export async function POST(req: NextRequest) {
  try {
    const me = await requireTeamMember(req);
    if (!pushConfigured()) return NextResponse.json({ error: "Faltan las claves VAPID en el servidor.", code: "not_configured" }, { status: 503 });
    const r = await runPushJob(supabaseAdmin(), { kind: "test", userId: me.id });
    return NextResponse.json(r);
  } catch (e) {
    return errorResponse(e);
  }
}
