"use client";
import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./hooks";

interface RecepcionView {
  enabled: boolean;
  kind: "personal" | "cliente_con_expediente" | "cliente" | "desconocido" | null;
  staffName: string | null;
  project: { id: string; code: string | null; url: string | null } | null;
  staffProject: { code: string; at: string | null } | null;
  recepcionMode: string | null;
  recepcionModeSource: "expediente" | "ajustes" | null;
  override: string | null;
  effective: "asistente" | "borrador" | "solo_recibir" | "solo_equipo";
  modes: string[];
}

const MODE: Record<string, { label: string; help: string }> = {
  asistente: { label: "Asistente automático", help: "Responde el asistente (sin precios, con aviso de privacidad). Lo técnico pasa por aprobación en Recepción." },
  borrador: { label: "Borrador con aprobación", help: "El agente prepara la respuesta en Recepción y un arquitecto la aprueba antes de enviarla por aquí." },
  solo_recibir: { label: "Solo recibir", help: "No se responde: lo que llega se incorpora al expediente." },
  solo_equipo: { label: "Solo equipo", help: "Contesta una persona desde esta bandeja." },
};

const KIND: Record<string, string> = {
  personal: "Personal de Wink",
  cliente_con_expediente: "Cliente con expediente",
  cliente: "Cliente (sin expediente activo)",
  desconocido: "Cliente nuevo",
};

/** Ficha · Recepción del encargo: expediente vinculado y cómo se responde por WhatsApp. */
export function RecepcionSection({ conversationId }: { conversationId: string }) {
  const [v, setV] = useState<RecepcionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<RecepcionView>(`/api/conversations/${conversationId}/recepcion`);
    if (r.ok) setV(r.data);
  }, [conversationId]);
  useEffect(() => {
    load();
  }, [load]);

  if (!v || !v.enabled) return null;

  const change = async (value: string) => {
    setBusy(true);
    setErr(null);
    const r = await api<RecepcionView>(`/api/conversations/${conversationId}/recepcion`, { method: "PATCH", body: { mode: value || null } });
    setBusy(false);
    if (r.ok) setV(r.data);
    else setErr(r.data.error ?? "No se pudo cambiar");
  };

  const defaultLabel = v.recepcionMode ? MODE[v.recepcionMode]?.label : null;
  const selectValue = v.project ? (v.recepcionModeSource === "expediente" ? (v.recepcionMode ?? "") : "") : (v.override ?? "");

  return (
    <div className="section">
      <h3>Recepción del encargo</h3>
      <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        <span className={`chip ${v.kind === "personal" ? "chip-ink" : v.kind === "cliente_con_expediente" ? "chip-ok" : ""}`}>
          {v.kind === "personal" ? `${KIND.personal}${v.staffName ? ` · ${v.staffName}` : ""}` : KIND[v.kind ?? "desconocido"]}
        </span>
        {v.project?.code && (
          <a className="chip" href={v.project.url ?? undefined} target="_blank" rel="noreferrer" title="Abrir el expediente en Recepción">
            {v.project.code} <ExternalLink size={12} style={{ marginLeft: 4 }} />
          </a>
        )}
      </div>

      {v.kind === "personal" ? (
        <p className="small muted" style={{ margin: 0 }}>
          {v.staffProject?.code
            ? `Sus fotos, notas y audios se guardan en el expediente ${v.staffProject.code}.`
            : "Cuando escriba, se le preguntará a qué expediente van sus fotos, notas y audios."}{" "}
          El asistente no le responde como a un cliente.
        </p>
      ) : (
        <>
          <label className="small muted" htmlFor={`rcp-mode-${conversationId}`}>
            Respuestas por WhatsApp
          </label>
          <select id={`rcp-mode-${conversationId}`} className="input" style={{ width: "100%", marginTop: 4 }} disabled={busy} value={selectValue} onChange={(e) => change(e.target.value)}>
            <option value="">Por defecto{defaultLabel && (!v.project || v.recepcionModeSource !== "expediente") ? ` (${defaultLabel})` : " (según Ajustes de Recepción)"}</option>
            {v.modes.map((m) => (
              <option key={m} value={m}>
                {MODE[m]?.label ?? m}
              </option>
            ))}
          </select>
          <p className="small muted" style={{ margin: "6px 0 0" }}>
            Ahora: <b>{MODE[v.effective]?.label}</b>. {MODE[v.effective]?.help}
          </p>
          {!v.project && <p className="small muted" style={{ margin: "6px 0 0" }}>Al reservar la visita se crea el expediente en Recepción con todo lo recibido.</p>}
        </>
      )}
      {err && <p className="small" style={{ color: "var(--danger)", margin: "6px 0 0" }}>{err}</p>}
    </div>
  );
}
