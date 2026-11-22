/**
 * Chat de terminal con el agente REAL (Claude) sin necesitar WhatsApp/Meta.
 * Usa la base de datos de .env.local y no envía nada a Meta (WHATSAPP_DRY_RUN).
 *
 *   npm run agent:chat                 # cliente de prueba +34 600 000 999
 *   npm run agent:chat -- 34600111222  # otro número (otra conversación)
 *   Escribe "/boton <n>" para pulsar el botón n del último mensaje, "/salir" para terminar.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

for (const line of existsSync(".env.local") ? readFileSync(path.resolve(".env.local"), "utf8").split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}
process.env.WHATSAPP_DRY_RUN = "true";
process.env.LOG_LEVEL ??= "warn";

const { supabaseAdmin } = await import("../src/lib/supabase/admin");
const { ingestWebhook } = await import("../src/lib/whatsapp/inbound/ingest");
const { runJobs } = await import("../src/lib/jobs/runner");
const { env } = await import("../src/lib/env");

const db = supabaseAdmin();
const waId = (process.argv[2] ?? "34600000999").replace(/\D/g, "");
let lastButtons: Array<{ id: string; title: string }> = [];
let since = new Date().toISOString();

async function send(m: Record<string, unknown>) {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{ id: "chat", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "chat", phone_number_id: env().WHATSAPP_PHONE_NUMBER_ID }, contacts: [{ wa_id: waId, profile: { name: "Cliente de prueba" } }], messages: [{ from: waId, id: `wamid.CHAT${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...m }] } }] }],
  };
  await ingestWebhook(db, JSON.stringify(payload), payload);
  await runJobs({ db, maxJobs: 10, budgetMs: 10_000 });
  await db.from("jobs").update({ run_after: new Date().toISOString() }).eq("type", "agent_reply").eq("status", "queued");
  for (let i = 0; i < 4; i++) await runJobs({ db, maxJobs: 20, budgetMs: 60_000 });

  const { data: c } = await db.from("contacts").select("id").eq("wa_id", waId).single();
  const { data: conv } = await db.from("conversations").select("id, status").eq("contact_id", c!.id).single();
  const { data: out } = await db.from("messages").select("type, content, text_preview, created_at").eq("conversation_id", conv!.id).eq("direction", "outbound").gt("created_at", since).order("created_at");
  for (const o of out ?? []) {
    console.log(`\n\x1b[36mWink:\x1b[0m ${o.text_preview}`);
    const b = (o.content as { buttons?: Array<{ id: string; title: string }> }).buttons;
    const rows = (o.content as { sections?: Array<{ rows: Array<{ id: string; title: string }> }> }).sections?.flatMap((s) => s.rows);
    if (b || rows) {
      lastButtons = b ?? rows ?? [];
      lastButtons.forEach((x, i) => console.log(`   [${i + 1}] ${x.title}`));
    }
    since = o.created_at as string;
  }
  if (conv!.status === "human") console.log("\n\x1b[33m(La conversación ha pasado a una persona del equipo: el agente está pausado.)\x1b[0m");
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`Chat con el agente de Wink como +${waId}. "/boton n" pulsa un botón, "/salir" termina.\n`);
for (;;) {
  let line: string;
  try {
    line = (await rl.question("\x1b[32mTú:\x1b[0m ")).trim();
  } catch {
    break; // entrada cerrada
  }
  if (!line) continue;
  if (line === "/salir") break;
  const btn = line.match(/^\/boton\s+(\d+)$/);
  if (btn) {
    const b = lastButtons[Number(btn[1]) - 1];
    if (!b) {
      console.log("No hay ese botón.");
      continue;
    }
    await send({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: b.id, title: b.title } } });
  } else {
    await send({ type: "text", text: { body: line } });
  }
}
rl.close();
process.exit(0);
