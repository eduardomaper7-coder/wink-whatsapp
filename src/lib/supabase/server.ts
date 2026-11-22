import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { supabaseAdmin } from "./admin";

/** Cliente de servidor con la sesión del usuario (componentes de servidor). */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env().NEXT_PUBLIC_SUPABASE_URL, env().NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const c of list) store.set(c.name, c.value, c.options);
        } catch {
          /* desde un componente de servidor no se pueden escribir cookies; el navegador refresca la sesión */
        }
      },
    },
  });
}

export interface SessionProfile {
  id: string;
  email: string | null;
  fullName: string;
  role: "admin" | "agent";
  active: boolean;
}

/** Usuario y perfil actuales (null si no hay sesión). */
export async function currentProfile(): Promise<SessionProfile | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const { data: p } = await supabaseAdmin().from("profiles").select("id, email, full_name, role, active").eq("id", data.user.id).maybeSingle();
  if (!p) return { id: data.user.id, email: data.user.email ?? null, fullName: "", role: "agent", active: false };
  return { id: p.id, email: p.email, fullName: p.full_name, role: p.role, active: p.active };
}
