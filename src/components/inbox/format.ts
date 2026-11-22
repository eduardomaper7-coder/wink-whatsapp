import type { Contact } from "./types";

const TZ = "Europe/Madrid";

export function displayName(c: Pick<Contact, "name" | "profile_name" | "wa_id">): string {
  return c.name || c.profile_name || formatPhone(c.wa_id);
}

export function initials(name: string): string {
  const parts = name.replace(/^\+?\d[\d\s]*$/, "#").split(/\s+/).filter(Boolean);
  if (parts[0] === "#") return "#";
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** 34612345678 → +34 612 34 56 78 */
export function formatPhone(waId: string): string {
  if (waId.startsWith("34") && waId.length === 11) return `+34 ${waId.slice(2, 5)} ${waId.slice(5, 7)} ${waId.slice(7, 9)} ${waId.slice(9)}`;
  return `+${waId}`;
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("es-ES", { timeZone: TZ, ...opts });
const dayKey = (d: Date) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export function timeOnly(iso: string): string {
  return fmt({ hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/** Para la lista: hora si es hoy, "ayer", día de la semana o fecha. */
export function listTime(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (dayKey(d) === dayKey(now)) return timeOnly(iso);
  const y = new Date(now.getTime() - 86_400_000);
  if (dayKey(d) === dayKey(y)) return "ayer";
  if (now.getTime() - d.getTime() < 6 * 86_400_000) return fmt({ weekday: "long" }).format(d);
  return fmt({ day: "2-digit", month: "2-digit", year: "2-digit" }).format(d);
}

/** Separador de día en la conversación. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (dayKey(d) === dayKey(now)) return "Hoy";
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86_400_000))) return "Ayer";
  return fmt({ weekday: "long", day: "numeric", month: "long" }).format(d);
}
export const sameDay = (a: string, b: string) => dayKey(new Date(a)) === dayKey(new Date(b));

export function visitParts(iso: string) {
  const d = new Date(iso);
  return {
    weekday: fmt({ weekday: "short" }).format(d).replace(".", ""),
    day: fmt({ day: "numeric" }).format(d),
    month: fmt({ month: "short" }).format(d).replace(".", ""),
    time: timeOnly(iso),
    long: fmt({ weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d),
  };
}

export type WindowLevel = "open" | "soon" | "closed";
export function windowLevel(lastInboundAt: string | null, now = Date.now()): { level: WindowLevel; hoursLeft: number } {
  if (!lastInboundAt) return { level: "closed", hoursLeft: 0 };
  const left = new Date(lastInboundAt).getTime() + 24 * 3_600_000 - now - 2 * 60_000;
  if (left <= 0) return { level: "closed", hoursLeft: 0 };
  return { level: left < 2 * 3_600_000 ? "soon" : "open", hoursLeft: left / 3_600_000 };
}

export function windowText(lastInboundAt: string | null): string {
  const { level, hoursLeft } = windowLevel(lastInboundAt);
  if (level === "closed") return "Ventana de 24 h cerrada";
  if (hoursLeft < 1) return `Ventana: quedan ${Math.max(1, Math.round(hoursLeft * 60))} min`;
  return `Ventana: quedan ${Math.floor(hoursLeft)} h`;
}

export const PROJECT_LABEL: Record<string, string> = {
  reforma_integral: "Reforma integral",
  reforma_parcial: "Reforma parcial",
  interiorismo: "Interiorismo",
  obra_nueva: "Obra nueva",
  otro: "Otro",
};

export const LEAD_STATUS: Record<string, { label: string; tone: "" | "ok" | "warn" | "danger" | "ink" }> = {
  new: { label: "Nuevo", tone: "" },
  qualifying: { label: "Cualificando", tone: "warn" },
  visit_scheduled: { label: "Visita agendada", tone: "ok" },
  handed_off: { label: "Con el equipo", tone: "ink" },
  won: { label: "Ganado", tone: "ok" },
  lost: { label: "Perdido", tone: "danger" },
  closed: { label: "Cerrado", tone: "" },
};

export const HANDOFF_LABEL: Record<string, string> = {
  lo_pide_cliente: "Pide hablar con una persona",
  cliente_molesto: "Cliente molesto",
  obra_en_curso: "Cliente con obra en curso",
  proveedor: "Proveedor / comercial",
  urgencia: "Urgencia",
  duda: "El asistente no estaba seguro",
  error: "Error del asistente",
  otro: "Derivada al equipo",
};
