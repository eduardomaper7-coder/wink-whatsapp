"use client";
import { LogOut, MessageSquare, Settings, Radio } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext } from "react";
import type { SessionProfile } from "@/lib/supabase/server";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { NotificationsButton, NotificationsProvider } from "./Notifications";

const MeContext = createContext<SessionProfile | null>(null);
export const useMe = () => useContext(MeContext)!;

export function AppShell({ me, children }: { me: SessionProfile; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const logout = async () => {
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  };
  return (
    <MeContext.Provider value={me}>
      <NotificationsProvider>
      <div className="app">
        <nav className="rail" aria-label="Navegación">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="rail-logo" src="/icons/icon-192.png" alt="Wink" width={38} height={38} />
          <Link href="/inbox" aria-current={path.startsWith("/inbox") ? "page" : undefined} title="Conversaciones">
            <MessageSquare size={20} />
          </Link>
          <Link href="/live" target="_blank" title="Panel en directo (para proyectar)">
            <Radio size={20} />
          </Link>
          {me.role === "admin" && (
            <Link href="/ajustes" aria-current={path.startsWith("/ajustes") ? "page" : undefined} title="Ajustes">
              <Settings size={20} />
            </Link>
          )}
          <div className="spacer" />
          <NotificationsButton />
          <button onClick={logout} title={`Salir (${me.fullName || me.email})`}>
            <LogOut size={19} />
          </button>
        </nav>
        {children}
        {!/^\/inbox\/.+/.test(path) && (
          <nav className="mobile-tabs" aria-label="Navegación">
            <Link href="/inbox" aria-current={path.startsWith("/inbox") ? "page" : undefined}>
              <MessageSquare size={20} /> Mensajes
            </Link>
            <Link href="/live" target="_blank">
              <Radio size={20} /> Directo
            </Link>
            {me.role === "admin" && (
              <Link href="/ajustes" aria-current={path.startsWith("/ajustes") ? "page" : undefined}>
                <Settings size={20} /> Ajustes
              </Link>
            )}
            <NotificationsButton variant="tab" />
            <button onClick={logout}>
              <LogOut size={20} /> Salir
            </button>
          </nav>
        )}
      </div>
      </NotificationsProvider>
    </MeContext.Provider>
  );
}
