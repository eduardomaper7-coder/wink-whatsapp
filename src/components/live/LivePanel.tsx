"use client";
/* eslint-disable @next/next/no-img-element */
import { Bot, CalendarCheck, FileText, Maximize2, Mic, Pin, PinOff, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayName, formatPhone, HANDOFF_LABEL, PROJECT_LABEL, timeOnly, visitParts } from "@/components/inbox/format";
import { useConversations, useLead, useMessages, useSignedUrl, useTeam } from "@/components/inbox/hooks";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import type { Attachment, Lead } from "@/components/inbox/types";
import { supabaseBrowser } from "@/lib/supabase/browser";

// ---------------------------------------------------------------- actividad del agente
interface Activity {
  id: number;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

const FIELD_ES: Record<string, string> = {
  full_name: "nombre",
  project_type: "tipo de proyecto",
  project_type_other: "detalle del proyecto",
  address: "dirección",
  surface_m2: "superficie",
  property_state: "estado de la vivienda",
  goals: "objetivos",
  budget_range: "presupuesto",
  desired_timeline: "plazos",
  contact_preference: "preferencia de contacto",
  contact_preference_notes: "detalle de contacto",
  contact_email: "email",
};

function describe(a: Activity): { icon: React.ReactNode; text: string } | null {
  const d = a.data;
  switch (a.type) {
    case "lead.created":
      return { icon: <Sparkles size={18} />, text: "Nuevo expediente abierto" };
    case "lead.updated": {
      const f = (d.fields as string[] | undefined)?.map((x) => FIELD_ES[x] ?? x) ?? [];
      return { icon: <UserRound size={18} />, text: `Ficha actualizada: ${f.join(", ")}` };
    }
    case "lead.document":
      return { icon: <FileText size={18} />, text: `Documentación registrada: ${String(d.descripcion ?? "")}` };
    case "media.transcribed":
      return { icon: <Mic size={18} />, text: "Nota de voz transcrita" };
    case "visit.booked":
      return { icon: <CalendarCheck size={18} />, text: d.calendar === "google" ? "Visita técnica reservada en Google Calendar" : "Visita técnica reservada en la agenda" };
    case "briefing.generated":
      return { icon: <Sparkles size={18} />, text: "Briefing redactado para el arquitecto" };
    case "briefing.emailed":
      return { icon: <FileText size={18} />, text: "Briefing enviado por email al arquitecto" };
    case "agent.handoff":
      return { icon: <UserRound size={18} />, text: `Derivada al equipo · ${HANDOFF_LABEL[String(d.categoria)] ?? ""}` };
    case "agent.guardrail":
      return { icon: <ShieldCheck size={18} />, text: "Salvaguarda: no da precios; lo valorará el arquitecto" };
    default:
      return null;
  }
}

function useActivity(conversationId: string | null) {
  const [items, setItems] = useState<Activity[]>([]);
  const load = useCallback(async () => {
    if (!conversationId) return;
    const { data } = await supabaseBrowser()
      .from("events")
      .select("id, type, data, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(30);
    setItems(((data as Activity[] | null) ?? []).filter((a) => describe(a)).slice(0, 6));
  }, [conversationId]);
  useEffect(() => {
    setItems([]);
    void load();
    if (!conversationId) return;
    const sb = supabaseBrowser();
    const ch = sb
      .channel(`live-activity:${conversationId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `conversation_id=eq.${conversationId}` }, () => void load())
      .subscribe();
    const poll = setInterval(() => void load(), 3000); // respaldo si no hay tiempo real
    return () => {
      clearInterval(poll);
      void sb.removeChannel(ch);
    };
  }, [conversationId, load]);
  return items;
}

// ---------------------------------------------------------------- expediente
const FIELDS: Array<{ key: keyof Lead; label: string; render?: (l: Lead) => string | null }> = [
  { key: "full_name", label: "Nombre" },
  { key: "project_type", label: "Proyecto", render: (l) => (l.project_type ? (PROJECT_LABEL[l.project_type] ?? l.project_type) + (l.project_type_other ? ` · ${l.project_type_other}` : "") : null) },
  { key: "address", label: "Vivienda" },
  { key: "surface_m2", label: "Superficie", render: (l) => (l.surface_m2 ? `${Number(l.surface_m2).toLocaleString("es-ES")} m²` : null) },
  { key: "property_state", label: "Estado actual" },
  { key: "goals", label: "Quiere conseguir" },
  { key: "budget_range", label: "Presupuesto" },
  { key: "desired_timeline", label: "Plazos" },
  { key: "contact_preference", label: "Contacto", render: (l) => (l.contact_preference ? ({ whatsapp: "WhatsApp", llamada: "Llamada", email: "Email" }[l.contact_preference] ?? l.contact_preference) + (l.contact_preference_notes ? ` · ${l.contact_preference_notes}` : "") : null) },
];

function Ring({ value, total }: { value: number; total: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <svg width="86" height="86" viewBox="0 0 86 86" aria-label={`${value} de ${total}`}>
      <circle cx="43" cy="43" r={r} fill="none" stroke="var(--line)" strokeWidth="7" />
      <circle cx="43" cy="43" r={r} fill="none" stroke="var(--ink)" strokeWidth="7" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value / total)} transform="rotate(-90 43 43)" style={{ transition: "stroke-dashoffset .6s ease" }} />
      <text x="43" y="49" textAnchor="middle" fontSize="20" fontWeight="600" fill="var(--ink)">
        {value}/{total}
      </text>
    </svg>
  );
}

function Thumb({ a }: { a: Attachment }) {
  const url = useSignedUrl(a.storage_bucket, a.storage_path);
  return a.kind === "image" && url ? (
    <img src={url} alt={a.description ?? ""} className="live-thumb" />
  ) : (
    <div className="live-thumb live-thumb-doc">
      <FileText size={26} />
      <span>{a.original_filename ?? a.description ?? a.kind}</span>
    </div>
  );
}

function Expediente({ lead, docs, name, phone }: { lead: Lead | null; docs: Attachment[]; name: string; phone: string }) {
  const prev = useRef<Lead | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (lead && prev.current?.id === lead.id) {
      const changed = FIELDS.filter((f) => prev.current![f.key] !== lead[f.key]).map((f) => f.key as string);
      if (changed.length) {
        setFresh(new Set(changed));
        const t = setTimeout(() => setFresh(new Set()), 2600);
        prev.current = lead;
        return () => clearTimeout(t);
      }
    }
    prev.current = lead;
  }, [lead]);

  const filled = lead ? FIELDS.filter((f) => (f.render ? f.render(lead) : lead[f.key])).length : 0;
  const v = lead?.visit_at ? visitParts(lead.visit_at) : null;

  return (
    <section className="live-card live-exp" aria-label="Expediente">
      <div className="live-exp-head">
        <div className="grow">
          <p className="live-kicker">Expediente</p>
          <h2>{lead?.full_name || name}</h2>
          <p className="muted">{phone}</p>
        </div>
        <Ring value={filled} total={FIELDS.length} />
      </div>

      <dl className="live-fields">
        {FIELDS.map((f) => {
          const value = lead ? (f.render ? f.render(lead) : (lead[f.key] as string | null)) : null;
          return (
            <div key={f.key} className={`live-field ${value ? "is-filled" : ""} ${fresh.has(f.key as string) ? "is-fresh" : ""}`}>
              <dt>{f.label}</dt>
              <dd>{value || "—"}</dd>
            </div>
          );
        })}
      </dl>

      {docs.length > 0 && (
        <div className="live-docs">
          {docs.slice(0, 4).map((d) => (
            <Thumb key={d.id} a={d} />
          ))}
        </div>
      )}

      {v && (
        <div className="live-visit">
          <CalendarCheck size={26} />
          <div className="grow">
            <b>Visita técnica reservada</b>
            <span>
              {v.long} · {lead?.address}
            </span>
          </div>
        </div>
      )}
      {lead?.briefing_md && (
        <div className="live-briefing">
          <Sparkles size={20} /> Briefing listo{lead.briefing_sent_at ? " y enviado al arquitecto" : ""}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- panel
export function LivePanel({ qrSvg, waNumber }: { qrSvg: string | null; waNumber: string | null }) {
  const { items } = useConversations();
  const team = useTeam();
  const [pinned, setPinned] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("c");
    if (c) setPinned(c);
  }, []);

  // Sigue a la conversación en la que el cliente ha escrito más recientemente
  const latest = useMemo(
    () => [...(items ?? [])].filter((c) => c.last_inbound_at).sort((a, b) => b.last_inbound_at!.localeCompare(a.last_inbound_at!))[0] ?? null,
    [items],
  );
  const conv = (pinned && items?.find((c) => c.id === pinned)) || latest;
  const { messages, attachments } = useMessages(conv?.id ?? null);
  const { lead, docs } = useLead(conv?.id ?? null);
  const activity = useActivity(conv?.id ?? null);

  const chat = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chat.current;
    if (!el) return;
    const ro = new ResizeObserver(() => (el.scrollTop = el.scrollHeight));
    ro.observe(el.firstElementChild ?? el);
    el.scrollTop = el.scrollHeight;
    return () => ro.disconnect();
  }, [conv?.id, messages?.length]);

  const visible = (messages ?? []).filter((m) => m.type !== "reaction").slice(-14);
  const last = visible.at(-1);
  const typing = !!conv && conv.status === "bot" && conv.agent_active && last?.direction === "inbound" && now - new Date(last.created_at).getTime() < 120_000;
  const name = conv ? displayName(conv.contact) : "";

  return (
    <main className="live">
      <header className="live-head">
        <img src="/brand/wink-logo.png" alt="Wink" className="live-logo" />
        <div className="live-title">
          <span className="live-dot" /> Asistente de WhatsApp · en directo
        </div>
        <div className="grow" />
        <button className="btn btn-sm" onClick={() => setPinned(pinned ? null : (conv?.id ?? null))} title={pinned ? "Volver a seguir al último cliente" : "Fijar esta conversación"}>
          {pinned ? <PinOff size={15} /> : <Pin size={15} />} {pinned ? "Fijada" : "Siguiendo al último cliente"}
        </button>
        <button className="btn btn-sm btn-icon" onClick={() => void document.documentElement.requestFullscreen?.()} aria-label="Pantalla completa">
          <Maximize2 size={15} />
        </button>
      </header>

      {!conv ? (
        <div className="live-empty">
          {qrSvg && <div className="live-qr-big" dangerouslySetInnerHTML={{ __html: qrSvg }} />}
          <h1 className="serif">Escribe a Wink por WhatsApp</h1>
          <p className="muted">{waNumber ? `+${waNumber}` : "La conversación aparecerá aquí en cuanto llegue el primer mensaje."}</p>
        </div>
      ) : (
        <div className="live-grid">
          <section className="live-card live-chat" aria-label={`Conversación con ${name}`}>
            <div className="live-chat-head">
              <div className="avatar">{name.slice(0, 1)}</div>
              <div className="grow">
                <b>{name}</b>
                <span className="muted">{formatPhone(conv.contact.wa_id)}</span>
              </div>
              {conv.status === "bot" ? (
                <span className="chip">
                  <Bot size={14} /> Asistente IA
                </span>
              ) : (
                <span className="chip chip-ink">Equipo de Wink</span>
              )}
            </div>
            <div className="live-chat-body chat-body" ref={chat}>
              <div>
                {visible.map((m, i) => (
                  <MessageBubble key={m.id} m={m} att={attachments[m.id]} team={team} grouped={i > 0 && visible[i - 1]!.direction === m.direction && visible[i - 1]!.author === m.author} onOpenImage={() => {}} />
                ))}
                {typing && (
                  <div className="msg out agent">
                    <div className="bubble live-typing" aria-label="El asistente está escribiendo">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <div className="live-side">
            <Expediente lead={lead} docs={docs} name={name} phone={formatPhone(conv.contact.wa_id)} />
            {qrSvg && (
              <div className="live-card live-qr">
                <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
                <div>
                  <b>Pruébalo tú</b>
                  <span className="muted">Escanea y escribe a Wink</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <footer className="live-ticker" aria-label="Acciones del asistente">
        {activity.length === 0 ? (
          <span className="muted">Las acciones del asistente aparecerán aquí.</span>
        ) : (
          activity.map((a, i) => {
            const d = describe(a)!;
            return (
              <span key={a.id} className={`live-act ${i === 0 ? "is-new" : ""}`}>
                {d.icon} {d.text} <time>{timeOnly(a.created_at)}</time>
              </span>
            );
          })
        )}
      </footer>
    </main>
  );
}
