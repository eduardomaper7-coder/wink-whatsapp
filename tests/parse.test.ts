import { describe, expect, it } from "vitest";
import { extractMessageValues, normalizeInbound, normalizeStatus } from "@/lib/whatsapp/parse";
import { fixture } from "./helpers/fixtures";

function firstMessage(name: string) {
  const v = extractMessageValues(fixture(name))[0]!;
  const raw = v.messages![0]!;
  return normalizeInbound(raw, v.contacts?.[0]?.profile?.name);
}

describe("normalizeInbound — payloads reales", () => {
  it("texto", () => {
    const m = firstMessage("text");
    expect(m.type).toBe("text");
    expect(m.content.body).toMatch(/Chamberí/);
    expect(m.profileName).toBe("Lucía Martín");
    expect(m.from).toBe("34612345678");
    expect(m.timestamp.toISOString()).toBe(new Date(1763650000 * 1000).toISOString());
    expect(m.media).toBeUndefined();
  });

  it("texto desde anuncio click-to-WhatsApp conserva el referral (origen del lead)", () => {
    const m = firstMessage("text_ad_referral");
    expect((m.content.referral as Record<string, unknown>).source_type).toBe("ad");
  });

  it("imagen con pie de foto", () => {
    const m = firstMessage("image");
    expect(m.type).toBe("image");
    expect(m.media).toMatchObject({ id: "1003383421387256", kind: "image", mimeType: "image/jpeg" });
    expect(m.content.caption).toBe("Así está la cocina ahora");
    expect(m.textPreview).toBe("📷 Imagen: Así está la cocina ahora");
  });

  it("documento PDF (plano) conserva el nombre de archivo", () => {
    const m = firstMessage("document");
    expect(m.type).toBe("document");
    expect(m.media?.filename).toBe("plano-vivienda.pdf");
    expect(m.content.mime_type).toBe("application/pdf");
  });

  it("nota de voz", () => {
    const m = firstMessage("audio_voice");
    expect(m.type).toBe("audio");
    expect(m.content.voice).toBe(true);
    expect(m.textPreview).toBe("🎤 Nota de voz");
  });

  it("ubicación", () => {
    const m = firstMessage("location");
    expect(m.type).toBe("location");
    expect(m.content).toMatchObject({ latitude: 40.43, longitude: -3.702, name: "Mi casa" });
    expect(m.textPreview).toBe("📍 Mi casa");
  });

  it("respuesta a botón interactivo, con el mensaje al que responde", () => {
    const m = firstMessage("interactive_button_reply");
    expect(m.type).toBe("interactive");
    expect(m.content).toMatchObject({ kind: "button_reply", id: "slot_2026-11-24T10:00", title: "Lun 24, 10:00" });
    expect(m.replyToWaMessageId).toBe("wamid.OUTBOUND_SLOTS_0001");
  });

  it("respuesta a lista", () => {
    const m = firstMessage("interactive_list_reply");
    expect(m.content).toMatchObject({ kind: "list_reply", id: "reforma_integral", title: "Reforma integral" });
  });

  it("botón de respuesta rápida de plantilla (type=button)", () => {
    const m = firstMessage("button_template");
    expect(m.type).toBe("button");
    expect(m.content).toMatchObject({ payload: "Sí, me interesa", text: "Sí, me interesa" });
  });

  it("reacción y reacción retirada (sin emoji)", () => {
    const r = firstMessage("reaction");
    expect(r.reaction).toEqual({ targetWaMessageId: "wamid.OUTBOUND_SLOTS_0001", emoji: "👍" });
    const removed = firstMessage("reaction_removed");
    expect(removed.reaction).toEqual({ targetWaMessageId: "wamid.OUTBOUND_SLOTS_0001", emoji: null });
  });

  it("tipo no soportado por Meta se guarda con aviso y código de error", () => {
    const m = firstMessage("unsupported");
    expect(m.type).toBe("unsupported");
    expect(m.notice).toMatch(/no soportado/);
    expect(m.content).toMatchObject({ unsupported_type: "edit", error: { code: 131051 } });
  });

  it("tipo que no tratamos (tarjeta de contacto) se guarda con aviso", () => {
    const m = firstMessage("contacts_card");
    expect(m.type).toBe("unsupported");
    expect(m.content.original_type).toBe("contacts");
    expect(m.notice).toBe("Tipo de mensaje no soportado: contacts");
  });
});

describe("normalizeStatus", () => {
  it("sent / read / delivered", () => {
    const st = extractMessageValues(fixture("statuses"))[0]!.statuses!.map(normalizeStatus);
    expect(st.map((s) => s?.status)).toEqual(["sent", "read", "delivered"]);
  });
  it("failed incluye el error", () => {
    const s = normalizeStatus(extractMessageValues(fixture("status_failed"))[0]!.statuses![0]!);
    expect(s?.error).toMatchObject({ code: 131047, title: "Re-engagement message" });
  });
  it("ignora estados desconocidos", () => {
    expect(normalizeStatus({ id: "x", status: "deleted", timestamp: "1", recipient_id: "1" })).toBeNull();
  });
});

describe("extractMessageValues", () => {
  it("ignora objetos que no son de WhatsApp", () => {
    expect(extractMessageValues({ object: "page", entry: [] })).toEqual([]);
  });
});
