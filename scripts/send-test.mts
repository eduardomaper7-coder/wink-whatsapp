/**
 * Prueba de envío real (sin interfaz) contra Meta + Supabase configurados en .env.local.
 *
 *   npm run send:test -- 34600111222 "Hola, esto es una prueba"     # texto (ventana abierta)
 *   npm run send:test -- 34600111222 --template hello_world en_US    # plantilla (ventana cerrada)
 *   npm run send:test -- 34600111222 --buttons                       # botones de ejemplo
 *   npm run send:test -- --sync-templates                            # sincroniza plantillas
 *
 * Con el número de prueba de Meta, el destinatario debe estar en la lista de
 * números permitidos y, para texto libre, haber escrito antes (ventana de 24 h).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

for (const line of existsSync(".env.local") ? readFileSync(path.resolve(".env.local"), "utf8").split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}

const { supabaseAdmin } = await import("../src/lib/supabase/admin");
const { sendMessage } = await import("../src/lib/whatsapp/outbound/service");
const { syncTemplates } = await import("../src/lib/whatsapp/outbound/templates");

const db = supabaseAdmin();
const args = process.argv.slice(2);

if (args.includes("--sync-templates")) {
  console.log(await syncTemplates(db));
  process.exit(0);
}

const waId = args[0]?.replace(/\D/g, "");
if (!waId) {
  console.error("Uso: npm run send:test -- <teléfono> \"texto\" | --template <nombre> <idioma> | --buttons");
  process.exit(1);
}

const { data: contact } = await db.from("contacts").upsert({ wa_id: waId }, { onConflict: "wa_id" }).select("id").single();
await db.from("conversations").upsert({ contact_id: contact!.id }, { onConflict: "contact_id", ignoreDuplicates: true });
const { data: conv } = await db.from("conversations").select("id").eq("contact_id", contact!.id).single();

let content: unknown;
const t = args.indexOf("--template");
if (t >= 0) content = { type: "template", name: args[t + 1] ?? "hello_world", language: args[t + 2] ?? "en_US" };
else if (args.includes("--buttons"))
  content = {
    type: "buttons",
    body: "Prueba de Wink: ¿qué hueco te viene mejor para la visita técnica?",
    footer: "Wink · Arquitectura e interiorismo",
    buttons: [
      { id: "slot_test_1", title: "Lun 10:00" },
      { id: "slot_test_2", title: "Mar 16:30" },
      { id: "slot_none", title: "Ninguno me va" },
    ],
  };
else content = { type: "text", body: args.slice(1).join(" ") || "Hola, esto es una prueba de Wink." };

try {
  const msg = await sendMessage(db, { conversationId: conv!.id, content, author: "system" });
  console.log(msg.status === "failed" ? "✗ Falló:" : "✓ Aceptado por WhatsApp:", { id: msg.id, wamid: msg.wa_message_id, status: msg.status, error: msg.error });
} catch (e) {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
}
