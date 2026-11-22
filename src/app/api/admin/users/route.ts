import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api/respond";
import { requireTeamMember } from "@/lib/auth/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Equipo: lista (admin). */
export async function GET(req: NextRequest) {
  try {
    await requireTeamMember(req, { admin: true });
    const { data, error } = await supabaseAdmin().from("profiles").select("id, full_name, email, role, active, created_at").order("created_at");
    if (error) throw new Error(error.message);
    return NextResponse.json({ users: data });
  } catch (e) {
    return errorResponse(e);
  }
}

const createSchema = z.object({
  email: z.string().email("Email no válido"),
  fullName: z.string().trim().min(1, "Indica el nombre").max(120),
  role: z.enum(["admin", "agent"]),
  password: z.string().min(8, "La contraseña necesita al menos 8 caracteres"),
});

/** Alta de un miembro del equipo (queda activo y con email confirmado). */
export async function POST(req: NextRequest) {
  try {
    const me = await requireTeamMember(req, { admin: true });
    const p = createSchema.safeParse(await req.json().catch(() => null));
    if (!p.success) return NextResponse.json({ error: p.error.issues.map((i) => i.message).join(" · "), code: "validation" }, { status: 400 });
    const { email, fullName, role, password } = p.data;
    const db = supabaseAdmin();
    const { data, error } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
      app_metadata: { role, active: true },
    });
    if (error) return NextResponse.json({ error: error.message, code: "auth" }, { status: 400 });
    // El trigger crea el perfil; nos aseguramos de los datos por si ya existía
    await db.from("profiles").upsert({ id: data.user.id, email, full_name: fullName, role, active: true });
    await db.from("events").insert({ type: "team.user_created", actor: `user:${me.id}`, data: { email, role } });
    return NextResponse.json({ id: data.user.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

const patchSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["admin", "agent"]).optional(),
  active: z.boolean().optional(),
  fullName: z.string().trim().min(1).max(120).optional(),
});

/** Cambiar rol, activar/desactivar o renombrar. */
export async function PATCH(req: NextRequest) {
  try {
    const me = await requireTeamMember(req, { admin: true });
    const p = patchSchema.safeParse(await req.json().catch(() => null));
    if (!p.success) return NextResponse.json({ error: "Datos no válidos", code: "validation" }, { status: 400 });
    const { id, role, active, fullName } = p.data;
    if (id === me.id && (active === false || role === "agent")) {
      return NextResponse.json({ error: "No puedes quitarte a ti mismo el acceso de administrador.", code: "validation" }, { status: 400 });
    }
    const patch = { ...(role ? { role } : {}), ...(active !== undefined ? { active } : {}), ...(fullName ? { full_name: fullName } : {}) };
    const { error } = await supabaseAdmin().from("profiles").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
