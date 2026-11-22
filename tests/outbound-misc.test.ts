import { describe, expect, it } from "vitest";
import { describeErrorCode, WhatsAppApiError } from "@/lib/whatsapp/errors";
import { checkOutboundMedia } from "@/lib/whatsapp/outbound/client";
import { checkTemplateValues, templateShape } from "@/lib/whatsapp/outbound/templates";
import { windowState } from "@/lib/whatsapp/window";

describe("ventana de 24 h", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  it("abierta, cerrándose y cerrada", () => {
    const open = windowState("2026-11-20T08:00:00Z", now);
    expect(open).toMatchObject({ open: true, closingSoon: false, closesAt: "2026-11-21T08:00:00.000Z" });
    expect(windowState("2026-11-19T13:00:00Z", now)).toMatchObject({ open: true, closingSoon: true });
    expect(windowState("2026-11-19T11:59:00Z", now)).toMatchObject({ open: false, minutesLeft: 0 });
    expect(windowState(null, now)).toMatchObject({ open: false, closesAt: null });
  });
  it("aplica un margen de seguridad de 2 minutos", () => {
    expect(windowState("2026-11-19T12:01:00Z", now).open).toBe(false);
    expect(windowState("2026-11-19T12:03:00Z", now).open).toBe(true);
  });
});

describe("clasificación de errores de Meta", () => {
  const err = (http: number, code?: number) => new WhatsAppApiError("x", http, code);
  it.each([
    [130429, "rate_limited", true],
    [131056, "rate_limited", true],
    [131000, "retryable", true],
    [131047, "window_closed", false],
    [131026, "recipient", false],
    [132001, "template", false],
    [132015, "template", false],
    [190, "auth", false],
    [131053, "media", false],
    [100, "invalid_request", false],
  ])("código %i → %s (reintentable: %s)", (code, kind, retryable) => {
    const e = err(400, code);
    expect(e.kind).toBe(kind);
    expect(e.retryable).toBe(retryable);
    expect(e.toRecord().message_es.length).toBeGreaterThan(10);
  });
  it("sin código: 5xx reintentable, 429 límite, 4xx desconocido", () => {
    expect(err(503).retryable).toBe(true);
    expect(err(429).kind).toBe("rate_limited");
    expect(err(400).kind).toBe("unknown");
  });
  it("describe códigos de webhooks de estado", () => {
    expect(describeErrorCode(131047).kind).toBe("window_closed");
    expect(describeErrorCode(999999).kind).toBe("unknown");
  });
});

describe("plantillas", () => {
  const components = [
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: "Hola {{1}}, te recordamos tu visita el {{2}}. ¡Hasta pronto!" },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Ver cita", url: "https://wink.es/cita/{{1}}" }, { type: "QUICK_REPLY", text: "Cambiar hora" }] },
  ];
  it("detecta variables, cabecera y botones", () => {
    expect(templateShape(components)).toEqual({
      bodyText: "Hola {{1}}, te recordamos tu visita el {{2}}. ¡Hasta pronto!",
      bodyVariables: ["1", "2"],
      headerFormat: "IMAGE",
      headerVariables: [],
      urlButtons: [{ index: 0, text: "Ver cita" }],
      quickReplies: ["Cambiar hora"],
    });
  });
  it("valida los valores antes de llamar a Meta", () => {
    const shape = templateShape(components);
    expect(checkTemplateValues(shape, { body: ["Lucía"] })).toEqual([
      "Faltan variables de la plantilla: {{2}}",
      "La plantilla necesita una imagen o documento en la cabecera",
      "Falta el final de la URL del botón «Ver cita»",
    ]);
    expect(checkTemplateValues(shape, { body: ["Lucía", "lunes"], header: { type: "image" }, urlButtons: [{ index: 0 }] })).toEqual([]);
  });
});

describe("media saliente", () => {
  it("formatos y tamaños", () => {
    expect(checkOutboundMedia("image", "image/jpeg", 1000)).toBeNull();
    expect(checkOutboundMedia("image", "image/heic", 1000)).toMatch(/JPG o PNG/);
    expect(checkOutboundMedia("image", "image/png", 6 * 1024 * 1024)).toMatch(/5 MB/);
    expect(checkOutboundMedia("document", "application/pdf", 50 * 1024 * 1024)).toBeNull();
    expect(checkOutboundMedia("document", "application/zip", 10)).toMatch(/no admitido/);
  });
});
