/**
 * E2E del envío contra una base de datos real (PostgREST/Supabase) con Meta simulada.
 * Solo se ejecuta con SUPABASE_E2E_URL y SUPABASE_E2E_SERVICE_KEY (proyecto DE PRUEBAS).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runJobs } from "@/lib/jobs/runner";
import { ingestWebhook } from "@/lib/whatsapp/inbound/ingest";
import { ValidationError } from "@/lib/whatsapp/outbound/schema";
import { SendRejectedError, sendMessage, WindowClosedError } from "@/lib/whatsapp/outbound/service";

const URL = process.env.SUPABASE_E2E_URL;
const KEY = process.env.SUPABASE_E2E_SERVICE_KEY;

type MetaReply = { status: number; body: unknown } | "network_error";
const metaCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
let metaReplies: MetaReply[] = [];
let autoId = 0;
const realFetch = globalThis.fetch;

function mockMeta() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://graph.facebook.com/")) return realFetch(input, init);
    metaCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const reply = metaReplies.shift() ?? { status: 200, body: { messaging_product: "whatsapp", messages: [{ id: `wamid.AUTO${++autoId}` }] } };
    if (reply === "network_error") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  });
}
const ok = (id: string, waId = "34600000001"): MetaReply => ({ status: 200, body: { messaging_product: "whatsapp", contacts: [{ input: waId, wa_id: waId }], messages: [{ id }] } });
const metaError = (code: number, message: string): MetaReply => ({ status: 400, body: { error: { message, type: "OAuthException", code, fbtrace_id: "Atrace" } } });

describe.skipIf(!URL || !KEY)("E2E envío", () => {
  let db: SupabaseClient;
  let n = 0;

  async function newConversation(lastInboundHoursAgo: number | null = 1, agentActive = true) {
    n++;
    const waId = `3460000${String(n).padStart(4, "0")}`;
    const { data: c } = await db.from("contacts").insert({ wa_id: waId, profile_name: `Cliente ${n}` }).select("id").single();
    const last = lastInboundHoursAgo === null ? null : new Date(Date.now() - lastInboundHoursAgo * 3_600_000).toISOString();
    const { data: conv } = await db
      .from("conversations")
      .insert({ contact_id: c!.id, last_inbound_at: last, agent_active: agentActive, status: "bot", unread_count: 3 })
      .select("id")
      .single();
    return { conversationId: conv!.id as string, waId };
  }
  const forceDue = () => db.from("jobs").update({ run_after: new Date(Date.now() - 1000).toISOString() }).eq("status", "queued");

  beforeAll(() => {
    db = createClient(URL!, KEY!, { auth: { persistSession: false } });
    mockMeta();
  });
  afterEach(() => {
    metaCalls.length = 0;
    metaReplies = [];
  });

  it("texto de una persona: se envía, guarda wamid, pasa a modo humano y pausa el agente", async () => {
    const { conversationId, waId } = await newConversation();
    metaReplies = [ok("wamid.OK1", waId)];
    const msg = await sendMessage(db, { conversationId, content: { type: "text", body: "Hola, soy Marta de Wink" }, author: "human" });

    expect(msg).toMatchObject({ wa_message_id: "wamid.OK1", status: "queued", author: "human", type: "text" });
    expect(metaCalls[0]!.url).toMatch(/\/v26\.0\/106540352242922\/messages$/);
    expect(metaCalls[0]!.body).toMatchObject({ to: waId, type: "text", biz_opaque_callback_data: msg.id });

    const { data: conv } = await db.from("conversations").select("status, agent_active, unread_count, last_message_preview").eq("id", conversationId).single();
    expect(conv).toEqual({ status: "human", agent_active: false, unread_count: 0, last_message_preview: "Hola, soy Marta de Wink" });
    const { data: ev } = await db.from("events").select("type").eq("conversation_id", conversationId);
    expect(ev!.map((e) => e.type).sort()).toEqual(["agent.paused", "message.queued"]);
  });

  it("el agente envía botones sin cambiar el modo de la conversación", async () => {
    const { conversationId } = await newConversation();
    const msg = await sendMessage(db, {
      conversationId,
      author: "agent",
      content: { type: "buttons", body: "¿Qué hueco te viene mejor?", buttons: [{ id: "s1", title: "Lun 24, 10:00" }, { id: "s2", title: "Mar 25, 16:30" }] },
    });
    expect(msg.type).toBe("interactive");
    expect(metaCalls[0]!.body).toMatchObject({ type: "interactive", interactive: { type: "button" } });
    const { data: conv } = await db.from("conversations").select("status, agent_active").eq("id", conversationId).single();
    expect(conv).toEqual({ status: "bot", agent_active: true });
  });

  it("doble clic (mismo clientRef) no duplica el envío", async () => {
    const { conversationId } = await newConversation();
    const a = await sendMessage(db, { conversationId, content: { type: "text", body: "Hola" }, author: "human", clientRef: "ui-abc" });
    const b = await sendMessage(db, { conversationId, content: { type: "text", body: "Hola" }, author: "human", clientRef: "ui-abc" });
    expect(b.id).toBe(a.id);
    expect(metaCalls).toHaveLength(1);
  });

  it("validación: más de 3 botones se rechaza sin guardar ni llamar a Meta", async () => {
    const { conversationId } = await newConversation();
    const buttons = [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `Opción ${i}` }));
    await expect(sendMessage(db, { conversationId, content: { type: "buttons", body: "x", buttons }, author: "agent" })).rejects.toBeInstanceOf(ValidationError);
    const { count } = await db.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId);
    expect(count).toBe(0);
    expect(metaCalls).toHaveLength(0);
  });

  it("ventana cerrada: bloquea texto libre y permite plantillas aprobadas (validando variables)", async () => {
    const { conversationId } = await newConversation(30);
    await db.from("templates").upsert({
      id: "9001",
      name: "retomar_conversacion",
      language: "es",
      category: "UTILITY",
      status: "APPROVED",
      components: [{ type: "BODY", text: "Hola {{1}}, ¿seguimos con tu proyecto de reforma?" }],
    });

    await expect(sendMessage(db, { conversationId, content: { type: "text", body: "Hola" }, author: "human" })).rejects.toBeInstanceOf(WindowClosedError);
    await expect(
      sendMessage(db, { conversationId, content: { type: "template", name: "retomar_conversacion", language: "es" }, author: "human" }),
    ).rejects.toThrow(/Faltan variables/);

    const msg = await sendMessage(db, { conversationId, content: { type: "template", name: "retomar_conversacion", language: "es", body: ["Lucía"] }, author: "human" });
    expect(msg.text_preview).toBe("Hola Lucía, ¿seguimos con tu proyecto de reforma?");
    expect(metaCalls).toHaveLength(1);
    expect(metaCalls[0]!.body).toMatchObject({ type: "template", template: { name: "retomar_conversacion", language: { code: "es" } } });
  });

  it("plantilla no aprobada en caché → rechazo claro", async () => {
    const { conversationId } = await newConversation(30);
    await db.from("templates").upsert({ id: "9002", name: "promo_pausada", language: "es", status: "PAUSED", components: [] });
    await expect(sendMessage(db, { conversationId, content: { type: "template", name: "promo_pausada", language: "es" }, author: "human" })).rejects.toBeInstanceOf(
      SendRejectedError,
    );
  });

  it("límite de envío (130429): queda en cola y se envía en el reintento", async () => {
    const { conversationId } = await newConversation();
    metaReplies = [metaError(130429, "(#130429) Rate limit hit")];
    const msg = await sendMessage(db, { conversationId, content: { type: "text", body: "Te paso los huecos" }, author: "agent" });
    expect(msg).toMatchObject({ wa_message_id: null, status: "queued", error: { code: 130429, kind: "rate_limited", retrying: true } });

    const { data: job } = await db.from("jobs").select("status, run_after").eq("dedupe_key", `send:${msg.id}`).single();
    expect(job!.status).toBe("queued");
    expect(new Date(job!.run_after).getTime()).toBeGreaterThan(Date.now() + 10_000);

    await forceDue();
    metaReplies = [ok("wamid.RETRY_OK")];
    await runJobs({ db, maxJobs: 50, budgetMs: 15_000 });
    const { data: after } = await db.from("messages").select("wa_message_id, error").eq("id", msg.id).single();
    expect(after).toEqual({ wa_message_id: "wamid.RETRY_OK", error: null });
  });

  it("error permanente (131026 número no entregable): falla con motivo en español", async () => {
    const { conversationId } = await newConversation();
    metaReplies = [metaError(131026, "Message Undeliverable")];
    const msg = await sendMessage(db, { conversationId, content: { type: "text", body: "Hola" }, author: "human" });
    expect(msg.status).toBe("failed");
    expect(msg.error).toMatchObject({ code: 131026, kind: "recipient", message_es: expect.stringMatching(/no usa WhatsApp/) });
    const { data: jobs } = await db.from("jobs").select("id").eq("dedupe_key", `send:${msg.id}`);
    expect(jobs).toHaveLength(0);
  });

  it("plantilla pausada por Meta (132015): falla y programa la resincronización de plantillas", async () => {
    const { conversationId } = await newConversation(30);
    metaReplies = [metaError(132015, "Template is paused")];
    const msg = await sendMessage(db, { conversationId, content: { type: "template", name: "sin_cache", language: "es" }, author: "human" });
    expect(msg.status).toBe("failed");
    const { data: sync } = await db.from("jobs").select("type").eq("type", "sync_templates");
    expect(sync!.length).toBeGreaterThanOrEqual(1);
  });

  it("timeout sin respuesta: el webhook de estado recupera el wamid y no se reenvía", async () => {
    const { conversationId } = await newConversation();
    metaReplies = ["network_error"];
    const msg = await sendMessage(db, { conversationId, content: { type: "text", body: "Mensaje con red inestable" }, author: "agent" });
    expect(msg.error).toMatchObject({ kind: "ambiguous", retrying: true });

    // Meta sí lo envió: llega el estado "sent" con nuestro id en biz_opaque_callback_data
    const status = {
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "1", phone_number_id: "106540352242922" }, statuses: [{ id: "wamid.LATE", status: "sent", timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: "1", biz_opaque_callback_data: msg.id }] } }] }],
    };
    const raw = JSON.stringify(status);
    await ingestWebhook(db, raw, status);
    await runJobs({ db, maxJobs: 50, budgetMs: 15_000 }); // llega el estado (segundos después)
    await forceDue(); // …y más tarde vence el reintento (90 s)
    await runJobs({ db, maxJobs: 50, budgetMs: 15_000 });
    const sendsForThisMessage = metaCalls.filter((c) => c.body.biz_opaque_callback_data === msg.id).length;

    const { data: after } = await db.from("messages").select("wa_message_id, status").eq("id", msg.id).single();
    expect(after).toEqual({ wa_message_id: "wamid.LATE", status: "sent" });
    expect(sendsForThisMessage).toBe(1); // solo el intento original: el reintento se omitió
  });

  it("imagen por URL pública", async () => {
    const { conversationId } = await newConversation();
    const msg = await sendMessage(db, { conversationId, author: "human", content: { type: "image", media: { link: "https://wink.es/proyecto.jpg" }, caption: "Un proyecto similar" } });
    expect(msg.wa_message_id).toBeTruthy();
    expect(metaCalls[0]!.body).toMatchObject({ type: "image", image: { link: "https://wink.es/proyecto.jpg", caption: "Un proyecto similar" } });
  });
});
