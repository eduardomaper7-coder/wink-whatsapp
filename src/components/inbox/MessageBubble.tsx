"use client";
/* eslint-disable @next/next/no-img-element */
import { AlertCircle, Bot, Check, CheckCheck, Clock, FileText, MapPin, MousePointerClick } from "lucide-react";
import { useState } from "react";
import { useSignedUrl } from "./hooks";
import { timeOnly } from "./format";
import type { Attachment, MessageItem, TeamMember } from "./types";

function StatusIcon({ m }: { m: MessageItem }) {
  if (m.direction !== "outbound") return null;
  if (m.status === "failed") return <AlertCircle size={13} aria-label="Fallido" />;
  if (m.status === "read" || m.status === "played") return <CheckCheck size={14} className="read" aria-label="Leído" />;
  if (m.status === "delivered") return <CheckCheck size={14} aria-label="Entregado" />;
  if (m.status === "sent" || m.wa_message_id) return <Check size={14} aria-label="Enviado" />;
  return <Clock size={12} aria-label="Enviando" />;
}

function Media({ m, att, onOpenImage }: { m: MessageItem; att?: Attachment; onOpenImage: (url: string) => void }) {
  const url = useSignedUrl(att?.storage_bucket, att?.storage_path);
  const c = m.content as Record<string, string | undefined>;
  if (!att) {
    if (m.media_status === "failed") return <div className="media-pending">No se pudo descargar el archivo</div>;
    if (m.direction === "outbound" && !c.media) return null;
    return <div className="media-pending">Descargando {m.type === "audio" ? "audio" : "archivo"}…</div>;
  }
  if (m.type === "image" || m.type === "sticker") {
    return url ? <img src={url} alt={c.caption ?? "Imagen"} className="media-img" onClick={() => onOpenImage(url)} /> : <div className="media-pending">Cargando imagen…</div>;
  }
  if (m.type === "audio") {
    return url ? <audio controls preload="metadata" src={url} /> : <div className="media-pending">Cargando audio…</div>;
  }
  if (m.type === "video") return url ? <video controls src={url} style={{ maxWidth: "100%", borderRadius: 10 }} /> : null;
  return (
    <a className="media-doc" href={url ?? undefined} target="_blank" rel="noreferrer">
      <FileText size={22} />
      <span className="grow ellipsis small">{att.original_filename ?? c.filename ?? "Documento"}</span>
      <span className="xs muted">{(att.mime_type ?? "").split("/")[1]?.toUpperCase().slice(0, 4)}</span>
    </a>
  );
}

export function MessageBubble({
  m,
  att,
  team,
  grouped,
  onOpenImage,
}: {
  m: MessageItem;
  att?: Attachment;
  team: TeamMember[];
  grouped: boolean;
  onOpenImage: (url: string) => void;
}) {
  const [showError, setShowError] = useState(false);
  const c = m.content as Record<string, unknown>;
  const side = m.direction === "inbound" ? "in" : "out";
  const kind = m.direction === "inbound" ? "customer" : m.author;
  const sender = m.author === "human" ? (team.find((t) => t.id === m.sent_by)?.full_name ?? "Equipo Wink") : null;

  let body: React.ReactNode = null;
  switch (m.type) {
    case "text":
      body = <span className="text">{String(c.body ?? "")}</span>;
      break;
    case "image":
    case "document":
    case "audio":
    case "video":
    case "sticker":
      body = (
        <>
          <Media m={m} att={att} onOpenImage={onOpenImage} />
          {typeof c.caption === "string" && c.caption && <span className="text">{c.caption}</span>}
          {typeof c.transcript === "string" && <div className="transcript">«{c.transcript}»</div>}
          {m.type === "audio" && c.transcript_status === "failed" && <div className="transcript">(no se pudo transcribir)</div>}
        </>
      );
      break;
    case "location":
      body = (
        <a href={`https://maps.google.com/?q=${c.latitude},${c.longitude}`} target="_blank" rel="noreferrer" className="media-doc">
          <MapPin size={20} />
          <span className="grow small">{String(c.name ?? c.address ?? "Ubicación")}</span>
        </a>
      );
      break;
    case "interactive":
      if (m.direction === "inbound") {
        body = (
          <span className="picked">
            <MousePointerClick size={14} /> {String(c.title ?? "")}
          </span>
        );
      } else {
        const buttons = (c.buttons as Array<{ title: string }> | undefined) ?? (c.sections as Array<{ rows: Array<{ title: string }> }> | undefined)?.flatMap((s) => s.rows);
        body = (
          <>
            <span className="text">{String(c.body ?? "")}</span>
            {buttons && (
              <div className="quick-replies">
                {buttons.map((b, i) => (
                  <span key={i}>{b.title}</span>
                ))}
              </div>
            )}
          </>
        );
      }
      break;
    case "button":
      body = (
        <span className="picked">
          <MousePointerClick size={14} /> {String(c.text ?? "")}
        </span>
      );
      break;
    case "template":
      body = (
        <>
          <span className="xs muted" style={{ display: "block", marginBottom: 2 }}>
            Plantilla · {String(c.name)}
          </span>
          <span className="text">{m.text_preview}</span>
        </>
      );
      break;
    case "unsupported":
      body = <span className="text muted">⚠️ {String(c.notice ?? "Mensaje no soportado")}</span>;
      break;
    default:
      body = <span className="text">{m.text_preview}</span>;
  }

  const err = m.error as { message_es?: string; retrying?: boolean } | null;

  return (
    <div className={`msg ${side} ${kind} ${grouped ? "grouped" : ""} ${m.customer_reaction ? "has-reaction" : ""}`}>
      <div className="bubble">
        {!grouped && m.direction === "outbound" && (
          <div className="author">
            {m.author === "agent" && (
              <>
                <Bot size={12} /> Asistente IA
              </>
            )}
            {m.author === "human" && sender}
            {m.author === "system" && "Sistema"}
          </div>
        )}
        {body}
        <span className="meta">
          {timeOnly(m.created_at)} <StatusIcon m={m} />
        </span>
        {m.status === "failed" && (
          <div className="failed-note" role="button" onClick={() => setShowError((v) => !v)}>
            <AlertCircle size={13} style={{ flex: "none", marginTop: 1 }} />
            <span>{err?.message_es ?? "No se pudo enviar"}</span>
          </div>
        )}
        {m.status !== "failed" && err?.retrying && showError === false && (
          <div className="failed-note" style={{ color: "var(--warn)" }}>
            <Clock size={12} style={{ flex: "none", marginTop: 2 }} /> <span>{err.message_es ?? "Reintentando…"}</span>
          </div>
        )}
        {m.customer_reaction && <span className="reaction">{m.customer_reaction}</span>}
      </div>
    </div>
  );
}
