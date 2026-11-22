import { redirect } from "next/navigation";
import { currentProfile } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Panel para proyectar: requiere sesión del equipo, pero sin la navegación de la bandeja. */
export default async function LiveLayout({ children }: { children: React.ReactNode }) {
  const me = await currentProfile();
  if (!me) redirect("/login?next=/live");
  if (!me.active) redirect("/login?e=inactive");
  return children;
}
