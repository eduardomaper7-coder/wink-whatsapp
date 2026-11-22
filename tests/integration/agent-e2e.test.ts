/**
 * E2E del agente: base de datos real (PostgREST/Supabase), Claude y Meta simulados.
 * Solo con SUPABASE_E2E_URL y SUPABASE_E2E_SERVICE_KEY (proyecto DE PRUEBAS).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SAFE_PRICE_REPLY } from "@/lib/agent/guardrails";
import { runJobs } from "@/lib/jobs/runner";
import { capturedEmails } from "@/lib/notify/email";
import { ingestWebhook } from "@/lib/whatsapp/inbound/ingest";

const URL = process.env.SUPABASE_E2E_URL;
const KEY = process.env.SUPABASE_E2E_SERVICE_KEY;
const PRIVACY = "https://winkgroup.es/politica-de-privacidad";

// ------------------------------------------------------------ Claude simulado
type Req = { model: string; system?: Array<{ text: string }>; messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; temperature?: unknown; tool_choice?: unknown };
type Script = (req: Req) => Record<string, unknown>;
let chatScript: Script[] = [];
let classification: Record<string, unknown> = { categoria: "cliente_potencial", pide_humano: false, molesto: false, urgente: false, confianza: 0.9, resumen: "Interesado en reforma" };
const chatRequests: Req[] = [];
let onChatCall: (() => Promise<void>) | null = null;
const metaSends: Array<Record<string, unknown>> = [];
let wamidSeq = 0;

const textReply = (text: string) => ({ id: "msg", model: "m", stop_reason: "end_turn", content: text ? [{ type: "text", text }] : [], usage: { input_tokens: 100, output_tokens: 20 } });
const toolReply = (calls: Array<{ name: string; input: Record<string, unknown> }>) => ({
  id: "msg",
  model: "m",
  stop_reason: "tool_use",
  content: [{ type: "thinking", thinking: "", signature: "sig" }, ...calls.map((c, i) => ({ type: "tool_use", id: `tu_${Date.now()}_${i}`, name: c.name, input: c.input }))],
  usage: { input_tokens: 100, output_tokens: 20 },
});
/** Último resultado de herramienta (JSON) que recibió Claude. */
const lastToolResult = (req: Req, idx = 0): Record<string, unknown> => {
  const last = req.messages.at(-1)!;
  const blocks = last.content as Array<{ type: string; content: string }>;
  return JSON.parse(blocks.filter((b) => b.type === "tool_result")[idx]!.content);
};
const lastUserText = (req: Req) => {
  const users = req.messages.filter((m) => m.role === "user" && typeof m.content === "string");
  return String(users.at(-1)?.content ?? "");
};

function installMocks() {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.anthropic.com/")) {
      const req = JSON.parse(String(init!.body)) as Req;
      if (req.model.includes("haiku")) return json({ ...textReply(JSON.stringify(classification)) });
      if (req.model.includes("opus")) return json(textReply("## Resumen\nLucía quiere una reforma integral de 90 m² en Chamberí.\n\n## Documentación recibida\n- Ninguna"));
      chatRequests.push(req);
      if (onChatCall) {
        const f = onChatCall;
        onChatCall = null;
        await f();
      }
      const step = chatScript.shift();
      if (!step) throw new Error("Guion de Claude agotado");
      return json(step(req));
    }
    if (url.startsWith("https://graph.facebook.com/")) {
      const body = JSON.parse(String(init!.body));
      metaSends.push(body);
      return json({ messaging_product: "whatsapp", messages: [{ id: `wamid.AGENT${++wamidSeq}` }] });
    }
    return realFetch(input, init);
  });
}
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });

describe.skipIf(!URL || !KEY)("E2E agente", () => {
  let db: SupabaseClient;
  let seq = 0;

  async function inbound(waId: string, kind: { text?: string; button?: { id: string; title: string } }) {
    const now = String(Math.floor(Date.now() / 1000));
    const m: Record<string, unknown> = { from: waId, id: `wamid.IN${Date.now()}${++seq}`, timestamp: now };
    if (kind.text) Object.assign(m, { type: "text", text: { body: kind.text } });
    if (kind.button) Object.assign(m, { type: "interactive", interactive: { type: "button_reply", button_reply: kind.button } });
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "1", phone_number_id: "106540352242922" }, contacts: [{ wa_id: waId, profile: { name: "Lucía M." } }], messages: [m] } }] }],
    };
    await ingestWebhook(db, JSON.stringify(payload), payload);
    await runJobs({ db, maxJobs: 20, budgetMs: 10_000 }); // procesa el webhook (programa el agente a +6 s)
  }
  async function runAgentNow() {
    await db.from("jobs").update({ run_after: new Date(Date.now() - 1000).toISOString() }).eq("type", "agent_reply").eq("status", "queued");
    return runJobs({ db, maxJobs: 20, budgetMs: 20_000 });
  }
  const convOf = async (waId: string) => {
    const { data: c } = await db.from("contacts").select("id, consent_notice_sent_at, consent_at, name").eq("wa_id", waId).single();
    const { data: conv } = await db.from("conversations").select("*").eq("contact_id", c!.id).single();
    return { contact: c!, conv: conv! };
  };
  const outboundOf = async (convId: string) =>
    (await db.from("messages").select("type, author, content, text_preview, wa_message_id").eq("conversation_id", convId).eq("direction", "outbound").order("created_at")).data ?? [];

  beforeAll(() => {
    db = createClient(URL!, KEY!, { auth: { persistSession: false } });
    installMocks();
  });
  beforeEach(() => {
    chatScript = [];
    chatRequests.length = 0;
    metaSends.length = 0;
    classification = { categoria: "cliente_potencial", pide_humano: false, molesto: false, urgente: false, confianza: 0.9, resumen: "Interesado en reforma" };
  });

  it("captación completa: ficha → huecos con botones → reserva → briefing por email", async () => {
    const wa = "34611000001";

    // 1) Primer mensaje: guarda datos y responde con aviso de privacidad
    chatScript = [
      () => toolReply([{ name: "actualizar_ficha_cliente", input: { motivo: "El cliente indica tipo, zona y superficie", tipo_proyecto: "reforma_integral", direccion_o_barrio: "Chamberí", superficie_m2: 90 } }]),
      () => textReply("¡Hola! Soy el asistente de Wink, gracias por escribirnos. Una reforma integral en Chamberí suena muy bien. ¿Cómo te llamas?"),
    ];
    await inbound(wa, { text: "Hola, quiero hacer una reforma integral de mi piso en Chamberí, unos 90 m2" });
    await runAgentNow();

    let { conv, contact } = await convOf(wa);
    const { data: lead1 } = await db.from("leads").select("*").eq("conversation_id", conv.id).single();
    expect(lead1).toMatchObject({ project_type: "reforma_integral", address: "Chamberí", status: "qualifying" });
    expect(Number(lead1!.surface_m2)).toBe(90);
    let out = await outboundOf(conv.id);
    expect(out).toHaveLength(1);
    expect(out[0]!.author).toBe("agent");
    expect(String((out[0]!.content as { body: string }).body)).toContain(PRIVACY);
    expect(contact.consent_notice_sent_at).toBeTruthy();

    // La petición a Claude: sistema con prompt + base de conocimiento cacheada, herramientas, sin temperature ni tool_choice forzado
    const req = chatRequests[0]!;
    expect(req.system![0]!.text).toContain("Base de conocimiento de Wink");
    expect(req.system![1]!.text).toContain("Primer contacto? SÍ");
    expect(req.tools).toHaveLength(7);
    expect(req.temperature).toBeUndefined();
    expect(req.tool_choice).toEqual({ type: "auto" });

    // 2) Da nombre y dirección → consulta huecos → ofrece botones
    chatScript = [
      () =>
        toolReply([
          { name: "actualizar_ficha_cliente", input: { motivo: "Da su nombre y dirección", nombre: "Lucía Martín", direccion_o_barrio: "Calle de Fuencarral 120, 3ºB" } },
          { name: "consultar_huecos_disponibles", input: { motivo: "Ya tengo lo necesario para proponer la visita", preferencia: "indiferente" } },
        ]),
      (r) => {
        const huecos = lastToolResult(r, 1).huecos as Array<{ id: string; etiqueta_boton: string }>;
        return toolReply([
          { name: "enviar_opciones", input: { motivo: "Ofrecer los huecos", texto: "Gracias, Lucía. ¿Qué hueco te viene mejor para la visita técnica?", opciones: huecos.map((h) => ({ id: h.id, titulo: h.etiqueta_boton })) } },
        ]);
      },
      () => textReply(""),
    ];
    await inbound(wa, { text: "Soy Lucía Martín, vivo en Calle de Fuencarral 120, 3ºB" });
    await runAgentNow();

    ({ conv, contact } = await convOf(wa));
    expect(contact.name).toBe("Lucía Martín");
    expect(contact.consent_at).toBeTruthy(); // siguió escribiendo tras el aviso
    out = await outboundOf(conv.id);
    expect(out).toHaveLength(2);
    expect(out[1]!.type).toBe("interactive");
    const buttons = (out[1]!.content as { buttons: Array<{ id: string; title: string }> }).buttons;
    expect(buttons).toHaveLength(3);
    expect(buttons[0]!.id).toMatch(/^slot_/);
    expect(metaSends.at(-1)).toMatchObject({ type: "interactive", interactive: { type: "button" } });

    // 3) Pulsa el primer hueco → reserva → confirma
    chatScript = [
      (r) => {
        const id = lastUserText(r).match(/id: (slot_[^)]+)\)/)![1]!;
        return toolReply([{ name: "reservar_visita", input: { motivo: "El cliente eligió hueco", hueco_id: id } }]);
      },
      (r) => textReply(`¡Perfecto, Lucía! Visita confirmada el ${String(lastToolResult(r).visita)} en Calle de Fuencarral 120. El arquitecto llevará preparada tu información.`),
    ];
    capturedEmails.length = 0;
    await inbound(wa, { button: buttons[0]! });
    await runAgentNow();

    const { data: lead3 } = await db.from("leads").select("*").eq("conversation_id", conv.id).single();
    expect(lead3!.status).toBe("visit_scheduled");
    expect(new Date(lead3!.visit_at).toISOString().slice(0, 16)).toBe(buttons[0]!.id.slice(5, 21));
    expect(lead3!.visit_calendar_event_id).toMatch(/^demo_/);
    out = await outboundOf(conv.id);
    expect(String(out.at(-1)!.text_preview)).toContain("Visita confirmada");

    // 4) Briefing (modelo potente) + email (puede haberse generado ya en la misma pasada de la cola)
    await runJobs({ db, maxJobs: 20, budgetMs: 20_000 });
    const { data: lead4 } = await db.from("leads").select("briefing_md, briefing_generated_at").eq("id", lead3!.id).single();
    expect(lead4!.briefing_md).toContain("## Resumen");
    expect(capturedEmails).toHaveLength(1);
    expect(capturedEmails[0]!.to).toEqual(["arquitecto@ejemplo.com"]);
    expect(capturedEmails[0]!.subject).toMatch(/^Visita técnica .* Lucía Martín/);
    expect(capturedEmails[0]!.html).toContain("<h3");

    // Auditoría: cada ejecución con herramientas y motivo
    const { data: runs } = await db.from("agent_runs").select("outcome, tool_calls, model").eq("conversation_id", conv.id).order("created_at");
    expect(runs!.map((r) => r.outcome)).toEqual(["replied", "replied", "replied"]);
    const names = (runs![1]!.tool_calls as Array<{ name: string; motivo: string }>).map((t) => t.name);
    expect(names).toEqual(["clasificacion", "actualizar_ficha_cliente", "consultar_huecos_disponibles", "enviar_opciones"]);
    expect((runs![2]!.tool_calls as Array<{ motivo: string }>)[1]!.motivo).toBe("El cliente eligió hueco");
    const { data: ev } = await db.from("events").select("type").eq("conversation_id", conv.id);
    expect(ev!.map((e) => e.type)).toEqual(expect.arrayContaining(["lead.created", "lead.updated", "visit.booked", "briefing.generated", "briefing.email_skipped"]));
  });

  it("salvaguarda: si el modelo da un precio, se sustituye por un mensaje seguro", async () => {
    const wa = "34611000002";
    chatScript = [() => textReply("Una reforma integral suele salir a 1.000 €/m2 aproximadamente.")];
    await inbound(wa, { text: "¿Cuánto cuesta reformar un piso de 80 metros?" });
    await runAgentNow();
    const { conv } = await convOf(wa);
    const out = await outboundOf(conv.id);
    expect(String((out[0]!.content as { body: string }).body)).toContain(SAFE_PRICE_REPLY);
    expect(String((out[0]!.content as { body: string }).body)).not.toMatch(/1\.000/);
    const { data: ev } = await db.from("events").select("type").eq("conversation_id", conv.id).eq("type", "agent.guardrail");
    expect(ev).toHaveLength(1);
  });

  it("derivación obligatoria (pide una persona): pausa el agente, avisa al equipo y no llama al modelo conversacional", async () => {
    const wa = "34611000003";
    classification = { categoria: "cliente_potencial", pide_humano: true, molesto: false, urgente: false, confianza: 0.95, resumen: "Quiere hablar con una persona" };
    await inbound(wa, { text: "No quiero hablar con un bot, pásame con alguien" });
    await runAgentNow();
    const { conv } = await convOf(wa);
    expect(conv).toMatchObject({ status: "human", agent_active: false, handoff_reason: "lo_pide_cliente" });
    expect(chatRequests).toHaveLength(0);
    const out = await outboundOf(conv.id);
    expect(String(out[0]!.text_preview)).toContain("te paso con una persona del equipo");
    const { data: ev } = await db.from("events").select("type, data").eq("conversation_id", conv.id).eq("type", "agent.handoff").single();
    expect(ev!.data).toMatchObject({ categoria: "lo_pide_cliente", resumen: "Quiere hablar con una persona" });

    // Con el agente pausado, los siguientes mensajes no lo disparan
    await inbound(wa, { text: "¿Hola?" });
    const { data: jobs } = await db.from("jobs").select("id").eq("type", "agent_reply").eq("status", "queued").eq("payload->>conversationId", conv.id);
    expect(jobs).toHaveLength(0);
  });

  it("ráfaga de mensajes: una sola respuesta que tiene en cuenta todos", async () => {
    const wa = "34611000004";
    chatScript = [() => textReply("¡Hola! Soy el asistente de Wink. ¿Qué te gustaría cambiar en la cocina y el baño?")];
    await inbound(wa, { text: "Hola" });
    await inbound(wa, { text: "Quiero reformar cocina y baño" });
    await inbound(wa, { text: "Es en Retiro" });
    const { conv } = await convOf(wa);
    const { data: jobs } = await db.from("jobs").select("id").eq("type", "agent_reply").eq("status", "queued").eq("payload->>conversationId", conv.id);
    expect(jobs).toHaveLength(1);
    await runAgentNow();
    expect(chatRequests).toHaveLength(1);
    expect(lastUserText(chatRequests[0]!)).toBe("Hola\nQuiero reformar cocina y baño\nEs en Retiro");
    expect(await outboundOf(conv.id)).toHaveLength(1);
  });

  it("si el cliente escribe mientras el agente piensa, se descarta la respuesta y se contesta a todo junto", async () => {
    const wa = "34611000005";
    await inbound(wa, { text: "Hola, quiero información" });
    onChatCall = async () => {
      await inbound(wa, { text: "Perdona, es para un ático en Salamanca" });
    };
    chatScript = [() => textReply("¡Hola! ¿Qué proyecto tienes en mente?"), () => textReply("¡Hola! Un ático en Salamanca, qué bien. ¿Qué te gustaría hacer?")];
    const first = await runAgentNow();
    const { conv } = await convOf(wa);
    expect(await outboundOf(conv.id)).toHaveLength(0);
    const { data: runs } = await db.from("agent_runs").select("outcome").eq("conversation_id", conv.id);
    expect(runs!.map((r) => r.outcome)).toEqual(["superseded"]);
    void first;

    await runAgentNow();
    const out = await outboundOf(conv.id);
    expect(out).toHaveLength(1);
    expect(String(out[0]!.text_preview)).toContain("ático en Salamanca");
    expect(lastUserText(chatRequests.at(-1)!)).toContain("Perdona, es para un ático en Salamanca");
  });

  it("reservar sin dirección completa devuelve error al modelo para que la pida", async () => {
    const wa = "34611000006";
    chatScript = [
      () => toolReply([{ name: "consultar_huecos_disponibles", input: { motivo: "proponer visita" } }]),
      (r) => {
        const huecos = lastToolResult(r).huecos as Array<{ id: string }>;
        return toolReply([{ name: "reservar_visita", input: { motivo: "prueba", hueco_id: huecos[0]!.id } }]);
      },
      (r) => {
        const res = lastToolResult(r);
        expect(String(res.error)).toContain("dirección completa");
        return textReply("Para reservar necesito la dirección completa de la vivienda (calle y número). ¿Me la indicas?");
      },
    ];
    await inbound(wa, { text: "Quiero una visita ya" });
    await runAgentNow();
    const { conv } = await convOf(wa);
    const { data: lead } = await db.from("leads").select("visit_at").eq("conversation_id", conv.id).single();
    expect(lead!.visit_at).toBeNull();
    const { data: runs } = await db.from("agent_runs").select("tool_calls").eq("conversation_id", conv.id).single();
    expect((runs!.tool_calls as Array<{ name: string; is_error: boolean }>).find((t) => t.name === "reservar_visita")!.is_error).toBe(true);
  });
});
