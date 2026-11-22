import type { SupabaseClient } from "@supabase/supabase-js";

export interface LeadRow {
  id: string;
  contact_id: string;
  conversation_id: string | null;
  status: string;
  source: string | null;
  full_name: string | null;
  project_type: string | null;
  project_type_other: string | null;
  address: string | null;
  city: string | null;
  surface_m2: number | null;
  property_state: string | null;
  goals: string | null;
  budget_range: string | null;
  desired_timeline: string | null;
  contact_preference: string | null;
  contact_preference_notes: string | null;
  contact_email: string | null;
  missing_fields: string[];
  offered_slots: Array<{ id: string; start: string; end: string; label: string }>;
  visit_at: string | null;
  visit_end_at: string | null;
  visit_calendar_event_id: string | null;
  briefing_md: string | null;
  handoff_summary: string | null;
  classification: Record<string, unknown> | null;
  created_at: string;
}

/** Campos de la ficha y su nombre para el agente / la interfaz. */
export const LEAD_FIELDS: Record<string, string> = {
  full_name: "nombre",
  project_type: "tipo de proyecto",
  address: "dirección o barrio",
  surface_m2: "superficie aproximada",
  property_state: "estado actual de la vivienda",
  goals: "qué quiere conseguir",
  budget_range: "presupuesto orientativo",
  desired_timeline: "plazos deseados",
  contact_preference: "cómo prefiere que le contactemos",
};

export function missingFields(lead: Partial<LeadRow>): string[] {
  return Object.keys(LEAD_FIELDS).filter((k) => {
    const v = lead[k as keyof LeadRow];
    return v === null || v === undefined || v === "";
  });
}

/** Expediente abierto de la conversación; lo crea si no existe. */
export async function getOrCreateLead(db: SupabaseClient, conversationId: string, contactId: string, source?: string | null): Promise<LeadRow> {
  const { data: existing, error } = await db
    .from("leads")
    .select("*")
    .eq("conversation_id", conversationId)
    .not("status", "in", "(closed,lost,won)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`[db:lead] ${error.message}`);
  if (existing) return existing as LeadRow;

  const { data: created, error: insErr } = await db
    .from("leads")
    .insert({ conversation_id: conversationId, contact_id: contactId, status: "new", source: source ?? "whatsapp", missing_fields: Object.keys(LEAD_FIELDS) })
    .select("*")
    .single();
  if (insErr || !created) throw new Error(`[db:create lead] ${insErr?.message}`);

  // Adjuntos que llegaron antes de existir el expediente
  await db.from("attachments").update({ lead_id: created.id }).eq("conversation_id", conversationId).is("lead_id", null);
  await db.from("events").insert({ type: "lead.created", actor: "agent", conversation_id: conversationId, lead_id: created.id, data: { source: source ?? "whatsapp" } });
  return created as LeadRow;
}

/** Ficha resumida para el contexto del agente (sin campos internos). */
export function leadForPrompt(lead: LeadRow) {
  return {
    estado: lead.status,
    nombre: lead.full_name,
    tipo_proyecto: lead.project_type === "otro" ? `otro (${lead.project_type_other ?? "sin detallar"})` : lead.project_type,
    direccion_o_barrio: lead.address,
    superficie_m2: lead.surface_m2,
    estado_vivienda: lead.property_state,
    objetivos: lead.goals,
    presupuesto_orientativo: lead.budget_range,
    plazos_deseados: lead.desired_timeline,
    preferencia_contacto: lead.contact_preference,
    detalle_contacto: lead.contact_preference_notes,
    email: lead.contact_email,
    visita_reservada: lead.visit_at,
    campos_pendientes: missingFields(lead).map((k) => LEAD_FIELDS[k]),
  };
}
