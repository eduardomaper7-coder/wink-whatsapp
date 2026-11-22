import { describe, expect, it } from "vitest";
import { mandatoryHandoff, parseClassification } from "@/lib/agent/classifier";
import { ensurePrivacyNotice, guardOutgoing, mentionsPrice, SAFE_PRICE_REPLY } from "@/lib/agent/guardrails";
import { missingFields } from "@/lib/agent/lead";
import { mediaStillProcessing } from "@/lib/agent/run";
import { executeTool, type ToolContext } from "@/lib/agent/tools";
import { buildTranscript, hasPendingCustomerMessages, type HistoryMessage } from "@/lib/agent/transcript";
import { markdownToHtml } from "@/lib/notify/email";

let t = 0;
const msg = (p: Partial<HistoryMessage>): HistoryMessage => ({
  id: `m${++t}`,
  direction: "inbound",
  author: "customer",
  type: "text",
  content: {},
  text_preview: null,
  created_at: new Date(Date.UTC(2026, 10, 20, 10, t)).toISOString(),
  ...p,
});

describe("historial para Claude", () => {
  it("roles, unión de mensajes seguidos y descripciones de multimedia", () => {
    const h = [
      msg({ type: "text", content: { body: "Hola" } }),
      msg({ type: "text", content: { body: "Quiero reformar mi piso" } }),
      msg({ direction: "outbound", author: "agent", text_preview: "¡Hola! Soy el asistente de Wink." }),
      msg({ type: "image", content: { caption: "la cocina" }, attachment_id: "att-1" }),
      msg({ type: "audio", content: { transcript: "son unos noventa metros" } }),
      msg({ type: "interactive", content: { title: "Lun 24 nov, 10:00", id: "slot_x" } }),
      msg({ direction: "outbound", author: "human", sender_name: "Marta", text_preview: "Te llamo luego" }),
      msg({ type: "location", content: { name: "Mi casa", latitude: 40.43, longitude: -3.7 } }),
    ];
    const tr = buildTranscript(h);
    expect(tr.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(tr[0]!.content).toBe("Hola\nQuiero reformar mi piso");
    expect(tr[2]!.content).toContain("[Envió una imagen (adjunto_id: att-1)] la cocina");
    expect(tr[2]!.content).toContain("[Nota de voz transcrita] son unos noventa metros");
    expect(tr[2]!.content).toContain('[Pulsó: "Lun 24 nov, 10:00" (id: slot_x)]');
    expect(tr[3]!.content).toBe("[Mensaje de Marta (equipo Wink)] Te llamo luego");
    expect(hasPendingCustomerMessages(h)).toBe(true);
  });

  it("empieza siempre por el usuario y detecta si no hay nada que responder", () => {
    const h = [msg({ direction: "outbound", author: "system", text_preview: "Hola" }), msg({ type: "reaction", content: { emoji: "👍" } })];
    expect(buildTranscript(h)[0]).toEqual({ role: "user", content: "[Inicio de la conversación]" });
    expect(hasPendingCustomerMessages(h)).toBe(false); // una reacción no exige respuesta
  });

  it("espera a la multimedia reciente pendiente, pero no indefinidamente", () => {
    const now = Date.UTC(2026, 10, 20, 12, 0);
    const recent = msg({ type: "image", media_status: "pending", created_at: new Date(now - 10_000).toISOString() });
    expect(mediaStillProcessing([recent], now)).toBe(true);
    const old = msg({ type: "image", media_status: "pending", created_at: new Date(now - 120_000).toISOString() });
    expect(mediaStillProcessing([old], now)).toBe(false);
  });
});

describe("salvaguardas", () => {
  it.each([
    "Una reforma así suele costar unos 900 €/m2",
    "Calcula entre 1.000 y 1.200 euros el metro",
    "Rondará los 60.000€",
    "unos 30k€",
    "a 1000 por m2",
    "unos 50 mil euros",
  ])("bloquea precios: %s", (t) => {
    expect(mentionsPrice(t)).toBe(true);
    expect(guardOutgoing(t)).toEqual({ text: SAFE_PRICE_REPLY, blocked: true, reason: "precio" });
  });
  it.each(["¿Cuántos metros tiene la vivienda?", "Tu visita es el lunes 24 a las 10:00", "Vivo en el 3º B, unos 90 m2"])("deja pasar: %s", (t) => {
    expect(guardOutgoing(t).blocked).toBe(false);
  });
  it("añade el aviso de privacidad solo si falta", () => {
    const url = "https://winkgroup.es/politica-de-privacidad";
    expect(ensurePrivacyNotice("Hola", `Aviso ${url}`, url)).toBe(`Hola\n\nAviso ${url}`);
    expect(ensurePrivacyNotice(`Hola ${url}`, `Aviso ${url}`, url)).toBe(`Hola ${url}`);
  });
});

describe("clasificador", () => {
  it("interpreta el JSON aunque venga con texto alrededor", () => {
    const c = parseClassification('Aquí va: {"categoria":"proveedor","pide_humano":false,"molesto":false,"urgente":false,"confianza":0.92,"resumen":"Comercial de azulejos"}');
    expect(c).toMatchObject({ categoria: "proveedor", confianza: 0.92 });
    expect(mandatoryHandoff(c)).toBe("proveedor");
  });
  it("solo deriva con confianza suficiente; urgencia primero", () => {
    expect(mandatoryHandoff({ categoria: "cliente_potencial", pide_humano: true, molesto: false, urgente: false, confianza: 0.5, resumen: "" })).toBeNull();
    expect(mandatoryHandoff({ categoria: "obra_en_curso", pide_humano: true, molesto: true, urgente: true, confianza: 0.9, resumen: "" })).toBe("urgencia");
    expect(mandatoryHandoff({ categoria: "cliente_potencial", pide_humano: false, molesto: false, urgente: false, confianza: 0.99, resumen: "" })).toBeNull();
    expect(parseClassification("sin json")).toBeNull();
  });
});

describe("herramienta enviar_opciones", () => {
  const ctx = () => ({ outbox: [], state: {} }) as unknown as ToolContext;
  it("≤ 3 opciones cortas → botones", async () => {
    const c = ctx();
    const r = await executeTool("enviar_opciones", { motivo: "x", texto: "¿Qué hueco prefieres?", opciones: [{ id: "a", titulo: "Lun 24 nov, 10:00" }, { id: "b", titulo: "Mar 25 nov, 16:30" }] }, c);
    expect(r.result).toMatchObject({ ok: true, formato: "botones" });
    expect(c.outbox[0]).toMatchObject({ type: "buttons", buttons: [{ id: "a" }, { id: "b" }] });
  });
  it("más de 3 → lista; títulos demasiado largos → error para que el modelo corrija", async () => {
    const c = ctx();
    const opciones = ["Reforma integral", "Reforma parcial", "Interiorismo", "Obra nueva"].map((t, i) => ({ id: `p${i}`, titulo: t }));
    expect((await executeTool("enviar_opciones", { motivo: "x", texto: "¿Qué proyecto?", opciones }, c)).result).toMatchObject({ formato: "lista" });
    const bad = await executeTool("enviar_opciones", { motivo: "x", texto: "?", opciones: [...opciones, { id: "z", titulo: "Un título larguísimo de verdad" }] }, ctx());
    expect(bad.isError).toBe(true);
  });
  it("herramienta desconocida → error", async () => {
    expect((await executeTool("borrar_todo", {}, ctx())).isError).toBe(true);
  });
});

describe("ficha y briefing", () => {
  it("campos pendientes", () => {
    expect(missingFields({ full_name: "Lucía", project_type: "reforma_integral", surface_m2: 90 })).toEqual([
      "address",
      "property_state",
      "goals",
      "budget_range",
      "desired_timeline",
      "contact_preference",
    ]);
  });
  it("markdown → HTML seguro para el email", () => {
    const html = markdownToHtml("## Resumen\nCliente **Lucía** <script>\n- Cocina abierta\n- Más luz\n\n[Expediente](https://x.app/inbox/1)");
    expect(html).toContain("<h3");
    expect(html).toContain("<strong>Lucía</strong>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<li>Cocina abierta</li>");
    expect(html).toContain('<a href="https://x.app/inbox/1">Expediente</a>');
  });
});
