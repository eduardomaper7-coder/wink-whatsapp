/**
 * E2E de notificaciones push contra base de datos real (PUSH_TRANSPORT=log: no sale nada a internet).
 * Solo con SUPABASE_E2E_URL y SUPABASE_E2E_SERVICE_KEY (proyecto DE PRUEBAS).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyHandoff } from "@/lib/agent/tools";
import { runJobs } from "@/lib/jobs/runner";
import { capturedPushes } from "@/lib/notify/push";
import { ingestWebhook } from "@/lib/whatsapp/inbound/ingest";

const URL = process.env.SUPABASE_E2E_URL;
const KEY = process.env.SUPABASE_E2E_SERVICE_KEY;
const MARTA = "aaaaaaaa-0000-0000-0000-000000000001";
const ALFONSO = "aaaaaaaa-0000-0000-0000-000000000002";
const INACTIVO = "aaaaaaaa-0000-0000-0000-000000000003";

describe.skipIf(!URL || !KEY)("E2E notificaciones push", () => {
  let db: SupabaseClient;
  let n = 0;

  async function inbound(waId: string, text: string) {
    const payload = {
      object: "whatsapp_business_account",
      entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "1", phone_number_id: "106540352242922" }, contacts: [{ wa_id: waId, profile: { name: "Cliente Push" } }], messages: [{ from: waId, id: `wamid.PUSH${Date.now()}${++n}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }],
    };
    await ingestWebhook(db, JSON.stringify(payload), payload);
    await runJobs({ db, maxJobs: 30, budgetMs: 10_000 });
  }
  const conversationOf = async (waId: string) => {
    const { data: c } = await db.from("contacts").select("id").eq("wa_id", waId).single();
    return (await db.from("conversations").select("id").eq("contact_id", c!.id).single()).data!.id as string;
  };

  beforeAll(async () => {
    db = createClient(URL!, KEY!, { auth: { persistSession: false } });
    // Equipo: dos activos (cada uno con un dispositivo) y uno inactivo
    for (const [id, name, active, role] of [[MARTA, "Marta", true, "admin"], [ALFONSO, "Alfonso", true, "agent"], [INACTIVO, "Ex", false, "agent"]] as const) {
      await db.from("profiles").upsert({ id, full_name: name, active, role, email: `${name}@wink.test` });
      await db.from("push_subscriptions").upsert({ user_id: id, endpoint: `https://push.example.com/${id}`, p256dh: "BKey-p256dh-xxxxxxxx", auth: "auth-xxxx" }, { onConflict: "endpoint" });
    }
  });
  beforeEach(() => {
    capturedPushes.length = 0;
  });

  it("derivación del asistente → aviso a todo el equipo activo (no a inactivos)", async () => {
    const wa = "34622000001";
    await inbound(wa, "Hola");
    const conv = await conversationOf(wa);
    await db.from("jobs").delete().eq("type", "agent_reply"); // aquí no probamos el agente
    await applyHandoff(db, conv, null, "urgencia", "Filtración en el baño de su obra en curso.", true, "agent");
    await runJobs({ db, maxJobs: 30, budgetMs: 10_000 });
    expect(capturedPushes.map((p) => p.userId).sort()).toEqual([MARTA, ALFONSO].sort());
    expect(capturedPushes[0]!.payload).toMatchObject({ title: "Urgente · Cliente Push tiene una urgencia", url: `/inbox/${conv}`, urgent: true, tag: `conv:${conv}` });
  });

  it("mensaje en conversación asignada en modo equipo → solo a la persona asignada", async () => {
    const wa = "34622000002";
    await inbound(wa, "Hola");
    const conv = await conversationOf(wa);
    await db.from("jobs").delete().eq("type", "agent_reply");
    await db.from("conversations").update({ status: "human", agent_active: false, assigned_to: ALFONSO }).eq("id", conv);
    capturedPushes.length = 0;
    await inbound(wa, "¿Me podéis llamar esta tarde?");
    expect(capturedPushes).toHaveLength(1);
    expect(capturedPushes[0]).toMatchObject({ userId: ALFONSO, payload: { title: "Cliente Push", body: "¿Me podéis llamar esta tarde?", url: `/inbox/${conv}` } });
    expect(capturedPushes[0]!.payload.badge).toBeGreaterThanOrEqual(1);
  });

  it("sin asignar → a todo el equipo; con el asistente atendiendo → nadie", async () => {
    const wa = "34622000003";
    await inbound(wa, "Hola");
    expect(capturedPushes).toHaveLength(0); // asistente atendiendo
    const conv = await conversationOf(wa);
    await db.from("jobs").delete().eq("type", "agent_reply");
    await db.from("conversations").update({ status: "human", agent_active: false, assigned_to: null }).eq("id", conv);
    await inbound(wa, "¿Hola?");
    expect(capturedPushes.map((p) => p.userId).sort()).toEqual([MARTA, ALFONSO].sort());
  });
});
