/**
 * Utilidades de fecha en una zona horaria (sin dependencias).
 * Convierten "2026-11-24 10:00 en Europe/Madrid" ⇄ instante UTC, teniendo en cuenta el horario de verano.
 */

function partsIn(date: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const iso = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday as string] ?? 0;
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, min: +p.minute!, s: +p.second!, isoWeekday: iso };
}

/** Desfase (ms) de la zona respecto a UTC en un instante dado. */
function offsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Hora local (fecha "YYYY-MM-DD" + "HH:MM") en la zona → instante UTC. */
export function zonedToUtc(dateYmd: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = dateYmd.split("-").map(Number) as [number, number, number];
  const [h, min] = hhmm.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, min);
  // Dos pasadas para cubrir los cambios de hora
  let ts = guess - offsetMs(new Date(guess), timeZone);
  ts = guess - offsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Fecha local "YYYY-MM-DD" y día ISO de un instante en la zona. */
export function localDate(date: Date, timeZone: string): { ymd: string; isoWeekday: number; hhmm: string } {
  const p = partsIn(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { ymd: `${p.y}-${pad(p.m)}-${pad(p.d)}`, isoWeekday: p.isoWeekday, hhmm: `${pad(p.h)}:${pad(p.min)}` };
}

export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function isoWeekdayOfYmd(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
  return wd === 0 ? 7 : wd;
}

const DIAS = ["", "lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const DIAS_LARGOS = ["", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** "Lun 24 nov, 10:00" (cabe en un botón de 20 caracteres). */
export function shortLabel(date: Date, timeZone: string): string {
  const l = localDate(date, timeZone);
  const [, m, d] = l.ymd.split("-").map(Number) as [number, number, number];
  const dia = DIAS[l.isoWeekday]!;
  return `${dia[0]!.toUpperCase()}${dia.slice(1)} ${d} ${MESES[m - 1]}, ${l.hhmm}`;
}

/** "lunes 24 de noviembre a las 10:00" */
export function longLabel(date: Date, timeZone: string): string {
  const l = localDate(date, timeZone);
  const [, m, d] = l.ymd.split("-").map(Number) as [number, number, number];
  return `${DIAS_LARGOS[l.isoWeekday]} ${d} de ${MESES_LARGOS[m - 1]} a las ${l.hhmm}`;
}
