/**
 * Envía un webhook firmado (como lo haría Meta) a tu entorno local o desplegado.
 *
 *   npm run simulate -- text                      # fixture tests/fixtures/webhooks/text.json
 *   npm run simulate -- image --url https://…/api/webhooks/whatsapp
 *   npm run simulate -- text --keep-id            # repite el mismo wamid (prueba de idempotencia)
 *   npm run simulate -- text --from 34600111222 --text "Hola, quiero reformar mi piso"
 *
 * Lee WHATSAPP_APP_SECRET y WHATSAPP_PHONE_NUMBER_ID de .env.local.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";

function loadEnvFile(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
  }
}
loadEnvFile(path.resolve(".env.local"));

const args = process.argv.slice(2);
const fixture = args.find((a) => !a.startsWith("--")) ?? "text";
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = opt("url") ?? "http://localhost:3000/api/webhooks/whatsapp";
const secret = process.env.WHATSAPP_APP_SECRET;
const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
if (!secret || !phoneId) {
  console.error("Faltan WHATSAPP_APP_SECRET / WHATSAPP_PHONE_NUMBER_ID en .env.local");
  process.exit(1);
}

const payload = JSON.parse(readFileSync(path.resolve("tests/fixtures/webhooks", `${fixture}.json`), "utf8"));
const now = String(Math.floor(Date.now() / 1000));
for (const entry of payload.entry ?? []) {
  for (const change of entry.changes ?? []) {
    const v = change.value;
    if (v.metadata) v.metadata.phone_number_id = phoneId;
    for (const m of v.messages ?? []) {
      if (!args.includes("--keep-id")) m.id = `wamid.SIM${randomBytes(12).toString("hex").toUpperCase()}`;
      m.timestamp = now;
      if (opt("from")) m.from = opt("from");
      if (opt("text") && m.text) m.text.body = opt("text");
    }
    for (const c of v.contacts ?? []) if (opt("from")) c.wa_id = opt("from");
    for (const s of v.statuses ?? []) s.timestamp = now;
  }
}

const body = JSON.stringify(payload);
const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature }, body });
console.log(`${res.status} ${res.statusText} ← ${fixture} → ${url}`);
console.log(await res.text());
