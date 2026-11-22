import type { AgendaConfig } from "@/lib/agent/config";
import { addDaysYmd, isoWeekdayOfYmd, localDate, shortLabel, zonedToUtc } from "./time";

export interface Interval {
  start: Date;
  end: Date;
}

export interface Slot {
  id: string; // se usa como id del botón de WhatsApp
  start: string; // ISO UTC
  end: string;
  label: string; // "Lun 24 nov, 10:00" (≤ 20 caracteres)
}

export type Preference = "mañana" | "tarde" | "indiferente";

const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

export function slotId(start: Date): string {
  return `slot_${start.toISOString().slice(0, 16)}Z`; // slot_2026-11-24T09:00Z
}

export function parseSlotId(id: string): Date | null {
  const m = id.match(/^slot_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z$/);
  return m ? new Date(`${m[1]}:00Z`) : null;
}

/**
 * Busca huecos libres para la visita técnica.
 * - Respeta horario por día, festivos, antelación mínima, duración y margen entre visitas.
 * - Reparte las propuestas en días distintos y, si no hay preferencia, alterna mañana/tarde
 *   para dar opciones variadas (como haría una persona).
 */
export function findSlots(
  cfg: AgendaConfig,
  busy: Interval[],
  now: Date,
  opts: { preference?: Preference; fromYmd?: string; count?: number } = {},
): Slot[] {
  const tz = cfg.zonaHoraria;
  const count = opts.count ?? cfg.huecosAProponer;
  const earliest = new Date(now.getTime() + cfg.antelacionMinimaHoras * 3_600_000);
  const margin = cfg.margenEntreVisitasMin * 60_000;
  const duration = cfg.duracionVisitaMin * 60_000;
  const blocked = busy.map((b) => ({ start: new Date(b.start.getTime() - margin), end: new Date(b.end.getTime() + margin) }));
  const festivos = new Set(cfg.festivos);

  const today = localDate(now, tz).ymd;
  const startYmd = opts.fromYmd && opts.fromYmd > today ? opts.fromYmd : today;
  const out: Slot[] = [];
  let alternate: "mañana" | "tarde" = "mañana";

  for (let i = 0; i < cfg.horizonteDias + 7 && out.length < count; i++) {
    const ymd = addDaysYmd(startYmd, i);
    if (festivos.has(ymd)) continue;
    const ranges = cfg.horario[String(isoWeekdayOfYmd(ymd))];
    if (!ranges?.length) continue;

    const wanted = opts.preference && opts.preference !== "indiferente" ? opts.preference : alternate;
    const candidates: Date[] = [];
    for (const [from, to] of ranges) {
      const rangeStart = zonedToUtc(ymd, from, tz);
      const rangeEnd = zonedToUtc(ymd, to, tz);
      for (let t = rangeStart.getTime(); t + duration <= rangeEnd.getTime(); t += cfg.pasoMin * 60_000) {
        const slot = { start: new Date(t), end: new Date(t + duration) };
        if (slot.start < earliest) continue;
        if (blocked.some((b) => overlaps(slot, b))) continue;
        candidates.push(slot.start);
      }
    }
    if (!candidates.length) continue;

    const isMorning = (d: Date) => localDate(d, tz).hhmm < "14:00";
    const preferred = candidates.filter((d) => (wanted === "mañana" ? isMorning(d) : !isMorning(d)));
    let pick = preferred[0];
    // Sin preferencia explícita, si no hay en la franja alterna se ofrece lo que haya
    if (!pick && (!opts.preference || opts.preference === "indiferente")) pick = candidates[0];
    if (!pick) continue;

    out.push({ id: slotId(pick), start: pick.toISOString(), end: new Date(pick.getTime() + duration).toISOString(), label: shortLabel(pick, tz) });
    alternate = alternate === "mañana" ? "tarde" : "mañana";
  }
  return out;
}

/** Franjas ocupadas simuladas (modo demo) en un rango de fechas. */
export function demoBusy(cfg: AgendaConfig, from: Date, days: number): Interval[] {
  const weekly = cfg.demo?.ocupadoSemanal ?? {};
  const out: Interval[] = [];
  const startYmd = localDate(from, cfg.zonaHoraria).ymd;
  for (let i = 0; i <= days; i++) {
    const ymd = addDaysYmd(startYmd, i);
    for (const [a, b] of weekly[String(isoWeekdayOfYmd(ymd))] ?? []) {
      out.push({ start: zonedToUtc(ymd, a, cfg.zonaHoraria), end: zonedToUtc(ymd, b, cfg.zonaHoraria) });
    }
  }
  return out;
}
