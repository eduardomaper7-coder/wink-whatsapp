import { describe, expect, it } from "vitest";
import { backoffMs } from "@/lib/jobs/queue";
import { WhatsAppApiError } from "@/lib/whatsapp/errors";
import { extensionFor, sha256Matches, storagePathFor } from "@/lib/whatsapp/media";

describe("cola", () => {
  it("backoff exponencial con tope de 1 h", () => {
    const fixed = () => 0.5; // sin jitter
    expect(backoffMs(1, fixed)).toBe(15_000);
    expect(backoffMs(2, fixed)).toBe(30_000);
    expect(backoffMs(4, fixed)).toBe(120_000);
    expect(backoffMs(20, fixed)).toBe(3_600_000);
  });
  it("clasifica errores reintentables de la API", () => {
    expect(new WhatsAppApiError("x", 500).retryable).toBe(true);
    expect(new WhatsAppApiError("x", 429).retryable).toBe(true);
    expect(new WhatsAppApiError("x", 400, 130429).retryable).toBe(true);
    expect(new WhatsAppApiError("x", 404, 100).retryable).toBe(false);
  });
});

describe("media", () => {
  it("extensiones y rutas sin datos personales", () => {
    expect(extensionFor("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extensionFor("application/octet-stream", "plano.DWG")).toBe("dwg");
    expect(storagePathFor("conv", "msg", new Date("2026-11-20T10:00:00Z"), "pdf")).toBe("conv/2026/11/msg.pdf");
  });
  it("sha256 en hex o base64", () => {
    const hex = "0a0b0c0d0e0f00112233445566778899aabbccddeeff00112233445566778899";
    expect(sha256Matches(hex, hex)).toBe(true);
    expect(sha256Matches(hex, Buffer.from(hex, "hex").toString("base64"))).toBe(true);
    expect(sha256Matches(hex, "otro")).toBe(false);
    expect(sha256Matches(hex, undefined)).toBeNull();
  });
});
