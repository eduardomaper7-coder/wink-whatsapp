/**
 * Prueba de extremo a extremo contra una base de datos real (PostgREST/Supabase) con la migración aplicada:
 * ingesta → cola → procesado → mensajes, conversación, estados, idempotencia.
 *
 * Solo se ejecuta si defines:
 *   SUPABASE_E2E_URL=http://…   SUPABASE_E2E_SERVICE_KEY=…
 * ⚠️ Escribe datos: úsala contra un proyecto de pruebas, nunca producción.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { runJobs } from "@/lib/jobs/runner";
import { ingestWebhook } from "@/lib/whatsapp/inbound/ingest";
import { fixtureRaw } from "../helpers/fixtures";

const URL = process.env.SUPABASE_E2E_URL;
const KEY = process.env.SUPABASE_E2E_SERVICE_KEY;

describe.skipIf(!URL || !KEY)("E2E con base de datos real", () => {
  let db: SupabaseClient;
  beforeAll(() => {
    db = createClient(URL!, KEY!, { auth: { persistSession: false } });
  });
  const ingest = (name: string) => {
    const raw = fixtureRaw(name);
    return ingestWebhook(db, raw, JSON.parse(raw));
  };

  it("procesa texto, imagen y botones; deduplica el reintento de Meta", async () => {
    const first = await ingest("text");
    const retry = await ingest("text"); // mismo cuerpo → mismo evento, sin trabajo nuevo
    expect(retry.eventId).toBe(first.eventId);
    await ingest("image");
    await ingest("interactive_button_reply");
    await ingest("unsupported");

    const r = await runJobs({ db, maxJobs: 20, budgetMs: 20_000 });
    expect(r.claimed).toBeGreaterThanOrEqual(4);

    const { data: contact } = await db.from("contacts").select("id, wa_id, profile_name").eq("wa_id", "34612345678").single();
    const { data: conv } = await db.from("conversations").select("id, unread_count, last_inbound_at, status, agent_active").eq("contact_id", contact!.id).single();
    const { data: msgs } = await db.from("messages").select("type, status, media_status, wa_message_id, text_preview").eq("conversation_id", conv!.id).order("wa_timestamp");
    expect(msgs?.map((m) => m.type).sort()).toEqual(["image", "interactive", "text", "unsupported"]);
    expect(msgs?.find((m) => m.type === "image")?.media_status).toBe("pending");

    expect(conv).toMatchObject({ unread_count: 4, status: "bot", agent_active: true });
    expect(conv!.last_inbound_at).toBeTruthy();

    expect(contact).toMatchObject({ wa_id: "34612345678", profile_name: "Lucía Martín" });

    // Trabajo de descarga encolado una sola vez
    const { data: mediaJobs } = await db.from("jobs").select("type, status, dedupe_key").eq("type", "download_media").like("dedupe_key", "media:wamid.IMAGE%");
    expect(mediaJobs).toHaveLength(1);
  });

  it("aplica estados en orden correcto y difiere los de mensajes desconocidos", async () => {
    const { data: contact } = await db.from("contacts").select("id").eq("wa_id", "34612345678").single();
    const { data: conv } = await db.from("conversations").select("id").eq("contact_id", contact!.id).single();
    await db.from("messages").insert({
      conversation_id: conv!.id, direction: "outbound", author: "agent", type: "interactive",
      wa_message_id: "wamid.OUTBOUND_SLOTS_0001", status: "sent",
    });
    await ingest("statuses");
    await ingest("status_failed");
    await ingest("reaction");
    await runJobs({ db, maxJobs: 20, budgetMs: 20_000 });

    const { data: out } = await db.from("messages").select("status, customer_reaction").eq("wa_message_id", "wamid.OUTBOUND_SLOTS_0001").single();
    expect(out).toEqual({ status: "read", customer_reaction: "👍" });

    const { data: deferred } = await db.from("jobs").select("status").eq("type", "apply_status").like("dedupe_key", "status:wamid.OUTBOUND_FAILED_0001%");
    expect(deferred).toHaveLength(1);
    expect(deferred![0]!.status).toBe("queued");
  });
});
