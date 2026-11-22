"use client";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "./hooks";

interface TemplateOption {
  id: string;
  name: string;
  language: string;
  category: string | null;
  shape: { bodyText: string | null; bodyVariables: string[]; headerFormat: string | null; headerVariables: string[]; urlButtons: Array<{ index: number; text: string }> };
}

const fill = (text: string, vars: Record<string, string>) => text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, k: string) => vars[k] || m);

export function TemplatePicker({ conversationId, onClose, onSent, toast }: { conversationId: string; onClose: () => void; onSent: () => void; toast: (m: string) => void }) {
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);
  const [selected, setSelected] = useState<TemplateOption | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  useEffect(() => {
    void api<{ templates: TemplateOption[] }>("/api/templates").then((r) => setTemplates(r.ok ? r.data.templates : []));
  }, []);

  // Solo se ofrecen las plantillas que se pueden enviar desde aquí (sin cabecera multimedia)
  const usable = useMemo(() => (templates ?? []).filter((t) => !t.shape.headerFormat || t.shape.headerFormat === "TEXT"), [templates]);
  const missing = selected ? selected.shape.bodyVariables.filter((v) => !vars[v]?.trim()) : [];

  async function send() {
    if (!selected || missing.length) return;
    setSending(true);
    const positional = selected.shape.bodyVariables.every((v) => /^\d+$/.test(v));
    const body = positional ? selected.shape.bodyVariables.map((v) => vars[v]!.trim()) : Object.fromEntries(selected.shape.bodyVariables.map((v) => [v, vars[v]!.trim()]));
    const res = await api(`/api/conversations/${conversationId}/messages`, {
      body: { content: { type: "template", name: selected.name, language: selected.language, ...(selected.shape.bodyVariables.length ? { body } : {}) }, clientRef: crypto.randomUUID() },
    });
    setSending(false);
    if (!res.ok && res.status !== 422) return toast(res.data.error ?? "No se pudo enviar la plantilla");
    onSent();
    onClose();
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="tpl-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="tpl-title">Enviar plantilla</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          {templates === null && <p className="muted">Cargando plantillas…</p>}
          {templates !== null && usable.length === 0 && (
            <p className="muted small">No hay plantillas aprobadas. Créalas en WhatsApp Manager y sincronízalas desde Ajustes.</p>
          )}
          {!selected &&
            usable.map((t) => (
              <button key={t.id} className="tpl" onClick={() => setSelected(t)}>
                <div className="row">
                  <b className="grow">{t.name.replace(/_/g, " ")}</b>
                  <span className="chip">{t.language}</span>
                </div>
                <p className="small muted" style={{ margin: "6px 0 0" }}>
                  {t.shape.bodyText}
                </p>
              </button>
            ))}
          {selected && (
            <>
              <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setSelected(null)}>
                ← Otras plantillas
              </button>
              {selected.shape.bodyVariables.map((v) => (
                <label key={v} className="small" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  Variable {`{{${v}}}`}
                  <input className="input" value={vars[v] ?? ""} onChange={(e) => setVars({ ...vars, [v]: e.target.value })} />
                </label>
              ))}
              <div className="card" style={{ padding: 12, background: "var(--sand)" }}>
                <p className="xs muted" style={{ margin: "0 0 4px" }}>
                  Vista previa
                </p>
                <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{fill(selected.shape.bodyText ?? "", vars)}</p>
              </div>
              <button className="btn btn-primary" disabled={sending || missing.length > 0} onClick={() => void send()}>
                {sending ? "Enviando…" : "Enviar plantilla"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
