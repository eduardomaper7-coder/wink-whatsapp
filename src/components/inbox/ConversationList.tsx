"use client";
import { Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMe } from "@/components/ui/AppShell";
import { NotificationsBanner } from "@/components/ui/Notifications";
import { displayName, formatPhone, initials, listTime, windowLevel } from "./format";
import type { ConversationItem } from "./types";

type Filter = "all" | "bot" | "human" | "unread" | "mine" | "closed";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Todas" },
  { id: "human", label: "Equipo" },
  { id: "bot", label: "Asistente" },
  { id: "unread", label: "Sin leer" },
  { id: "mine", label: "Mías" },
  { id: "closed", label: "Cerradas" },
];

export function ConversationList({ items, selectedId }: { items: ConversationItem[] | null; selectedId: string | null }) {
  const me = useMe();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");

  const match = (c: ConversationItem, f: Filter) => {
    switch (f) {
      case "all":
        return c.status !== "closed";
      case "bot":
        return c.status === "bot";
      case "human":
        return c.status === "human";
      case "unread":
        return c.unread_count > 0;
      case "mine":
        return c.assigned_to === me.id && c.status !== "closed";
      case "closed":
        return c.status === "closed";
    }
  };

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, (items ?? []).filter((c) => match(c, f.id)).length])), [items]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    const n = (items ?? []).filter((c) => c.unread_count > 0 && c.status !== "closed").length;
    if (n > 0) void nav.setAppBadge?.(n).catch(() => {});
    else void nav.clearAppBadge?.().catch(() => {});
  }, [items]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/\s/g, "");
    return (items ?? []).filter((c) => {
      if (!match(c, filter)) return false;
      if (!needle) return true;
      const hay = `${c.contact.name ?? ""}${c.contact.profile_name ?? ""}${c.contact.wa_id}`.toLowerCase().replace(/\s/g, "");
      return hay.includes(needle);
    });
  }, [items, filter, q]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="list-head">
        <div className="list-title">
          <h1>Conversaciones</h1>
          {counts.human ? <span className="chip chip-ink">{counts.human} con el equipo</span> : null}
        </div>
        <div className="search">
          <Search size={16} />
          <input className="input" placeholder="Buscar por nombre o teléfono" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar" />
        </div>
        <div className="filters" role="toolbar" aria-label="Filtros">
          {FILTERS.map((f) => (
            <button key={f.id} className="filter" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
              {f.id !== "all" && counts[f.id] ? <span className="count">{counts[f.id]}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <NotificationsBanner />
      <div className="conv-list">
        {items === null && <div className="empty">Cargando…</div>}
        {items !== null && visible.length === 0 && <div className="empty">No hay conversaciones{filter !== "all" ? " con este filtro" : ""}.</div>}
        {visible.map((c) => {
          const name = displayName(c.contact);
          const win = windowLevel(c.last_inbound_at).level;
          return (
            <Link key={c.id} href={`/inbox/${c.id}`} className="conv" aria-current={c.id === selectedId ? "true" : undefined} prefetch={false}>
              <div className="avatar">{initials(name)}</div>
              <div className="conv-main">
                <div className="conv-top">
                  <span className="conv-name ellipsis" title={formatPhone(c.contact.wa_id)}>
                    {name}
                  </span>
                  <span className="conv-time">{listTime(c.last_message_at)}</span>
                </div>
                <div className="conv-bottom">
                  <span className={`win ${win}`} title={win === "closed" ? "Ventana de 24 h cerrada" : win === "soon" ? "La ventana de 24 h cierra pronto" : "Ventana de 24 h abierta"} />
                  <span className="conv-preview ellipsis">{c.last_message_preview ?? "—"}</span>
                  {c.status === "human" && <span className="mode-badge human">Equipo</span>}
                  {c.status === "closed" && <span className="mode-badge closed">Cerrada</span>}
                  {c.unread_count > 0 && <span className="unread">{c.unread_count}</span>}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
