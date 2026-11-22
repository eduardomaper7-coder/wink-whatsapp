"use client";
import { ArrowLeft, Bot, CheckCircle2, IdCard, MoreVertical, PauseCircle, PlayCircle, RotateCcw, UserPlus } from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMe } from "@/components/ui/AppShell";
import { Composer } from "./Composer";
import { dayLabel, displayName, formatPhone, HANDOFF_LABEL, initials, sameDay, timeOnly, windowLevel } from "./format";
import { api, useMessages } from "./hooks";
import { MessageBubble } from "./MessageBubble";
import type { ConversationItem, EventItem, TeamMember } from "./types";

const EVENT_NOTE: Record<string, (e: EventItem, team: TeamMember[]) => string> = {
  "agent.handoff": (e) => `El asistente ha pasado la conversación al equipo · ${HANDOFF_LABEL[String(e.data.categoria)] ?? ""}`,
  "agent.paused": (e, team) => (e.data.reason === "human_reply" ? `${who(e, team)} ha tomado la conversación · asistente en pausa` : `${who(e, team)} ha pausado el asistente`),
  "visit.booked": () => "Visita técnica reservada",
  "conversation.closed": () => "Conversación cerrada",
};
function who(e: EventItem, team: TeamMember[]) {
  const id = e.actor.startsWith("user:") ? e.actor.slice(5) : null;
  return team.find((t) => t.id === id)?.full_name ?? "Una persona del equipo";
}

export function ConversationView({
  conv,
  team,
  events,
  onShowLead,
  toast,
}: {
  conv: ConversationItem;
  team: TeamMember[];
  events: EventItem[];
  onShowLead: () => void;
  toast: (m: string) => void;
}) {
  const me = useMe();
  const { messages, attachments, reload } = useMessages(conv.id);
  const [menu, setMenu] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const userScrollAt = useRef(0); // última interacción real del usuario con el scroll
  const name = displayName(conv.contact);
  const win = windowLevel(conv.last_inbound_at).level;

  // Marcar como leída al abrir o cuando llegan mensajes mientras está abierta
  useEffect(() => {
    if (conv.unread_count > 0) void api(`/api/conversations/${conv.id}`, { method: "PATCH", body: { action: "read" } });
  }, [conv.id, conv.unread_count]);

  // Mantener el scroll abajo salvo que el usuario haya subido a leer
  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, attachments]);
  useEffect(() => {
    stick.current = true;
  }, [conv.id]);
  useEffect(() => {
    const el = body.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const inner = el.firstElementChild ?? el;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [conv.id]);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setMenu(false);
    const r = await api(`/api/conversations/${conv.id}`, { method: "PATCH", body: { action, ...extra } });
    if (!r.ok) toast(r.data.error ?? "No se pudo completar la acción");
  }

  // Línea de tiempo: mensajes + notas de sistema (derivaciones, pausas…)
  const timeline: Array<{ at: string; kind: "msg" | "note"; id: string; node: React.ReactNode }> = [];
  (messages ?? []).forEach((m, i) => {
    if (m.type === "reaction") return;
    const prev = messages![i - 1];
    const grouped = !!prev && prev.direction === m.direction && prev.author === m.author && prev.sent_by === m.sent_by && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
    timeline.push({ at: m.created_at, kind: "msg", id: m.id, node: <MessageBubble m={m} att={attachments[m.id]} team={team} grouped={grouped} onOpenImage={setLightbox} /> });
  });
  for (const e of events) {
    const f = EVENT_NOTE[e.type];
    if (f) timeline.push({ at: e.created_at, kind: "note", id: `e${e.id}`, node: <div className="sys-note"><span>{f(e, team)} · {timeOnly(e.created_at)}</span></div> });
  }
  timeline.sort((a, b) => a.at.localeCompare(b.at));

  return (
    <section className="pane chat-pane" aria-label={`Conversación con ${name}`}>
      <header className="chat-head">
        <Link href="/inbox" className="btn btn-ghost btn-icon only-mobile" aria-label="Volver">
          <ArrowLeft size={20} />
        </Link>
        <div className="avatar sm">{initials(name)}</div>
        <div className="who">
          <b className="ellipsis">{name}</b>
          <span className="xs muted">
            {formatPhone(conv.contact.wa_id)} · {win === "closed" ? "ventana cerrada" : win === "soon" ? "ventana a punto de cerrar" : "ventana abierta"}
          </span>
        </div>
        {conv.status === "bot" ? (
          <span className="chip mode-chip">
            <Bot size={13} /> Asistente
          </span>
        ) : conv.status === "human" ? (
          <span className="chip chip-ink mode-chip">Equipo</span>
        ) : (
          <span className="chip mode-chip">Cerrada</span>
        )}
        <button className="btn btn-ghost btn-icon only-narrow" onClick={onShowLead} aria-label="Ver ficha" title="Ficha del cliente">
          <IdCard size={19} />
        </button>
        <div style={{ position: "relative" }}>
          <button className="btn btn-ghost btn-icon" onClick={() => setMenu((v) => !v)} aria-label="Más acciones" aria-expanded={menu}>
            <MoreVertical size={19} />
          </button>
          {menu && (
            <div className="menu" role="menu">
              {conv.agent_active ? (
                <button role="menuitem" onClick={() => void act("pause_agent")}>
                  <PauseCircle size={16} /> Pausar el asistente
                </button>
              ) : (
                <button role="menuitem" onClick={() => void act("resume_agent")}>
                  <PlayCircle size={16} /> Reactivar el asistente
                </button>
              )}
              {conv.assigned_to !== me.id && (
                <button role="menuitem" onClick={() => void act("assign", { userId: me.id })}>
                  <UserPlus size={16} /> Asignármela
                </button>
              )}
              {team
                .filter((t) => t.id !== me.id && t.id !== conv.assigned_to)
                .map((t) => (
                  <button key={t.id} role="menuitem" onClick={() => void act("assign", { userId: t.id })}>
                    <UserPlus size={16} /> Asignar a {t.full_name}
                  </button>
                ))}
              {conv.assigned_to && (
                <button role="menuitem" onClick={() => void act("assign", { userId: null })}>
                  <UserPlus size={16} /> Quitar asignación
                </button>
              )}
              {conv.status === "closed" ? (
                <button role="menuitem" onClick={() => void act("reopen")}>
                  <RotateCcw size={16} /> Reabrir
                </button>
              ) : (
                <button role="menuitem" onClick={() => void act("close")}>
                  <CheckCircle2 size={16} /> Cerrar conversación
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      <div
        className="chat-body"
        ref={body}
        onWheel={() => (userScrollAt.current = Date.now())}
        onTouchMove={() => (userScrollAt.current = Date.now())}
        onKeyDown={() => (userScrollAt.current = Date.now())}
        onScroll={(e) => {
          const el = e.currentTarget;
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          // Solo deja de seguir el final si el usuario ha subido a propósito (no por cargas de imágenes)
          if (nearBottom) stick.current = true;
          else if (Date.now() - userScrollAt.current < 1000) stick.current = false;
        }}
      >
        <div>
        {messages === null && <div className="empty">Cargando mensajes…</div>}
        {timeline.map((t, i) => (
          <Fragment key={t.id}>
            {(i === 0 || !sameDay(timeline[i - 1]!.at, t.at)) && (
              <div className="day-sep">
                <span>{dayLabel(t.at)}</span>
              </div>
            )}
            {t.node}
          </Fragment>
        ))}
        </div>
      </div>

      <Composer conv={conv} onSent={() => void reload()} toast={toast} />

      {lightbox && (
        <div className="overlay" onClick={() => setLightbox(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="" className="lightbox" />
        </div>
      )}
    </section>
  );
}
