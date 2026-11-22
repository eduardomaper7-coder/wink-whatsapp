"use client";
/* eslint-disable @next/next/no-img-element */
import { FileText, Mic, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSignedUrl } from "./hooks";
import { RecepcionSection } from "./RecepcionSection";
import { displayName, formatPhone, HANDOFF_LABEL, initials, LEAD_STATUS, PROJECT_LABEL, visitParts } from "./format";
import type { Attachment, ConversationItem, EventItem, Lead, TeamMember } from "./types";

const FIELDS: Array<{ key: keyof Lead; label: string; render?: (l: Lead) => string | null }> = [
  { key: "full_name", label: "Nombre" },
  { key: "project_type", label: "Proyecto", render: (l) => (l.project_type ? `${PROJECT_LABEL[l.project_type] ?? l.project_type}${l.project_type_other ? ` · ${l.project_type_other}` : ""}` : null) },
  { key: "address", label: "Dirección" },
  { key: "surface_m2", label: "Superficie", render: (l) => (l.surface_m2 ? `${Number(l.surface_m2).toLocaleString("es-ES")} m²` : null) },
  { key: "property_state", label: "Estado actual" },
  { key: "goals", label: "Objetivos" },
  { key: "budget_range", label: "Presupuesto" },
  { key: "desired_timeline", label: "Plazos" },
  {
    key: "contact_preference",
    label: "Contacto",
    render: (l) => (l.contact_preference ? `${{ whatsapp: "WhatsApp", llamada: "Llamada", email: "Email" }[l.contact_preference] ?? l.contact_preference}${l.contact_preference_notes ? ` · ${l.contact_preference_notes}` : ""}` : null),
  },
];

function Doc({ a }: { a: Attachment }) {
  const url = useSignedUrl(a.storage_bucket, a.storage_path);
  const label = a.description ?? a.original_filename ?? a.kind;
  if (a.kind === "image") {
    return (
      <a className="doc" href={url ?? undefined} target="_blank" rel="noreferrer" title={label}>
        {url ? <img src={url} alt={label} /> : null}
      </a>
    );
  }
  return (
    <a className="doc" href={url ?? undefined} target="_blank" rel="noreferrer" title={label}>
      <span>
        {a.kind === "audio" ? <Mic size={20} /> : <FileText size={20} />}
        <br />
        <span className="ellipsis" style={{ display: "block", maxWidth: 90 }}>
          {a.original_filename ?? label}
        </span>
      </span>
    </a>
  );
}

/** Markdown mínimo del briefing (títulos, listas, negritas). */
function Briefing({ md }: { md: string }) {
  const lines = md.split("\n");
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(<ul key={`u${out.length}`}>{list.map((li, i) => <li key={i}>{bold(li)}</li>)}</ul>);
    list = [];
  };
  const bold = (s: string) => s.split(/\*\*(.+?)\*\*/g).map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : p));
  for (const l of lines) {
    const h = l.match(/^#{1,3}\s+(.*)/);
    const li = l.match(/^\s*[-*]\s+(.*)/);
    if (li) {
      list.push(li[1]!);
      continue;
    }
    flush();
    if (h) out.push(<h3 key={out.length}>{h[1]}</h3>);
    else if (l.trim()) out.push(<p key={out.length} style={{ margin: "4px 0" }}>{bold(l)}</p>);
  }
  flush();
  return <div className="briefing">{out}</div>;
}

export function LeadPanel({ conv, lead, docs, events, team, onClose }: { conv: ConversationItem; lead: Lead | null; docs: Attachment[]; events: EventItem[]; team: TeamMember[]; onClose: () => void }) {
  // Resaltar los campos que cambian en directo (mientras el agente conversa)
  const prev = useRef<Lead | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (lead && prev.current && prev.current.id === lead.id) {
      const changed = FIELDS.filter((f) => prev.current![f.key] !== lead[f.key]).map((f) => f.key as string);
      if (changed.length) {
        setFlash(new Set(changed));
        const t = setTimeout(() => setFlash(new Set()), 1700);
        prev.current = lead;
        return () => clearTimeout(t);
      }
    }
    prev.current = lead;
  }, [lead]);

  const name = lead?.full_name || displayName(conv.contact);
  const filled = lead ? FIELDS.filter((f) => (f.render ? f.render(lead) : lead[f.key])).length : 0;
  const status = LEAD_STATUS[lead?.status ?? "new"] ?? LEAD_STATUS.new!;
  const handoff = [...events].reverse().find((e) => e.type === "agent.handoff");
  const assignee = team.find((t) => t.id === conv.assigned_to);

  return (
    <aside className="pane lead-pane lead" aria-label="Ficha del cliente">
      <div className="lead-head">
        <div className="row">
          <div className="avatar">{initials(name)}</div>
          <span className="grow" />
          <button className="btn btn-ghost btn-icon only-narrow" onClick={onClose} aria-label="Cerrar ficha">
            <X size={18} />
          </button>
        </div>
        <h2>{name}</h2>
        <div className="row small muted" style={{ flexWrap: "wrap" }}>
          <span>{formatPhone(conv.contact.wa_id)}</span>
          {lead?.contact_email && <span>· {lead.contact_email}</span>}
        </div>
        <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
          <span className={`chip ${status.tone ? `chip-${status.tone}` : ""}`}>{status.label}</span>
          {lead?.source && lead.source !== "whatsapp" && <span className="chip">{lead.source}</span>}
          {assignee && <span className="chip">Asignada a {assignee.full_name.split(" ")[0]}</span>}
        </div>
      </div>

      <RecepcionSection conversationId={conv.id} />

      {lead?.visit_at && (
        <div className="section">
          <h3>Visita técnica</h3>
          {(() => {
            const v = visitParts(lead.visit_at);
            return (
              <div className="visit">
                <div className="day">
                  <span className="xs">{v.weekday}</span>
                  <b>{v.day}</b>
                  <span className="xs">{v.month}</span>
                </div>
                <div>
                  <div style={{ fontWeight: 600 }}>{v.time} h</div>
                  <div className="small" style={{ opacity: 0.8 }}>
                    {lead.address}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {(handoff || lead?.handoff_summary) && conv.status === "human" && (
        <div className="section">
          <h3>Derivada al equipo</h3>
          <div className="handoff">
            <b>{HANDOFF_LABEL[String(handoff?.data.categoria ?? conv.handoff_reason ?? "otro")] ?? "Derivada"}</b>
            <p style={{ margin: "4px 0 0" }}>{String(handoff?.data.resumen ?? lead?.handoff_summary ?? "")}</p>
          </div>
        </div>
      )}

      <div className="section">
        <h3>
          Ficha <span>{filled}/{FIELDS.length}</span>
        </h3>
        <div className="progress" aria-label={`Ficha completada ${filled} de ${FIELDS.length}`}>
          <i style={{ width: `${(filled / FIELDS.length) * 100}%` }} />
        </div>
        <dl style={{ margin: "10px 0 0" }}>
          {FIELDS.map((f) => {
            const value = lead ? (f.render ? f.render(lead) : (lead[f.key] as string | null)) : null;
            return (
              <div key={f.key} className={`field ${flash.has(f.key as string) ? "flash" : ""}`}>
                <dt>{f.label}</dt>
                <dd className={value ? "" : "missing"}>{value || "pendiente"}</dd>
              </div>
            );
          })}
        </dl>
      </div>

      <div className="section">
        <h3>
          Documentos <span>{docs.length}</span>
        </h3>
        {docs.length ? (
          <div className="docs">
            {docs.map((d) => (
              <Doc key={d.id} a={d} />
            ))}
          </div>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            Aún no hay fotos ni planos.
          </p>
        )}
      </div>

      <div className="section">
        <h3>
          Briefing para el arquitecto {lead?.briefing_sent_at && <span>enviado por email</span>}
        </h3>
        {lead?.briefing_md ? (
          <Briefing md={lead.briefing_md} />
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            Se genera automáticamente al reservar la visita.
          </p>
        )}
      </div>
    </aside>
  );
}
