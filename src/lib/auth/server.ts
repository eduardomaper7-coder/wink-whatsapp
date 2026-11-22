import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface TeamMember {
  id: string;
  email: string | null;
  fullName: string;
  role: "admin" | "agent";
}

export class AuthError extends Error {
  constructor(message: string, readonly httpStatus: 401 | 403) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Identifica al miembro del equipo que hace la petición.
 *  - Navegador: cookies de sesión de Supabase Auth (bandeja web, fase 4).
 *  - Scripts/pruebas: cabecera "Authorization: Bearer <access_token de Supabase>".
 * Exige perfil activo; con role = "admin" si se pide.
 */
export async function requireTeamMember(req: NextRequest, opts: { admin?: boolean } = {}): Promise<TeamMember> {
  const admin = supabaseAdmin();
  let userId: string | null = null;

  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const { data } = await admin.auth.getUser(bearer);
    userId = data.user?.id ?? null;
  } else {
    const store = await cookies();
    const supabase = createServerClient(env().NEXT_PUBLIC_SUPABASE_URL, env().NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            for (const c of list) store.set(c.name, c.value, c.options);
          } catch {
            /* en rutas de solo lectura no se pueden escribir cookies */
          }
        },
      },
    });
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id ?? null;
  }

  if (!userId) throw new AuthError("No has iniciado sesión", 401);

  const { data: profile } = await admin.from("profiles").select("id, email, full_name, role, active").eq("id", userId).maybeSingle();
  if (!profile?.active) throw new AuthError("Tu usuario no está activo. Pide acceso a un administrador.", 403);
  if (opts.admin && profile.role !== "admin") throw new AuthError("Solo para administradores", 403);

  return { id: profile.id, email: profile.email, fullName: profile.full_name, role: profile.role };
}
