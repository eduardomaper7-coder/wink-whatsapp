/**
 * Comprobación previa a la demo: configuración y conexión real con cada servicio.
 * No imprime ningún secreto (solo nombres de variables y resultados).
 *
 *   npm run demo:check
 *   npm run demo:check -- --url https://wink-whatsapp.vercel.app   (si APP_URL no está en .env.local)
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

for (const line of existsSync(".env.local") ? readFileSync(path.resolve(".env.local"), "utf8").split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}
const E = process.env;
const args = process.argv.slice(2);
const appUrl = (args[args.indexOf("--url") + 1] && args.includes("--url") ? args[args.indexOf("--url") + 1] : E.APP_URL)?.replace(/\/$/, "");

type Level = "ok" | "warn" | "fail";
const results: Array<{ level: Level; area: string; text: string }> = [];
const put = (level: Level, area: string, text: string) => {
  results.push({ level, area, text });
  console.log(`${{ ok: "✓", warn: "!", fail: "✗" }[level]} ${area.padEnd(11)} ${text}`);
};
const pending = (v?: string) => !v || /^PENDIENTE|^xxx|^<|changeme/i.test(v);
async function check(area: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    put("fail", area, (e as Error).message.slice(0, 200));
  }
}
const timeout = () => AbortSignal.timeout(12_000);

// ------------------------------------------------------------ variables
const required = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "ANTHROPIC_API_KEY"];
const missing = required.filter((k) => pending(E[k]));
missing.length ? put("fail", "Variables", `faltan: ${missing.join(", ")}`) : put("ok", "Variables", "obligatorias presentes");
const optional: Record<string, string> = {
  SMTP_PASS: "sin email del briefing",
  BRIEFING_EMAIL_TO: "sin destinatario del briefing",
  GROQ_API_KEY: "las notas de voz no se transcribirán",
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: "sin notificaciones push",
  VAPID_PRIVATE_KEY: "sin notificaciones push",
  NEXT_PUBLIC_DEMO_WA_NUMBER: "el panel en directo no mostrará QR",
  APP_URL: "los enlaces del briefing y del push no apuntarán a la bandeja",
};
for (const [k, why] of Object.entries(optional)) if (pending(E[k])) put("warn", "Variables", `${k} vacía → ${why}`);
if (E.WHATSAPP_DRY_RUN === "1" || E.WHATSAPP_DRY_RUN === "true") put("warn", "WhatsApp", "WHATSAPP_DRY_RUN activo: no se enviará nada de verdad");
if (E.EMAIL_TRANSPORT === "log") put("warn", "Email", "EMAIL_TRANSPORT=log: el briefing no se envía");
if (E.PUSH_TRANSPORT === "log") put("warn", "Push", "PUSH_TRANSPORT=log: no llegan notificaciones");
put("ok", "Agenda", E.CALENDAR_PROVIDER === "google" ? "Google Calendar" : "agenda de demo (interna)");

// ------------------------------------------------------------ Supabase
let db: import("@supabase/supabase-js").SupabaseClient | null = null;
if (!pending(E.SUPABASE_SERVICE_ROLE_KEY) && !pending(E.NEXT_PUBLIC_SUPABASE_URL)) {
  await check("Supabase", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    db = createClient(E.NEXT_PUBLIC_SUPABASE_URL!, E.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: team, error } = await db.from("profiles").select("role").eq("active", true);
    if (error) throw new Error(error.message);
    const admins = (team ?? []).filter((p) => p.role === "admin").length;
    put(admins ? "ok" : "fail", "Supabase", `conectado · ${team?.length ?? 0} usuario(s) activos, ${admins} admin`);
    const { count: convs } = await db.from("conversations").select("id", { count: "exact", head: true });
    const { count: demo } = await db.from("contacts").select("id", { count: "exact", head: true }).like("wa_id", "34600000%");
    put("ok", "Datos", `${convs ?? 0} conversaciones (${demo ?? 0} de ejemplo)`);
    const { data: b } = await db.storage.getBucket(E.SUPABASE_MEDIA_BUCKET ?? "whatsapp-media");
    put(b && !b.public ? "ok" : "fail", "Storage", b ? (b.public ? "¡el bucket es público!" : "bucket privado") : "no existe el bucket");
    const twoMin = new Date(Date.now() - 120_000).toISOString();
    const { count: stuck } = await db.from("jobs").select("id", { count: "exact", head: true }).eq("status", "queued").lt("run_after", twoMin);
    put(stuck ? "warn" : "ok", "Cola", stuck ? `${stuck} trabajo(s) esperando >2 min: ¿está programado el worker (pg_cron)?` : "sin trabajos atascados");
    const { count: dead } = await db.from("jobs").select("id", { count: "exact", head: true }).eq("status", "dead");
    if (dead) put("warn", "Cola", `${dead} trabajo(s) fallidos definitivamente (revisa jobs.last_error)`);
    const { count: tpl } = await db.from("templates").select("id", { count: "exact", head: true }).eq("status", "APPROVED");
    put(tpl ? "ok" : "warn", "Plantillas", tpl ? `${tpl} aprobada(s)` : "ninguna aprobada: fuera de 24 h no se podrá escribir (sincroniza en Ajustes)");
  });
}

// ------------------------------------------------------------ WhatsApp (Graph API)
if (!pending(E.WHATSAPP_TOKEN) && !pending(E.WHATSAPP_PHONE_NUMBER_ID)) {
  const g = (p: string) => fetch(`https://graph.facebook.com/${E.WHATSAPP_GRAPH_VERSION ?? "v26.0"}/${p}`, { headers: { Authorization: `Bearer ${E.WHATSAPP_TOKEN}` }, signal: timeout() });
  await check("WhatsApp", async () => {
    const r = await g(`${E.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`);
    const j = (await r.json()) as { display_phone_number?: string; verified_name?: string; quality_rating?: string; error?: { message: string; code: number } };
    if (!r.ok) throw new Error(`token o ID de número no válidos (código ${j.error?.code}): ${j.error?.message}`);
    put("ok", "WhatsApp", `número ${j.display_phone_number} · «${j.verified_name}» · calidad ${j.quality_rating}`);
    const demoNum = (E.NEXT_PUBLIC_DEMO_WA_NUMBER ?? "").replace(/\D/g, "");
    if (demoNum && demoNum !== (j.display_phone_number ?? "").replace(/\D/g, "")) put("warn", "WhatsApp", "NEXT_PUBLIC_DEMO_WA_NUMBER no coincide con el número conectado (el QR llevará a otro número)");
  });
  if (!pending(E.WHATSAPP_BUSINESS_ACCOUNT_ID)) {
    await check("Webhook", async () => {
      const r = await g(`${E.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps`);
      const j = (await r.json()) as { data?: unknown[]; error?: { message: string } };
      if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
      put(j.data?.length ? "ok" : "fail", "Webhook", j.data?.length ? `app suscrita a la WABA (${j.data.length})` : "ninguna app suscrita a la WABA: no llegarán mensajes");
    });
  }
}

// ------------------------------------------------------------ la app desplegada
if (appUrl) {
  await check("App", async () => {
    const challenge = String(Math.floor(Math.random() * 1e9));
    const u = `${appUrl}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(E.WHATSAPP_VERIFY_TOKEN ?? "")}&hub.challenge=${challenge}`;
    const r = await fetch(u, { signal: timeout() });
    const body = await r.text();
    put(r.ok && body === challenge ? "ok" : "fail", "App", r.ok && body === challenge ? `${appUrl} responde a la verificación del webhook` : `la verificación del webhook falla (HTTP ${r.status})`);
    if (!pending(E.CRON_SECRET)) {
      const w = await fetch(`${appUrl}/api/jobs/run`, { method: "POST", headers: { Authorization: `Bearer ${E.CRON_SECRET}` }, signal: timeout() });
      put(w.ok ? "ok" : "fail", "Worker", w.ok ? "el worker acepta el CRON_SECRET" : `el worker responde HTTP ${w.status}`);
    }
  });
} else put("warn", "App", "sin APP_URL: no se comprueba el despliegue (usa --url)");

// ------------------------------------------------------------ IA y extras
if (!pending(E.ANTHROPIC_API_KEY)) {
  await check("Claude", async () => {
    for (const m of [E.AGENT_MODEL_CHAT ?? "claude-sonnet-5-5", E.AGENT_MODEL_CLASSIFY ?? "claude-haiku-5-5", E.AGENT_MODEL_BRIEFING ?? "claude-opus-5-5"]) {
      const r = await fetch(`https://api.anthropic.com/v1/models/${m}`, { headers: { "x-api-key": E.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01" }, signal: timeout() });
      put(r.ok ? "ok" : "fail", "Claude", r.ok ? `modelo ${m} disponible` : `modelo ${m}: HTTP ${r.status} (¿clave o nombre de modelo?)`);
    }
  });
}
if (!pending(E.GROQ_API_KEY)) {
  await check("Groq", async () => {
    const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${E.GROQ_API_KEY}` }, signal: timeout() });
    put(r.ok ? "ok" : "fail", "Groq", r.ok ? "transcripción de notas de voz disponible" : `HTTP ${r.status}`);
  });
}
if (!pending(E.SMTP_PASS) && E.SMTP_HOST && E.EMAIL_TRANSPORT !== "log") {
  await check("Email", async () => {
    const nodemailer = (await import("nodemailer")).default;
    const port = Number(E.SMTP_PORT ?? 465);
    await nodemailer.createTransport({ host: E.SMTP_HOST, port, secure: port === 465, auth: { user: E.SMTP_USER, pass: E.SMTP_PASS }, connectionTimeout: 12_000 }).verify();
    put("ok", "Email", `SMTP ${E.SMTP_HOST} acepta las credenciales`);
  });
}

const fails = results.filter((r) => r.level === "fail").length;
const warns = results.filter((r) => r.level === "warn").length;
console.log(`\n${fails ? `✗ ${fails} problema(s) que impiden la demo` : "✓ Listo para la demo"}${warns ? ` · ${warns} aviso(s)` : ""}`);
process.exit(fails ? 1 : 0);
