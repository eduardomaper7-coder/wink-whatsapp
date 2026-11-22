import { afterEach, describe, expect, it } from "vitest";
import { effectiveMode, recepcionEnabled } from "@/lib/integrations/recepcion";

describe("integración con Recepción del encargo", () => {
  afterEach(() => {
    delete process.env.RECEPCION_URL;
    delete process.env.INTEGRATION_SECRET;
  });
  it("desactivada sin URL o sin secreto: la app funciona como antes", () => {
    expect(recepcionEnabled()).toBe(false);
    process.env.RECEPCION_URL = "http://localhost:3000";
    expect(recepcionEnabled()).toBe(false);
    process.env.INTEGRATION_SECRET = "x".repeat(32);
    expect(recepcionEnabled()).toBe(true);
  });
  it("modo por defecto: asistente (comportamiento actual)", () => expect(effectiveMode({})).toBe("asistente"));
  it("el modo de Recepción se aplica", () => expect(effectiveMode({ recepcion_mode: "borrador" })).toBe("borrador"));
  it("lo elegido en la bandeja manda sobre Recepción", () => expect(effectiveMode({ recepcion_mode: "borrador", reply_mode_override: "solo_equipo" })).toBe("solo_equipo"));
  it("al personal de Wink nunca le responde el asistente", () => expect(effectiveMode({ recepcion_kind: "personal", reply_mode_override: "asistente" })).toBe("solo_recibir"));
});
