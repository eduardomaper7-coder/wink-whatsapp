import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ToolDefinition } from "@/lib/ai/anthropic";
import { findSlots, type Slot } from "@/lib/calendar/agenda";
import { calendarProvider } from "@/lib/calendar/provider";
import { longLabel } from "@/lib/calendar/time";
import { enqueueJob } from "@/lib/jobs/queue";
import { enqueuePush } from "@/lib/notify/triggers";
import { LIMITS, type OutboundInput } from "@/lib/whatsapp/outbound/schema";
import { agentEnv, loadAgenda } from "./config";
import { HANDOFF_MESSAGES, type HandoffCategory } from "./classifier";
import { LEAD_FIELDS, missingFields, type LeadRow } from "./lead";

export const BRIEFING_JOB = "generate_briefing";

// ---------------------------------------------------------------------
// Contexto compartido durante una ejecución del agente
// ---------------------------------------------------------------------
export interface ToolContext {
  db: SupabaseClient;
  conversationId: string;
  contact: { id: string; wa_id: string; name: string | null };
  lead: LeadRow;
  now: Date;
  /** Mensajes interactivos preparados por herramientas (se envían tras el texto final). */
  outbox: OutboundInput[];
  state: { handedOff?: HandoffCategory; close?: boolean; booked?: boolean };
}

export interface ToolOutcome {
  result: Record<string, unknown>;
  isError?: boolean;
}

const motivo = { type: "string", description: "Por qué usas la herramienta ahora (una frase; queda en la auditoría)." };

// ---------------------------------------------------------------------
// Definiciones (lo que ve Claude)
// ---------------------------------------------------------------------
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "actualizar_ficha_cliente",
    description:
      "Guarda en el expediente los datos que el cliente ha dado. Envía solo los campos que conozcas (los demás se conservan). Úsala en cuanto el cliente dé un dato, aunque sea aproximado.",
    input_schema: {
      type: "object",
      properties: {
        motivo,
        nombre: { type: "string" },
        tipo_proyecto: { type: "string", enum: ["reforma_integral", "reforma_parcial", "interiorismo", "obra_nueva", "otro"] },
        tipo_proyecto_otro: { type: "string", description: "Detalle si tipo_proyecto es 'otro' o para precisar (p. ej. 'cocina y dos baños')." },
        direccion_o_barrio: { type: "string", description: "Dirección completa si la da (calle, número, piso) o al menos barrio/zona." },
        superficie_m2: { type: "number" },
        estado_vivienda: { type: "string" },
        objetivos: { type: "string", description: "Qué quiere conseguir con la reforma." },
        presupuesto_orientativo: { type: "string", description: "Tal como lo exprese el cliente." },
        plazos_deseados: { type: "string" },
        preferencia_contacto: { type: "string", enum: ["whatsapp", "llamada", "email"] },
        detalle_contacto: { type: "string", description: "Teléfono, email u horario preferido si lo indica." },
        email: { type: "string" },
      },
      required: ["motivo"],
    },
  },
  {
    name: "registrar_documento",
    description: "Asocia al expediente fotos, planos o documentos que ha enviado el cliente (usa los adjunto_id que aparecen en la conversación) con una breve descripción.",
    input_schema: {
      type: "object",
      properties: {
        motivo,
        adjunto_ids: { type: "array", items: { type: "string" }, minItems: 1 },
        descripcion: { type: "string", description: "Qué son (p. ej. 'Fotos del estado actual de la cocina', 'Plano de la vivienda')." },
      },
      required: ["motivo", "adjunto_ids", "descripcion"],
    },
  },
  {
    name: "consultar_huecos_disponibles",
    description: "Consulta la agenda y devuelve hasta 3 huecos libres para la visita técnica. Después ofrécelos con enviar_opciones usando su id.",
    input_schema: {
      type: "object",
      properties: {
        motivo,
        preferencia: { type: "string", enum: ["mañana", "tarde", "indiferente"] },
        a_partir_de: { type: "string", description: "Fecha AAAA-MM-DD desde la que buscar, si el cliente lo pide." },
      },
      required: ["motivo"],
    },
  },
  {
    name: "reservar_visita",
    description: "Reserva la visita técnica en uno de los huecos ofrecidos (usa su id). Requiere nombre y dirección completa de la vivienda.",
    input_schema: {
      type: "object",
      properties: { motivo, hueco_id: { type: "string" } },
      required: ["motivo", "hueco_id"],
    },
  },
  {
    name: "derivar_a_humano",
    description:
      "Pasa la conversación a una persona del equipo y pausa al asistente. Úsala si lo pide el cliente, está molesto, tiene obra en curso, es proveedor, hay urgencia o no estás seguro. Después despídete con un mensaje breve.",
    input_schema: {
      type: "object",
      properties: {
        motivo,
        categoria: { type: "string", enum: ["lo_pide_cliente", "cliente_molesto", "obra_en_curso", "proveedor", "urgencia", "duda", "otro"] },
        resumen: { type: "string", description: "2–3 frases para el equipo: quién es, qué quiere, qué se ha hablado." },
        urgente: { type: "boolean" },
      },
      required: ["motivo", "categoria", "resumen"],
    },
  },
  {
    name: "cerrar_conversacion",
    description: "Marca la conversación como cerrada cuando el cliente se despide sin nada pendiente o indica que no le interesa. Despídete antes en tu texto final.",
    input_schema: { type: "object", properties: { motivo }, required: ["motivo"] },
  },
  {
    name: "enviar_opciones",
    description:
      "Envía al cliente un mensaje con opciones para pulsar (hasta 3 → botones; hasta 10 → lista). Úsala para ofrecer huecos de visita o elegir el tipo de proyecto. Incluye la pregunta en 'texto'.",
    input_schema: {
      type: "object",
      properties: {
        motivo,
        texto: { type: "string" },
        opciones: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          items: {
            type: "object",
            properties: { id: { type: "string" }, titulo: { type: "string", description: "≤ 20 caracteres si son 3 o menos; ≤ 24 en lista." }, descripcion: { type: "string" } },
            required: ["id", "titulo"],
          },
        },
        texto_boton_lista: { type: "string", description: "Solo si hay más de 3 opciones (≤ 20 caracteres). Por defecto 'Ver opciones'." },
      },
      required: ["motivo", "texto", "opciones"],
    },
  },
];

// ---------------------------------------------------------------------
// Validación de entradas
// ---------------------------------------------------------------------
const fichaSchema = z.object({
  motivo: z.string(),
  nombre: z.string().trim().min(1).max(120).optional(),
  tipo_proyecto: z.enum(["reforma_integral", "reforma_parcial", "interiorismo", "obra_nueva", "otro"]).optional(),
  tipo_proyecto_otro: z.string().max(300).optional(),
  direccion_o_barrio: z.string().max(300).optional(),
  superficie_m2: z.coerce.number().positive().max(100_000).optional(),
  estado_vivienda: z.string().max(1000).optional(),
  objetivos: z.string().max(2000).optional(),
  presupuesto_orientativo: z.string().max(300).optional(),
  plazos_deseados: z.string().max(300).optional(),
  preferencia_contacto: z.enum(["whatsapp", "llamada", "email"]).optional(),
  detalle_contacto: z.string().max(300).optional(),
  email: z.string().email().optional(),
});

const err = (message: string): ToolOutcome => ({ result: { error: message }, isError: true });

// ---------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------
export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case "actualizar_ficha_cliente":
      return actualizarFicha(input, ctx);
    case "registrar_documento":
      return registrarDocumento(input, ctx);
    case "consultar_huecos_disponibles":
      return consultarHuecos(input, ctx);
    case "reservar_visita":
      return reservarVisita(input, ctx);
    case "derivar_a_humano":
      return derivar(input, ctx);
    case "cerrar_conversacion":
      ctx.state.close = true;
      return { result: { ok: true, nota: "Se cerrará tras enviar tu despedida." } };
    case "enviar_opciones":
      return enviarOpciones(input, ctx);
    default:
      return err(`Herramienta desconocida: ${name}`);
  }
}

async function actualizarFicha(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const p = fichaSchema.safeParse(input);
  if (!p.success) return err(`Datos no válidos: ${p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const v = p.data;
  const patch: Partial<LeadRow> = {};
  if (v.nombre) patch.full_name = v.nombre;
  if (v.tipo_proyecto) patch.project_type = v.tipo_proyecto;
  if (v.tipo_proyecto_otro) patch.project_type_other = v.tipo_proyecto_otro;
  if (v.direccion_o_barrio) patch.address = v.direccion_o_barrio;
  if (v.superficie_m2 !== undefined) patch.surface_m2 = v.superficie_m2;
  if (v.estado_vivienda) patch.property_state = v.estado_vivienda;
  if (v.objetivos) patch.goals = v.objetivos;
  if (v.presupuesto_orientativo) patch.budget_range = v.presupuesto_orientativo;
  if (v.plazos_deseados) patch.desired_timeline = v.plazos_deseados;
  if (v.preferencia_contacto) patch.contact_preference = v.preferencia_contacto;
  if (v.detalle_contacto) patch.contact_preference_notes = v.detalle_contacto;
  if (v.email) patch.contact_email = v.email;
  if (!Object.keys(patch).length) return err("No has enviado ningún dato.");

  const merged = { ...ctx.lead, ...patch };
  const missing = missingFields(merged);
  const status = ctx.lead.status === "new" ? "qualifying" : ctx.lead.status;
  const { data, error } = await ctx.db
    .from("leads")
    .update({ ...patch, missing_fields: missing, status })
    .eq("id", ctx.lead.id)
    .select("*")
    .single();
  if (error || !data) throw new Error(`[db:lead update] ${error?.message}`);
  ctx.lead = data as LeadRow;

  if (v.nombre || v.email) {
    await ctx.db.from("contacts").update({ ...(v.nombre ? { name: v.nombre } : {}), ...(v.email ? { email: v.email } : {}) }).eq("id", ctx.contact.id);
    if (v.nombre) ctx.contact.name = v.nombre;
  }
  await ctx.db.from("events").insert({
    type: "lead.updated",
    actor: "agent",
    conversation_id: ctx.conversationId,
    lead_id: ctx.lead.id,
    data: { fields: Object.keys(patch) },
  });
  return { result: { ok: true, guardado: Object.keys(patch).map((k) => LEAD_FIELDS[k] ?? k), campos_pendientes: missing.map((k) => LEAD_FIELDS[k]) } };
}

async function registrarDocumento(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const ids = Array.isArray(input.adjunto_ids) ? input.adjunto_ids.map(String) : [];
  const descripcion = String(input.descripcion ?? "").slice(0, 500);
  if (!ids.length) return err("Indica al menos un adjunto_id.");
  const { data, error } = await ctx.db
    .from("attachments")
    .update({ lead_id: ctx.lead.id, description: descripcion })
    .in("id", ids)
    .eq("conversation_id", ctx.conversationId)
    .select("id, kind, original_filename");
  if (error) throw new Error(`[db:attachments] ${error.message}`);
  if (!data?.length) return err("No encuentro esos adjuntos en esta conversación (puede que aún se estén descargando).");
  await ctx.db.from("events").insert({
    type: "lead.document",
    actor: "agent",
    conversation_id: ctx.conversationId,
    lead_id: ctx.lead.id,
    data: { count: data.length, descripcion },
  });
  return { result: { ok: true, registrados: data.length, no_encontrados: ids.length - data.length } };
}

async function consultarHuecos(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const cfg = loadAgenda();
  const preference = ["mañana", "tarde", "indiferente"].includes(String(input.preferencia)) ? (input.preferencia as "mañana" | "tarde" | "indiferente") : undefined;
  const fromYmd = typeof input.a_partir_de === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.a_partir_de) ? input.a_partir_de : undefined;

  let slots: Slot[];
  try {
    const provider = calendarProvider(ctx.db);
    const to = new Date(ctx.now.getTime() + (cfg.horizonteDias + 21) * 86_400_000);
    const busy = await provider.busy(ctx.now, to);
    slots = findSlots(cfg, busy, ctx.now, { preference, fromYmd });
  } catch (e) {
    return err(`No puedo consultar la agenda ahora mismo (${e instanceof Error ? e.message.slice(0, 120) : "error"}). Ofrece que el equipo le proponga fecha y deriva.`);
  }
  if (!slots.length) return { result: { huecos: [], nota: "No hay huecos con esos criterios. Pregunta otra franja o fecha." } };

  await ctx.db.from("leads").update({ offered_slots: slots }).eq("id", ctx.lead.id);
  ctx.lead.offered_slots = slots;
  return {
    result: {
      huecos: slots.map((s) => ({ id: s.id, etiqueta_boton: s.label, fecha: longLabel(new Date(s.start), cfg.zonaHoraria) })),
      duracion_minutos: cfg.duracionVisitaMin,
    },
  };
}

async function reservarVisita(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const cfg = loadAgenda();
  const slot = ctx.lead.offered_slots.find((s) => s.id === String(input.hueco_id));
  if (!slot) return err("Ese hueco no está entre los ofrecidos. Consulta huecos de nuevo y ofrécelos.");
  if (ctx.lead.visit_at) return err(`Ya hay una visita reservada (${longLabel(new Date(ctx.lead.visit_at), cfg.zonaHoraria)}). Si quiere cambiarla, deriva al equipo.`);

  const faltan: string[] = [];
  if (!ctx.lead.full_name) faltan.push("nombre");
  if (!ctx.lead.address || !/\d/.test(ctx.lead.address)) faltan.push("dirección completa (calle y número)");
  if (faltan.length) return err(`Antes de reservar necesito: ${faltan.join(" y ")}. Pídeselo al cliente y guárdalo con actualizar_ficha_cliente.`);

  const start = new Date(slot.start);
  const end = new Date(slot.end);
  const provider = calendarProvider(ctx.db);
  try {
    const busy = await provider.busy(new Date(start.getTime() - 3_600_000), new Date(end.getTime() + 3_600_000));
    if (busy.some((b) => b.start < end && start < b.end)) {
      return err("Ese hueco se acaba de ocupar. Consulta huecos de nuevo y ofrece otros.");
    }
  } catch (e) {
    return err(`No puedo confirmar la agenda ahora (${e instanceof Error ? e.message.slice(0, 120) : "error"}).`);
  }

  const appUrl = agentEnv().APP_URL;
  const tipo = ctx.lead.project_type?.replace("_", " ") ?? "proyecto";
  const event = await provider.createEvent({
    start,
    end,
    summary: `Visita técnica · ${ctx.lead.full_name} · ${tipo}`,
    location: ctx.lead.address,
    description: [
      `Cliente: ${ctx.lead.full_name} (+${ctx.contact.wa_id})`,
      `Proyecto: ${tipo}${ctx.lead.surface_m2 ? ` · ${ctx.lead.surface_m2} m²` : ""}`,
      ctx.lead.goals ? `Objetivos: ${ctx.lead.goals}` : null,
      appUrl ? `Expediente: ${appUrl}/inbox/${ctx.conversationId}` : null,
      "El briefing completo se envía por email.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const { data, error } = await ctx.db
    .from("leads")
    .update({ visit_at: start.toISOString(), visit_end_at: end.toISOString(), visit_calendar_event_id: event.id, status: "visit_scheduled", offered_slots: [] })
    .eq("id", ctx.lead.id)
    .select("*")
    .single();
  if (error || !data) throw new Error(`[db:lead visit] ${error?.message}`);
  ctx.lead = data as LeadRow;
  ctx.state.booked = true;

  await enqueueJob(ctx.db, BRIEFING_JOB, { leadId: ctx.lead.id }, { dedupeKey: `briefing:${ctx.lead.id}:${start.toISOString()}`, maxAttempts: 4 });
  await ctx.db.from("events").insert({
    type: "visit.booked",
    actor: "agent",
    conversation_id: ctx.conversationId,
    lead_id: ctx.lead.id,
    data: { start: start.toISOString(), calendar: provider.name, event_id: event.id },
  });

  return { result: { ok: true, visita: longLabel(start, cfg.zonaHoraria), direccion: ctx.lead.address, duracion_minutos: cfg.duracionVisitaMin } };
}

async function derivar(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const categorias = Object.keys(HANDOFF_MESSAGES) as HandoffCategory[];
  const categoria = categorias.includes(input.categoria as HandoffCategory) ? (input.categoria as HandoffCategory) : "otro";
  const resumen = String(input.resumen ?? "").slice(0, 1000);
  await applyHandoff(ctx.db, ctx.conversationId, ctx.lead, categoria, resumen, input.urgente === true, "agent");
  ctx.state.handedOff = categoria;
  return { result: { ok: true, nota: "Conversación pasada al equipo. Despídete en una frase (sin más preguntas)." } };
}

/** Deriva a una persona: modo humano, agente pausado, resumen en la ficha y evento (notificación). */
export async function applyHandoff(
  db: SupabaseClient,
  conversationId: string,
  lead: Pick<LeadRow, "id" | "status"> | null,
  categoria: HandoffCategory,
  resumen: string,
  urgente: boolean,
  actor: "agent" | "system",
) {
  await db.from("conversations").update({ status: "human", agent_active: false, handoff_reason: categoria }).eq("id", conversationId);
  if (lead) {
    await db
      .from("leads")
      .update({ handoff_summary: resumen, ...(lead.status === "visit_scheduled" ? {} : { status: "handed_off" }) })
      .eq("id", lead.id);
  }
  await db.from("events").insert({
    type: "agent.handoff",
    actor,
    conversation_id: conversationId,
    lead_id: lead?.id ?? null,
    data: { categoria, resumen, urgente },
  });
  await enqueuePush(db, { kind: "handoff", conversationId, categoria, resumen, urgente }, `push:handoff:${conversationId}:${Math.floor(Date.now() / 60_000)}`);
}

function enviarOpciones(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const texto = String(input.texto ?? "").trim();
  const opciones = Array.isArray(input.opciones) ? (input.opciones as Array<Record<string, unknown>>) : [];
  if (!texto) return err("Falta el texto del mensaje.");
  if (opciones.length < 2 || opciones.length > 10) return err("Entre 2 y 10 opciones.");
  const items = opciones.map((o) => ({ id: String(o.id ?? "").slice(0, 200), title: String(o.titulo ?? "").trim(), description: o.descripcion ? String(o.descripcion).trim() : undefined }));
  if (items.some((i) => !i.id || !i.title)) return err("Cada opción necesita id y titulo.");

  let content: OutboundInput;
  if (items.length <= 3 && items.every((i) => i.title.length <= LIMITS.buttonTitle)) {
    content = { type: "buttons", body: texto.slice(0, LIMITS.interactiveBody), buttons: items.map((i) => ({ id: i.id, title: i.title })) };
  } else {
    const tooLong = items.find((i) => i.title.length > LIMITS.rowTitle);
    if (tooLong) return err(`El título «${tooLong.title}» supera ${LIMITS.rowTitle} caracteres; acórtalo.`);
    content = {
      type: "list",
      body: texto,
      buttonText: String(input.texto_boton_lista ?? "Ver opciones").slice(0, LIMITS.listButton),
      sections: [{ rows: items.map((i) => ({ id: i.id, title: i.title, description: i.description?.slice(0, LIMITS.rowDescription) })) }],
    };
  }
  ctx.outbox.push(content);
  return { result: { ok: true, formato: content.type === "buttons" ? "botones" : "lista", nota: "Se enviará al cliente. No repitas las opciones en tu texto final." } };
}
