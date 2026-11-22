import { describe, expect, it } from "vitest";
import { redact, scrubString } from "@/lib/log";

describe("redacción de logs", () => {
  it("oculta secretos, teléfonos y texto libre", () => {
    const out = redact({
      access_token: "EAAabc",
      authorization: "Bearer x",
      wa_id: "34612345678",
      body: "Vivo en Calle Mayor 3",
      nested: { from: "34612345678", count: 3 },
    }) as Record<string, unknown>;
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.wa_id).toBe("***678");
    expect(out.body).toBe("[text:21]");
    expect(out.nested).toEqual({ from: "***678", count: 3 });
  });
  it("limpia tokens y teléfonos dentro de mensajes de error", () => {
    const s = scrubString("fallo con EAAGm0PX4ZCpsBAKZB1234567890 para 34612345678 Bearer abc.def");
    expect(s).not.toMatch(/EAAGm0|34612345678|abc\.def/);
  });
});
