/**
 * Deja la base lista para (re)empezar una demo. Borra conversaciones, expedientes,
 * mensajes, adjuntos (también los ficheros de Storage), trabajos pendientes,
 * auditoría y ejecuciones del agente de los contactos elegidos.
 * Nunca toca usuarios del equipo, plantillas ni suscripciones push.
 *
 *   npm run demo:reset                       # solo los contactos ficticios del seed (34600000xxx)
 *   npm run demo:reset -- --phone 34612345678   # además/solo ese teléfono (p. ej. el tuyo, para repetir la prueba)
 *   npm run demo:reset -- --all --yes        # TODOS los contactos (pide --yes: es irreversible)
 *   añade --seed para volver a cargar los datos de ejemplo al terminar
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

for (const line of existsSync(".env.local") ? readFileSync(path.resolve(".env.local"), "utf8").split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}

const { createClient } = await import("@supabase/supabase-js");
// Cliente directo (no exige las credenciales de Meta: sirve antes de tenerlas)
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const BUCKET = process.env.SUPABASE_MEDIA_BUCKET ?? "whatsapp-media";
const DEMO_PREFIX = "34600000";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(`--${f}`);
const phones = args.flatMap((a, i) => (args[i - 1] === "--phone" ? [a.replace(/\D/g, "")] : []));
const all = has("all");

if (all && !has("yes")) {
  console.error("--all borra TODAS las conversaciones reales. Repite con --all --yes si es lo que quieres.");
  process.exit(1);
}

// ------------------------------------------------------------ contactos afectados
let q = db.from("contacts").select("id, wa_id");
if (!all) {
  const ors = [`wa_id.like.${DEMO_PREFIX}%`, ...phones.map((p) => `wa_id.eq.${p}`)];
  q = q.or(ors.join(","));
}
const { data: contacts, error } = await q;
if (error) throw error;
if (!contacts?.length) {
  console.log("Nada que borrar.");
} else {
  const contactIds = contacts.map((c) => c.id as string);
  const waIds = new Set(contacts.map((c) => c.wa_id as string));
  const { data: convs } = await db.from("conversations").select("id").in("contact_id", contactIds);
  const convIds = (convs ?? []).map((c) => c.id as string);

  // 1) Ficheros de Storage (entrantes en <conv>/..., salientes en outbound/<conv>/...)
  let files = 0;
  for (const id of convIds) {
    for (const prefix of [id, `outbound/${id}`]) files += await removeTree(prefix);
  }

  // 2) Trabajos pendientes que apunten a esas conversaciones (si no, el worker los reintentaría)
  if (convIds.length) {
    const { count } = await db.from("jobs").delete({ count: "exact" }).in("payload->>conversationId", convIds);
    console.log(`  trabajos borrados: ${count ?? 0}`);
  }

  // 3) Webhooks crudos que contengan esos teléfonos (dedupe de Meta; si no, un reintento se ignoraría)
  const { data: hooks } = await db.from("wa_webhook_events").select("id, payload").order("id", { ascending: false }).limit(5000);
  const hookIds = (hooks ?? []).filter((h) => [...waIds].some((w) => JSON.stringify(h.payload).includes(w))).map((h) => h.id as number);
  for (let i = 0; i < hookIds.length; i += 200) await db.from("wa_webhook_events").delete().in("id", hookIds.slice(i, i + 200));

  // 4) Contactos → en cascada: conversaciones, mensajes, adjuntos, expedientes, auditoría, ejecuciones del agente
  const { error: delErr } = await db.from("contacts").delete().in("id", contactIds);
  if (delErr) throw delErr;
  console.log(`✓ Borrados ${contacts.length} contacto(s), ${convIds.length} conversación(es), ${files} fichero(s), ${hookIds.length} webhook(s)`);
}

if (all) {
  // Restos sin conversación (estados de envío, sincronización de plantillas antigua…)
  await db.from("jobs").delete().in("status", ["done", "dead"]);
  await db.from("events").delete().is("conversation_id", null).neq("type", "templates.synced");
  console.log("✓ Limpieza general de trabajos terminados");
}

if (has("seed")) {
  const r = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "scripts/demo-seed.mts"], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

async function removeTree(prefix: string): Promise<number> {
  const paths: string[] = [];
  const walk = async (dir: string) => {
    const { data } = await db.storage.from(BUCKET).list(dir, { limit: 1000 });
    for (const o of data ?? []) {
      const full = `${dir}/${o.name}`;
      if (o.id) paths.push(full); // fichero
      else await walk(full); // carpeta
    }
  };
  await walk(prefix);
  for (let i = 0; i < paths.length; i += 100) await db.storage.from(BUCKET).remove(paths.slice(i, i + 100));
  return paths.length;
}
