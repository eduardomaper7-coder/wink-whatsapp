import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api/respond";
import { requireTeamMember } from "@/lib/auth/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const subSchema = z.object({
  endpoint: z.string().url().startsWith("https://"),
  keys: z.object({ p256dh: z.string().min(10), auth: z.string().min(5) }),
});

/** Guarda la suscripción push de este dispositivo para el usuario actual. */
export async function POST(req: NextRequest) {
  try {
    const me = await requireTeamMember(req);
    const p = subSchema.safeParse(await req.json().catch(() => null));
    if (!p.success) return NextResponse.json({ error: "Suscripción no válida", code: "validation" }, { status: 400 });
    const { error } = await supabaseAdmin()
      .from("push_subscriptions")
      .upsert(
        { user_id: me.id, endpoint: p.data.endpoint, p256dh: p.data.keys.p256dh, auth: p.data.keys.auth, user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null },
        { onConflict: "endpoint" },
      );
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Quita la suscripción de este dispositivo. */
export async function DELETE(req: NextRequest) {
  try {
    const me = await requireTeamMember(req);
    const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: string };
    if (endpoint) await supabaseAdmin().from("push_subscriptions").delete().eq("endpoint", endpoint).eq("user_id", me.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
