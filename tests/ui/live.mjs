/**
 * Prueba del panel en directo (/live) a 1920×1080, como en un proyector.
 * Simula un cliente nuevo escribiendo (inserciones directas en la BD de pruebas)
 * y comprueba que el panel lo sigue solo y que el expediente se rellena.
 *   BASE_URL=http://localhost:3200 PGDB=wink_ui OUT=/tmp/shots node tests/ui/live.mjs
 */
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3200";
const OUT = process.env.OUT ?? "/tmp/shots";
const DB = process.env.PGDB ?? "wink_ui";
const sql = (q) => execFileSync("sudo", ["-u", "postgres", "psql", "-d", DB, "-Atqc", q], { encoding: "utf8" }).trim();
const results = [];
const errors = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);

// limpieza de una ejecución anterior
sql("delete from contacts where wa_id = '34611222333'");

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: "es-ES", timezoneId: "Europe/Madrid" });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && !/WebSocket|realtime|ERR_CONNECTION|404/i.test(m.text()) && errors.push(`console: ${m.text()}`));

await page.goto(`${BASE}/live`);
await page.waitForURL(/\/login/);
await page.fill("#email", "marta@wink.test");
await page.fill("#password", "demo-demo");
await page.click("button:has-text('Entrar')");
await page.waitForURL(/\/live/, { timeout: 15000 });
check("el login devuelve al panel", page.url().endsWith("/live"));
await page.waitForSelector(".live-chat .bubble", { timeout: 15000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/live-1-inicial.png` });
check("sin barra lateral de la app", (await page.locator(".rail").count()) === 0);
check("QR con el número de demo", (await page.locator(".live-qr svg").count()) === 1);
const noScroll = await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1);
check("cabe en 1920×1080 sin desplazamiento", noScroll);

// ---- llega un cliente nuevo
const conv = sql(`
  with c as (insert into contacts (wa_id, profile_name) values ('34611222333', 'Javier Ortega') returning id),
       v as (insert into conversations (contact_id, status, agent_active, last_inbound_at, last_message_at, last_message_preview, unread_count)
             select id, 'bot', true, now(), now(), 'Hola, quiero reformar', 1 from c returning id)
  select id from v`);
sql(`insert into messages (conversation_id, direction, author, type, content, text_preview, status, wa_message_id)
     values ('${conv}', 'inbound', 'customer', 'text', '{"body":"Hola, quiero reformar la cocina de mi piso en Retiro"}', 'Hola, quiero reformar', 'received', 'wamid.live1')`);
const followed = await page.waitForSelector(".live-chat-head b:has-text('Javier Ortega')", { timeout: 12000 }).then(() => true, () => false);
check("sigue solo al cliente que acaba de escribir", followed);
check("indicador «escribiendo» del asistente", (await page.locator(".live-typing").count()) === 1);
await page.screenshot({ path: `${OUT}/live-2-nuevo-cliente.png` });

// ---- responde el asistente y rellena el expediente
sql(`insert into messages (conversation_id, direction, author, type, content, text_preview, status, wa_message_id)
     values ('${conv}', 'outbound', 'agent', 'text', '{"body":"¡Hola Javier! Soy el asistente de Wink. ¿Me cuentas cuántos m² tiene la cocina?"}', '¡Hola Javier!', 'delivered', 'wamid.live2')`);
const lead = sql(`insert into leads (contact_id, conversation_id, full_name, project_type, address)
                  select contact_id, id, 'Javier Ortega', 'reforma_parcial', 'Calle Ibiza, Retiro (Madrid)' from conversations where id = '${conv}' returning id`);
sql(`insert into events (type, actor, conversation_id, lead_id, data) values ('lead.updated', 'agent', '${conv}', '${lead}', '{"fields":["full_name","project_type","address"]}')`);
const filled = await page.waitForSelector(".live-field.is-filled dd:has-text('Calle Ibiza')", { timeout: 12000 }).then(() => true, () => false);
check("el expediente se rellena en directo", filled);
check("el indicador desaparece cuando responde", (await page.locator(".live-typing").count()) === 0);
const ticker = await page.waitForSelector(".live-act.is-new:has-text('Ficha actualizada')", { timeout: 8000 }).then(() => true, () => false);
check("la acción del agente aparece en el teletipo", ticker);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/live-3-expediente.png` });

// ---- se actualiza un campo: resaltado
sql(`update leads set surface_m2 = 14 where id = '${lead}'`);
const fresh = await page.waitForSelector(".live-field.is-fresh", { timeout: 12000 }).then(() => true, () => false);
check("el campo nuevo se resalta", fresh);

// ---- reserva de visita
sql(`update leads set visit_at = now() + interval '3 days', status = 'visit_scheduled' where id = '${lead}'`);
sql(`insert into events (type, actor, conversation_id, lead_id, data) values ('visit.booked', 'agent', '${conv}', '${lead}', '{"calendar":"demo"}')`);
const visit = await page.waitForSelector(".live-visit", { timeout: 12000 }).then(() => true, () => false);
check("aparece la tarjeta de visita reservada", visit);
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/live-4-visita.png` });

// ---- fijar conversación: no salta a otro cliente
await page.click("button:has-text('Siguiendo al último cliente')");
const other = sql("select c.id from conversations c join contacts k on k.id = c.contact_id where k.wa_id = '34600000001'");
sql(`update conversations set last_inbound_at = now() + interval '1 minute' where id = '${other}'`);
await page.waitForTimeout(4500);
check("fijada, no salta a otro cliente", (await page.locator(".live-chat-head b:has-text('Javier Ortega')").count()) === 1);
await page.click("button:has-text('Fijada')");
const jumped = await page.waitForFunction(() => !document.querySelector(".live-chat-head b")?.textContent?.includes("Javier"), null, { timeout: 12000 }).then(() => true, () => false);
check("al soltarla vuelve a seguir al último", jumped);

check("sin errores en el navegador", errors.length === 0, errors.join(" | "));
await browser.close();
sql("delete from contacts where wa_id = '34611222333'");
sql(`update conversations set last_inbound_at = now() - interval '20 minutes' where id = '${other}'`);
console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("✗")) ? 1 : 0);
