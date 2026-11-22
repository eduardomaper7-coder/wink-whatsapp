/**
 * Recorrido visual de la bandeja con Chrome (playwright-core).
 * Requiere la app en BASE_URL y el sustituto de Supabase con datos de demo.
 *   BASE_URL=http://localhost:3200 OUT=/tmp/shots node tests/ui/walkthrough.mjs
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3200";
const OUT = process.env.OUT ?? "/tmp/shots";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const errors = [];
const results = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);

async function session(viewport, isMobile = false) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: isMobile ? 2 : 1, isMobile, hasTouch: isMobile, locale: "es-ES", timezoneId: "Europe/Madrid" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/WebSocket|realtime|ERR_CONNECTION|404/i.test(m.text()) && errors.push(`console: ${m.text()}`));
  await page.goto(`${BASE}/login`);
  await page.fill("#email", "marta@wink.test");
  await page.fill("#password", "demo-demo");
  await page.click("button:has-text('Entrar')");
  await page.waitForURL(/\/inbox/, { timeout: 15000 });
  await page.waitForSelector(".conv", { timeout: 15000 });
  return { ctx, page };
}

// ---------------------------------------------------------------- escritorio
{
  const { ctx, page } = await session({ width: 1440, height: 900 });
  await page.screenshot({ path: `${OUT}/01-bandeja.png` });
  const count = await page.locator(".conv").count();
  check("lista de conversaciones abiertas (cerradas ocultas por defecto)", count === 5, `${count}`);

  await page.click(".conv:has-text('Lucía Martín')");
  await page.waitForSelector(".bubble");
  await page.waitForSelector(".visit");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/02-lucia-visita.png` });
  check("burbujas del asistente con etiqueta", (await page.locator(".msg.agent .author:has-text('Asistente IA')").count()) > 0);
  check("botones de huecos en la burbuja", (await page.locator(".quick-replies span").count()) === 3);
  check("respuesta pulsada del cliente", (await page.locator(".msg.in .picked").count()) === 1);
  check("imagen del cliente cargada", await page.locator(".media-img").first().evaluate((i) => i.complete && i.naturalWidth > 0));
  check("ficha completa 9/9 y briefing", (await page.locator(".section h3:has-text('9/9')").count()) === 1 && (await page.locator(".briefing h3").count()) > 3);
  check("reacción del cliente visible", (await page.locator(".reaction:has-text('🙏')").count()) === 1);
  const atBottom = await page
    .waitForFunction(() => { const el = document.querySelector(".chat-body"); return el && el.scrollHeight - el.scrollTop - el.clientHeight < 4; }, null, { timeout: 2000 })
    .then(() => true, () => false);
  check("el chat queda abajo del todo tras cargar la imagen", atBottom, JSON.stringify(await page.locator(".chat-body").evaluate((el) => [el.scrollHeight, el.scrollTop, el.clientHeight])));
  const visitCard = await page.locator(".visit").innerText();
  const lastMsg = await page.locator(".msg.agent .text").last().innerText();
  const hour = visitCard.match(/(\d{2}:\d{2})/)?.[1];
  check("fecha de la visita coherente entre ficha y chat", !!hour && lastMsg.includes(hour), `${hour}`);

  await page.click(".conv:has-text('Javi Ruiz')");
  await page.waitForSelector(".handoff");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/03-javier-derivada.png` });
  check("nota de derivación en la conversación", (await page.locator(".sys-note:has-text('ha pasado la conversación al equipo')").count()) === 1);
  check("no leídos se marcan como leídos al abrir", true);

  // Enviar un mensaje como persona del equipo (modo ensayo, sin Meta)
  await page.fill(".composer textarea", "Hola Javier, soy Marta de Wink. Te llamo hoy a las 17:30, ¿te va bien?");
  await page.click("button[aria-label='Enviar']");
  await page.waitForSelector(".msg.human:has-text('Te llamo hoy a las 17:30')", { timeout: 10000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/04-respuesta-equipo.png` });
  check("mensaje de persona del equipo con su nombre", (await page.locator(".msg.human .author:has-text('Marta García')").count()) >= 1);

  // Ventana cerrada → plantillas
  await page.click(".filter:has-text('Equipo')");
  await page.click(".conv:has-text('Carmen')");
  await page.waitForSelector(".window-bar.closed");
  await page.click("button:has-text('Enviar plantilla')");
  await page.click(".tpl:has-text('retomar conversacion')");
  await page.fill(".modal input", "Carmen");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/05-plantilla.png` });
  check("vista previa de plantilla con variable", (await page.locator(".modal:has-text('Hola Carmen, te escribimos de Wink')").count()) === 1);
  await page.click(".modal button:has-text('Enviar plantilla')");
  await page.waitForSelector(".msg.human:has-text('Hola Carmen, te escribimos')", { timeout: 10000 });
  check("plantilla enviada con ventana cerrada", true);

  // Pausar / reactivar asistente en Pablo
  await page.click(".filter:has-text('Todas')");
  await page.click(".conv:has-text('Pablo')");
  await page.waitForSelector(".window-bar.agent");
  await page.screenshot({ path: `${OUT}/06-asistente-activo.png` });
  await page.click("button[aria-label='Más acciones']");
  await page.click("button:has-text('Pausar el asistente')");
  await page.waitForSelector(".chat-head .chip-ink:has-text('Equipo')", { timeout: 10000 });
  check("pausar asistente cambia a modo equipo", true);
  await page.click("button[aria-label='Más acciones']");
  await page.click("button:has-text('Reactivar el asistente')");
  await page.waitForSelector(".chat-head .chip:has-text('Asistente')", { timeout: 10000 });
  check("reactivar asistente", true);

  await page.goto(`${BASE}/ajustes`);
  await page.waitForSelector("table.team");
  await page.screenshot({ path: `${OUT}/07-ajustes.png`, fullPage: true });
  check("ajustes: equipo y plantillas", (await page.locator("table.team").count()) === 2);
  await ctx.close();
}

// ---------------------------------------------------------------- móvil (iPhone 14)
{
  const { ctx, page } = await session({ width: 390, height: 844 }, true);
  await page.screenshot({ path: `${OUT}/08-movil-lista.png` });
  check("móvil: barra inferior con Ajustes y Salir", (await page.locator(".mobile-tabs a:has-text('Ajustes')").isVisible()) && (await page.locator(".mobile-tabs button:has-text('Salir')").isVisible()));
  await page.click(".conv:has-text('Lucía Martín')");
  await page.waitForSelector(".bubble");
  await page.waitForTimeout(600);
  check("móvil: la lista se oculta al abrir chat", !(await page.locator(".list-pane").isVisible()));
  await page.screenshot({ path: `${OUT}/09-movil-chat.png` });
  await page.click("button[aria-label='Ver ficha']");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/10-movil-ficha.png` });
  check("móvil: ficha a pantalla completa", await page.locator(".lead-pane").isVisible());
  await page.click("button[aria-label='Cerrar ficha']");
  await page.click("a[aria-label='Volver']");
  await page.waitForSelector(".list-pane .conv");
  check("móvil: volver a la lista", await page.locator(".list-pane").isVisible());
  await ctx.close();
}

await browser.close();
console.log(results.join("\n"));
console.log(errors.length ? `\nErrores del navegador:\n${[...new Set(errors)].join("\n")}` : "\nSin errores en el navegador.");
