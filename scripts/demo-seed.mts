/**
 * Carga datos ficticios realistas para la demo (Supabase de .env.local).
 *
 *   npm run demo:seed                         # conversaciones de ejemplo
 *   npm run demo:seed -- --admin tu@email.com --password "Clave123!" --name "Tu Nombre"
 *        (crea además un usuario administrador para entrar en la bandeja)
 *
 * Todos los contactos de demo usan teléfonos 34600 000 0xx (marcados para el reinicio).
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

for (const line of existsSync(".env.local") ? readFileSync(path.resolve(".env.local"), "utf8").split(/\r?\n/) : []) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}

const { zonedToUtc, shortLabel, longLabel, localDate, addDaysYmd, isoWeekdayOfYmd } = await import("../src/lib/calendar/time");
const { createClient } = await import("@supabase/supabase-js");
// Cliente directo (no exige las credenciales de Meta: sirve antes de tenerlas)
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const args = process.argv.slice(2);
const arg = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

export const DEMO_PREFIX = "34600000";
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const inDays = (d: number, hhmmUtc: string) => {
  const t = new Date(now + d * 86_400_000);
  const [h, m] = hhmmUtc.split(":").map(Number);
  t.setUTCHours(h!, m!, 0, 0);
  return t.toISOString();
};
const must = <T,>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error || r.data === null) throw new Error(`${what}: ${r.error?.message}`);
  return r.data;
};

// ------------------------------------------------------------ usuario admin (opcional)
let adminId: string | null = null;
if (arg("admin")) {
  const email = arg("admin")!;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: arg("password") ?? "WinkDemo2026!",
    email_confirm: true,
    user_metadata: { full_name: arg("name") ?? "Marta García" },
    app_metadata: { role: "admin", active: true },
  });
  if (error && !/already/i.test(error.message)) throw error;
  adminId = data.user?.id ?? null;
  if (!adminId) {
    const { data: p } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
    adminId = p?.id ?? null;
  }
  if (adminId) await db.from("profiles").upsert({ id: adminId, email, full_name: arg("name") ?? "Marta García", role: "admin", active: true });
  console.log(`✓ Administrador: ${email}`);
} else {
  const { data: p } = await db.from("profiles").select("id").eq("active", true).order("created_at").limit(1).maybeSingle();
  adminId = p?.id ?? null;
}

// ------------------------------------------------------------ helpers
type Msg = {
  min: number; // minutos atrás
  dir: "in" | "out";
  author?: "agent" | "human" | "system";
  type?: string;
  content: Record<string, unknown>;
  preview: string;
  status?: string;
  reaction?: string;
};

async function conversation(opts: {
  n: number;
  name: string;
  profile: string;
  status: "bot" | "human" | "closed";
  agentActive: boolean;
  unread: number;
  assigned?: boolean;
  handoff?: string;
  messages: Msg[];
  lead?: Record<string, unknown>;
  events?: Array<{ type: string; min: number; data: Record<string, unknown>; actor?: string }>;
  image?: { min: number; caption: string; filename: string };
}) {
  const waId = `${DEMO_PREFIX}${String(opts.n).padStart(3, "0")}`;
  const contact = must(
    await db
      .from("contacts")
      .upsert({ wa_id: waId, name: opts.lead?.full_name ?? null, profile_name: opts.profile, consent_notice_sent_at: ago(opts.messages[0]!.min - 1), consent_at: ago(opts.messages[0]!.min - 3) }, { onConflict: "wa_id" })
      .select("id")
      .single(),
    "contacto",
  ) as { id: string };

  const lastIn = opts.messages.filter((m) => m.dir === "in").at(-1)!;
  const last = opts.messages.at(-1)!;
  const conv = must(
    await db
      .from("conversations")
      .upsert(
        {
          contact_id: contact.id,
          status: opts.status,
          agent_active: opts.agentActive,
          assigned_to: opts.assigned ? adminId : null,
          handoff_reason: opts.handoff ?? null,
          last_inbound_at: ago(lastIn.min),
          last_message_at: ago(last.min),
          last_message_preview: last.preview.slice(0, 140),
          unread_count: opts.unread,
          closed_at: opts.status === "closed" ? ago(last.min - 1) : null,
        },
        { onConflict: "contact_id" },
      )
      .select("id")
      .single(),
    "conversación",
  ) as { id: string };

  await db.from("messages").delete().eq("conversation_id", conv.id);
  const rows = opts.messages.map((m, i) => ({
    conversation_id: conv.id,
    direction: m.dir === "in" ? "inbound" : "outbound",
    author: m.dir === "in" ? "customer" : (m.author ?? "agent"),
    sent_by: m.author === "human" ? adminId : null,
    type: m.type ?? "text",
    content: m.content,
    text_preview: m.preview,
    wa_message_id: `wamid.DEMO${opts.n}_${i}_${now}`,
    status: m.dir === "in" ? "received" : (m.status ?? "read"),
    customer_reaction: m.reaction ?? null,
    media_status: m.type === "image" ? "stored" : "none",
    wa_timestamp: ago(m.min),
    created_at: ago(m.min),
  }));
  const inserted = must(await db.from("messages").insert(rows).select("id, type"), "mensajes") as Array<{ id: string; type: string }>;

  let leadId: string | null = null;
  if (opts.lead) {
    await db.from("leads").delete().eq("conversation_id", conv.id);
    leadId = (must(await db.from("leads").insert({ contact_id: contact.id, conversation_id: conv.id, ...opts.lead }).select("id").single(), "lead") as { id: string }).id;
  }

  if (opts.image) {
    const imgMsg = inserted.find((r) => r.type === "image");
    const logo = readFileSync(path.resolve("public/brand/wink-logo.png"));
    const storagePath = `${conv.id}/demo/${opts.image.filename}`;
    await db.storage.from(process.env.SUPABASE_MEDIA_BUCKET ?? "whatsapp-media").upload(storagePath, logo, { contentType: "image/png", upsert: true });
    await db.from("attachments").upsert(
      {
        message_id: imgMsg?.id ?? null,
        conversation_id: conv.id,
        lead_id: leadId,
        storage_bucket: process.env.SUPABASE_MEDIA_BUCKET ?? "whatsapp-media",
        storage_path: storagePath,
        kind: "image",
        mime_type: "image/png",
        size_bytes: logo.length,
        original_filename: opts.image.filename,
        description: opts.image.caption,
        caption: opts.image.caption,
      },
      { onConflict: "storage_bucket,storage_path" },
    );
  }

  await db.from("events").delete().eq("conversation_id", conv.id);
  for (const e of opts.events ?? []) {
    await db.from("events").insert({ type: e.type, actor: e.actor ?? "agent", conversation_id: conv.id, lead_id: leadId, data: e.data, created_at: ago(e.min) });
  }
  return conv.id;
}

// ------------------------------------------------------------ conversaciones de demo
const PRIVACY = process.env.PRIVACY_POLICY_URL ?? "https://winkgroup.es/politica-de-privacidad";
// Tres días laborables a partir de pasado mañana (hora de Madrid), coherentes en chat y ficha
const TZ = "Europe/Madrid";
const workdays: string[] = [];
for (let d = 2; workdays.length < 3; d++) {
  const ymd = addDaysYmd(localDate(new Date(), TZ).ymd, d);
  if (isoWeekdayOfYmd(ymd) <= 5) workdays.push(ymd);
}
const slots = [zonedToUtc(workdays[0]!, "09:30", TZ), zonedToUtc(workdays[1]!, "16:00", TZ), zonedToUtc(workdays[2]!, "11:00", TZ)];
const slotLabels = slots.map((d) => shortLabel(d, TZ));
const visit = slots[0]!.toISOString();
void inDays;

await conversation({
  n: 1,
  name: "Lucía Martín",
  profile: "Lucía M.",
  status: "bot",
  agentActive: true,
  unread: 0,
  messages: [
    { min: 95, dir: "in", content: { body: "Hola! Estoy pensando en reformar mi piso en Chamberí, unos 90 m2" }, preview: "Hola! Estoy pensando en reformar mi piso en Chamberí, unos 90 m2" },
    { min: 94, dir: "out", content: { type: "text", body: `¡Hola! Soy el asistente de Wink, gracias por escribirnos. Una reforma en Chamberí, qué buen proyecto. ¿Cómo te llamas?\n\nAl escribirnos aceptas que tratemos tus datos para atender tu consulta; más info en ${PRIVACY}` }, preview: "¡Hola! Soy el asistente de Wink, gracias por escribirnos. Una reforma en Chamberí, qué buen proyecto. ¿Cómo te llamas?" },
    { min: 92, dir: "in", content: { body: "Soy Lucía. Es un piso de los años 60, bastante compartimentado y con poca luz" }, preview: "Soy Lucía. Es un piso de los años 60, bastante compartimentado y con poca luz" },
    { min: 91, dir: "out", content: { type: "text", body: "Encantado, Lucía. Es muy habitual en pisos de esa época. ¿Qué te gustaría conseguir con la reforma?" }, preview: "Encantado, Lucía. Es muy habitual en pisos de esa época. ¿Qué te gustaría conseguir con la reforma?" },
    { min: 88, dir: "in", content: { body: "Abrir la cocina al salón, ganar luz y rehacer los dos baños. Quiero algo cálido, con madera" }, preview: "Abrir la cocina al salón, ganar luz y rehacer los dos baños. Quiero algo cálido, con madera" },
    { min: 87, dir: "out", content: { type: "text", body: "Suena precioso. Si tienes fotos del estado actual o un plano, me ayudan mucho a preparar la visita del arquitecto." }, preview: "Suena precioso. Si tienes fotos del estado actual o un plano, me ayudan mucho a preparar la visita del arquitecto." },
    { min: 85, dir: "in", type: "image", content: { media_id: "demo", mime_type: "image/png", caption: "Así está el salón ahora" }, preview: "📷 Imagen: Así está el salón ahora" },
    { min: 84, dir: "out", content: { type: "text", body: "¡Recibida, gracias! ¿Me dices la dirección de la vivienda (calle y número) para la visita técnica?" }, preview: "¡Recibida, gracias! ¿Me dices la dirección de la vivienda (calle y número) para la visita técnica?" },
    { min: 80, dir: "in", content: { body: "Calle de Fuencarral 120, 3ºB" }, preview: "Calle de Fuencarral 120, 3ºB" },
    {
      min: 79,
      dir: "out",
      type: "interactive",
      content: { type: "buttons", body: "Perfecto. ¿Qué hueco te viene mejor para la visita técnica? Es gratuita y dura aproximadamente una hora.", buttons: slotLabels.map((title, i) => ({ id: `slot_${i}`, title })) },
      preview: `Perfecto. ¿Qué hueco te viene mejor para la visita técnica?\n${slotLabels.map((l) => `[${l}]`).join(" ")}`,
    },
    { min: 77, dir: "in", type: "interactive", content: { kind: "button_reply", id: "slot_0", title: slotLabels[0] }, preview: slotLabels[0]! },
    { min: 76, dir: "out", content: { type: "text", body: `¡Hecho, Lucía! Visita confirmada el ${longLabel(slots[0]!, TZ)} en Calle de Fuencarral 120, 3ºB. El arquitecto llevará preparada toda tu información.` }, preview: `¡Hecho, Lucía! Visita confirmada el ${longLabel(slots[0]!, TZ)} en Calle de Fuencarral 120, 3ºB.`, reaction: "🙏" },
  ],
  image: { min: 85, caption: "Fotos del salón (estado actual)", filename: "salon-actual.png" },
  lead: {
    status: "visit_scheduled",
    full_name: "Lucía Martín",
    project_type: "reforma_integral",
    address: "Calle de Fuencarral 120, 3ºB (Chamberí)",
    surface_m2: 90,
    property_state: "Piso de los años 60, compartimentado y con poca luz",
    goals: "Abrir la cocina al salón, ganar luz, rehacer los dos baños; estilo cálido con madera",
    budget_range: "Prefiere comentarlo en la visita",
    desired_timeline: "Empezar en primavera",
    contact_preference: "whatsapp",
    visit_at: visit,
    visit_end_at: new Date(new Date(visit).getTime() + 3_600_000).toISOString(),
    visit_calendar_event_id: "demo_evento",
    missing_fields: [],
    briefing_md:
      "## Resumen\nLucía Martín quiere una reforma integral de su piso de 90 m² en Chamberí para abrir la cocina al salón, ganar luz y renovar los dos baños.\n\n## Necesidades y objetivos\n- Cocina abierta al salón\n- Más luz natural\n- Dos baños nuevos\n- Estilo cálido, con madera\n- **Presupuesto:** prefiere comentarlo en la visita\n- **Plazos:** empezar en primavera\n\n## Datos del inmueble\n- Calle de Fuencarral 120, 3ºB · 90 m²\n- Edificio de los años 60, distribución compartimentada\n\n## Documentación recibida\n- Fotos del salón (estado actual)\n\n## Dudas y puntos a confirmar en la visita\n- Viabilidad de abrir la cocina (muros de carga)\n- Estado de instalaciones\n\n## Recomendaciones para la visita\n- Llevar muestras de madera y propuestas de distribución abierta\n- Medir orientación y huecos de fachada",
    briefing_generated_at: ago(75),
    briefing_sent_at: ago(75),
  },
  events: [{ type: "visit.booked", min: 76, data: { calendar: "demo" } }],
});

await conversation({
  n: 2,
  name: "Javier Ruiz",
  profile: "Javi Ruiz",
  status: "human",
  agentActive: false,
  unread: 2,
  assigned: true,
  handoff: "lo_pide_cliente",
  messages: [
    { min: 32, dir: "in", content: { body: "Buenas, tengo un ático en el barrio de Salamanca y queremos reformarlo entero" }, preview: "Buenas, tengo un ático en el barrio de Salamanca y queremos reformarlo entero" },
    { min: 31, dir: "out", content: { type: "text", body: `¡Hola! Soy el asistente de Wink, gracias por escribirnos. ¿Cuántos metros tiene aproximadamente el ático?\n\nAl escribirnos aceptas que tratemos tus datos para atender tu consulta; más info en ${PRIVACY}` }, preview: "¡Hola! Soy el asistente de Wink. ¿Cuántos metros tiene aproximadamente el ático?" },
    { min: 12, dir: "in", content: { body: "Unos 140 con terraza. Prefiero hablar con una persona, ¿me podéis llamar?" }, preview: "Unos 140 con terraza. Prefiero hablar con una persona, ¿me podéis llamar?" },
    { min: 12, dir: "out", content: { type: "text", body: "Claro, te paso con una persona del equipo. Te escribirá por aquí en cuanto pueda." }, preview: "Claro, te paso con una persona del equipo. Te escribirá por aquí en cuanto pueda." },
    { min: 3, dir: "in", content: { body: "Mejor por la tarde, a partir de las 17h" }, preview: "Mejor por la tarde, a partir de las 17h" },
  ],
  lead: { status: "handed_off", project_type: "reforma_integral", address: "Barrio de Salamanca", surface_m2: 140, property_state: "Ático con terraza", contact_preference: "llamada", contact_preference_notes: "Por la tarde, a partir de las 17 h", handoff_summary: "Javier tiene un ático de 140 m² con terraza en el barrio de Salamanca y quiere una reforma integral. Pide que le llamen, mejor por la tarde.", missing_fields: ["full_name", "goals", "budget_range", "desired_timeline"] },
  events: [{ type: "agent.handoff", min: 12, data: { categoria: "lo_pide_cliente", resumen: "Javier tiene un ático de 140 m² con terraza en el barrio de Salamanca y quiere una reforma integral. Pide que le llamen, mejor por la tarde.", urgente: false } }],
});

await conversation({
  n: 3,
  name: "Carmen Ortega",
  profile: "Carmen",
  status: "human",
  agentActive: false,
  unread: 0,
  messages: [
    { min: 60 * 50, dir: "in", content: { body: "Hola, ¿hacéis reformas de cocina solo?" }, preview: "Hola, ¿hacéis reformas de cocina solo?" },
    { min: 60 * 50 - 1, dir: "out", content: { type: "text", body: "¡Hola! Soy el asistente de Wink. Nuestra especialidad son las reformas integrales, pero lo estudiamos caso a caso. ¿Dónde está la vivienda?" }, preview: "¡Hola! Soy el asistente de Wink. Nuestra especialidad son las reformas integrales…" },
    { min: 60 * 49, dir: "in", content: { body: "En Retiro. Lo hablo con mi marido y os digo" }, preview: "En Retiro. Lo hablo con mi marido y os digo" },
    { min: 60 * 49 - 2, dir: "out", author: "human", content: { type: "text", body: "¡Perfecto, Carmen! Aquí estamos cuando lo tengáis claro. Un saludo, Marta (Wink)" }, preview: "¡Perfecto, Carmen! Aquí estamos cuando lo tengáis claro. Un saludo, Marta (Wink)" },
  ],
  lead: { status: "qualifying", project_type: "reforma_parcial", project_type_other: "Cocina", address: "Retiro", missing_fields: ["full_name", "surface_m2", "property_state", "goals", "budget_range", "desired_timeline", "contact_preference"] },
});

await conversation({
  n: 4,
  name: "Azulejos Levante",
  profile: "Azulejos Levante S.L.",
  status: "human",
  agentActive: false,
  unread: 1,
  handoff: "proveedor",
  messages: [
    { min: 140, dir: "in", content: { body: "Buenos días, somos distribuidores de porcelánico y nos gustaría presentaros nuestro catálogo 2027" }, preview: "Buenos días, somos distribuidores de porcelánico y nos gustaría presentaros nuestro catálogo 2027" },
    { min: 139, dir: "out", content: { type: "text", body: "Gracias por contactar con Wink. Paso tu mensaje al equipo y te responderán por aquí." }, preview: "Gracias por contactar con Wink. Paso tu mensaje al equipo y te responderán por aquí." },
  ],
  events: [{ type: "agent.handoff", min: 139, data: { categoria: "proveedor", resumen: "Distribuidor de porcelánico que quiere presentar su catálogo 2027.", urgente: false } }],
});

await conversation({
  n: 5,
  name: "Pablo Serrano",
  profile: "Pablo",
  status: "bot",
  agentActive: true,
  unread: 0,
  messages: [
    { min: 6, dir: "in", content: { body: "Hola, quería información para reformar un piso que acabo de comprar en Chamartín" }, preview: "Hola, quería información para reformar un piso que acabo de comprar en Chamartín" },
    { min: 6, dir: "out", content: { type: "text", body: `¡Hola! Soy el asistente de Wink, gracias por escribirnos y enhorabuena por la compra. ¿Qué tienes en mente para el piso?\n\nAl escribirnos aceptas que tratemos tus datos para atender tu consulta; más info en ${PRIVACY}` }, preview: "¡Hola! Soy el asistente de Wink, gracias por escribirnos y enhorabuena por la compra. ¿Qué tienes en mente para el piso?" },
    { min: 4, dir: "in", content: { body: "Reforma integral, son 110 m2. Queremos 3 dormitorios y una cocina grande" }, preview: "Reforma integral, son 110 m2. Queremos 3 dormitorios y una cocina grande" },
    { min: 4, dir: "out", content: { type: "text", body: "¡Qué buen punto de partida! ¿Cómo te llamas?" }, preview: "¡Qué buen punto de partida! ¿Cómo te llamas?" },
  ],
  lead: { status: "qualifying", project_type: "reforma_integral", address: "Chamartín", surface_m2: 110, goals: "Tres dormitorios y una cocina grande", property_state: "Recién comprado", missing_fields: ["full_name", "budget_range", "desired_timeline", "contact_preference"] },
});

console.log("✓ Datos de demo cargados: 5 conversaciones (agente captando, visita agendada, derivada, ventana cerrada, proveedor).");
process.exit(0);
