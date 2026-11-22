import { redirect } from "next/navigation";
import { AppShell } from "@/components/ui/AppShell";
import { currentProfile } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Todo lo que hay bajo (app) exige sesión y usuario activo del equipo. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await currentProfile();
  if (!me) redirect("/login");
  if (!me.active) redirect("/login?e=inactive");
  return <AppShell me={me}>{children}</AppShell>;
}
