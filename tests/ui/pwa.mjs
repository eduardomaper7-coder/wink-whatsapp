/**
 * Prueba de la PWA en Chrome: manifest, iconos, service worker, push → notificación,
 * página sin conexión y aviso para activar notificaciones.
 *   BASE_URL=http://localhost:3200 node tests/ui/pwa.mjs
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL ?? "http://localhost:3200";
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const results = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "es-ES" });
await ctx.grantPermissions(["notifications"], { origin: BASE });
const page = await ctx.newPage();

// Manifest e iconos
const manifest = await (await page.request.get(`${BASE}/manifest.webmanifest`)).json();
check("manifest: standalone, start_url /inbox, nombre", manifest.display === "standalone" && manifest.start_url === "/inbox" && manifest.short_name === "Wink");
check("manifest: icono maskable", manifest.icons.some((i) => i.purpose === "maskable"));
for (const i of manifest.icons) check(`icono ${i.src}`, (await page.request.get(`${BASE}${i.src}`)).ok());
check("apple-touch-icon", (await page.request.get(`${BASE}/icons/apple-touch-icon.png`)).ok());

// Login y registro del service worker
await page.goto(`${BASE}/login`);
const head = await page.content();
check("metadatos iOS (pantalla completa + icono)", head.includes('apple-mobile-web-app-capable') || head.includes('mobile-web-app-capable'));
check("enlace al manifest en la página", head.includes("manifest.webmanifest"));
await page.fill("#email", "marta@wink.test");
await page.fill("#password", "x");
await page.click("button:has-text('Entrar')");
await page.waitForSelector(".conv");
const swOk = await page.evaluate(async () => !!(await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 8000))])));
check("service worker activo", swOk);

// Push simulado (protocolo de Chrome) → notificación
const cdp = await ctx.newCDPSession(page);
await cdp.send("ServiceWorker.enable");
let regId = null;
cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => {
  for (const r of e.registrations) if (!r.isDeleted) regId = r.registrationId;
});
await cdp.send("ServiceWorker.disable");
await cdp.send("ServiceWorker.enable");
for (let i = 0; i < 20 && !regId; i++) await page.waitForTimeout(200);
check("registro del service worker localizado", !!regId, String(regId));
// Conversación concreta (no la que está abierta) para que sí se muestre
await cdp.send("ServiceWorker.deliverPushMessage", {
  origin: new URL(BASE).origin,
  registrationId: regId,
  data: JSON.stringify({ title: "Javi Ruiz", body: "Mejor por la tarde, a partir de las 17h", url: "/inbox/otra", tag: "conv:test", badge: 2 }),
});
await page.waitForTimeout(1500);
const notes = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, url: n.data?.url })));
check("push → notificación visible con título, texto y destino", notes.some((n) => n.title === "Javi Ruiz" && n.body.includes("17h") && n.url === "/inbox/otra"), JSON.stringify(notes));

// Aviso para activar notificaciones (en Chrome sin servicio push real, el estado es "default")
check("aviso para activar notificaciones en la lista", (await page.locator(".notif-banner").count()) === 1);
await page.click(".rail button[title='Notificaciones']");
const box = await page.locator(".notif-panel").boundingBox();
check("panel de notificaciones legible (ancho completo)", !!box && box.width >= 280, box ? `${Math.round(box.width)}px` : "");
check("botón de activar con estilo propio (no el del carril)", (await page.locator(".notif-panel .btn-primary").boundingBox())?.width > 120);
await page.screenshot({ path: "/tmp/shots/11-notificaciones.png" });

// Sin conexión
await ctx.setOffline(true);
await page.goto(`${BASE}/inbox`).catch(() => {});
await page.waitForTimeout(800);
check("página sin conexión", (await page.locator("text=Sin conexión").count()) > 0);
await page.screenshot({ path: "/tmp/shots/12-offline.png" });
await ctx.setOffline(false);

await browser.close();
console.log(results.join("\n"));
