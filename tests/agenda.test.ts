import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgendaConfig } from "@/lib/agent/config";
import { demoBusy, findSlots, parseSlotId, slotId } from "@/lib/calendar/agenda";
import { localDate, longLabel, shortLabel, zonedToUtc } from "@/lib/calendar/time";

const cfg = JSON.parse(readFileSync(path.resolve(__dirname, "../agent-config/agenda.json"), "utf8")) as AgendaConfig;
const TZ = "Europe/Madrid";

describe("zonas horarias", () => {
  it("Madrid en invierno (UTC+1) y verano (UTC+2)", () => {
    expect(zonedToUtc("2026-11-24", "10:00", TZ).toISOString()).toBe("2026-11-24T09:00:00.000Z");
    expect(zonedToUtc("2027-06-15", "10:00", TZ).toISOString()).toBe("2027-06-15T08:00:00.000Z");
  });
  it("día del cambio de hora (28 mar 2027)", () => {
    expect(zonedToUtc("2027-03-28", "12:00", TZ).toISOString()).toBe("2027-03-28T10:00:00.000Z");
    expect(zonedToUtc("2027-03-27", "12:00", TZ).toISOString()).toBe("2027-03-27T11:00:00.000Z");
  });
  it("etiquetas en español que caben en un botón (≤ 20)", () => {
    const d = new Date("2026-11-24T09:00:00Z");
    expect(shortLabel(d, TZ)).toBe("Mar 24 nov, 10:00");
    expect(shortLabel(new Date("2026-11-25T16:30:00Z"), TZ).length).toBeLessThanOrEqual(20);
    expect(longLabel(d, TZ)).toBe("martes 24 de noviembre a las 10:00");
    expect(localDate(d, TZ)).toEqual({ ymd: "2026-11-24", isoWeekday: 2, hhmm: "10:00" });
  });
});

describe("huecos de visita", () => {
  // Viernes 20 nov 2026, 19:30 en Madrid
  const now = new Date("2026-11-20T18:30:00Z");

  it("3 huecos en días distintos, laborables, con antelación mínima y alternando mañana/tarde", () => {
    const slots = findSlots(cfg, [], now);
    expect(slots).toHaveLength(3);
    const days = slots.map((s) => localDate(new Date(s.start), TZ));
    expect(new Set(days.map((d) => d.ymd)).size).toBe(3);
    expect(days.every((d) => d.isoWeekday <= 5)).toBe(true);
    expect(days[0]!.ymd).toBe("2026-11-23"); // lunes (finde sin horario)
    expect(days[0]!.hhmm).toBe("09:30");
    expect(days[1]!.hhmm >= "16:00").toBe(true); // tarde
    expect(slots.every((s) => new Date(s.start).getTime() - now.getTime() >= 20 * 3_600_000)).toBe(true);
    expect(slots.every((s) => s.label.length <= 20)).toBe(true);
  });

  it("respeta preferencia de tarde", () => {
    const slots = findSlots(cfg, [], now, { preference: "tarde" });
    expect(slots.every((s) => localDate(new Date(s.start), TZ).hhmm >= "16:00")).toBe(true);
  });

  it("evita ocupados con margen entre visitas", () => {
    const busy = [{ start: zonedToUtc("2026-11-23", "09:30", TZ), end: zonedToUtc("2026-11-23", "10:30", TZ) }];
    const first = findSlots(cfg, busy, now, { preference: "mañana", count: 1 })[0]!;
    // 10:30 fin + 30 min de margen → primer hueco 11:00
    expect(localDate(new Date(first.start), TZ)).toMatchObject({ ymd: "2026-11-23", hhmm: "11:00" });
  });

  it("salta festivos (8 dic) y respeta 'a partir de'", () => {
    const slots = findSlots(cfg, [], now, { fromYmd: "2026-12-07", count: 2 });
    const ymds = slots.map((s) => localDate(new Date(s.start), TZ).ymd);
    expect(ymds).not.toContain("2026-12-07");
    expect(ymds).not.toContain("2026-12-08");
    expect(ymds[0]).toBe("2026-12-09");
  });

  it("modo demo: miércoles por la mañana ocupado", () => {
    const busy = demoBusy(cfg, now, 14);
    const slots = findSlots(cfg, busy, now, { preference: "mañana", count: 5 });
    expect(slots.some((s) => localDate(new Date(s.start), TZ).isoWeekday === 3)).toBe(false);
  });

  it("ids de hueco reversibles", () => {
    const d = new Date("2026-11-24T09:00:00Z");
    expect(slotId(d)).toBe("slot_2026-11-24T09:00Z");
    expect(parseSlotId(slotId(d))?.toISOString()).toBe(d.toISOString());
    expect(parseSlotId("otra_cosa")).toBeNull();
  });
});
