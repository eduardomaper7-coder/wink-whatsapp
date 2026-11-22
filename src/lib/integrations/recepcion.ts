import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "@/lib/log";
import { RetryLaterError } from "@/lib/jobs/queue";
import { sendMessage } from "@/lib/whatsapp/outbound/service";

/**
 * Integración con «Recepción del encargo» (la app de expedientes de Wink).
 *
 *   WhatsApp ─► Recepción  /api/integrations/whatsapp/lookup    quién es el número y cómo responder
 *   WhatsApp ─► Recepción  /api/integrations/whatsapp/messages  visita reservada · mensajes de cliente con expediente · personal
 *   WhatsApp ─► Recepción  /api/integrations/whatsapp/mode      cambiar el modo de respuesta de un expediente
 *   Recepción ─► WhatsApp  /api/integrations/recepcion/send     enviar una respuesta aprobada por un arquitecto
 *
 * Autenticación en ambos sentidos: "Authorization: Bearer INTEGRATION_SECRET" (mismo valor en las dos apps).
 * Sin RECEPCION_URL o INTEGRATION_SECRET la integración queda desactivada y la app funciona como antes.
 */

export const RECEPCION_FORWARD_JOB = "recepcion_forward";
export const RECEPCION_LEAD_JOB = "recepcion_lead";

export type ReplyMode = "solo_recibir" | "borrador" | "asistente" | "solo_equipo";
export const REPLY_MODES: ReplyMode[] = ["asistente", "borrador", "solo_recibir", "solo_equipo"];
export const REPLY_MODE_LABEL: Record<ReplyMode, string> = {
  asistente: "Asistente automático",
  borrador: "Borrador con aprobación",
  solo_recibir: "Solo recibir",
  solo_equipo: "Solo equipo",
};

export interface LookupResult {
  kind: "personal" | "cliente_con_expediente" | "cliente" | "desconocido";
  staff: { id: string; name: string } | null;
  client: { id: string; name: string | null; email: string | null } | null;
  project: { id: string; code: string; title: string | null; status: string; url: string } | null;
  mode: ReplyMode;
  modeSource: "expediente" | "ajustes";
  projectOptions: { id: string; code: string; title: string | null; visitAt: string | null }[];
}

/** Elegir expediente: id de las opciones enviadas al personal por WhatsApp. */
export const PROJECT_OPTION_PREFIX = "wnkexp:";
/** El expediente elegido por el personal vale durante unas horas (una visita). */
export const STAFF_PROJECT_TTL_MS = 12 * 3600_000;

export function recepcionEnabled(): boolean {
  return !!process.env.RECEPCION_URL && !!process.env.INTEGRATION_SECRET;
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const base = process.env.RECEPCION_URL!.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.INTEGRATION_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new RetryLaterError(`Recepción no responde (${e instanceof Error ? e.message : "red"})`, 30_000);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status >= 500 || res.status === 429) throw new RetryLaterError(`Recepción ${res.status}: ${data.error ?? ""}`, 30_000);
  if (!res.ok) throw new Error(`Recepción ${res.status}: ${data.error ?? "petición rechazada"}`);
  return data;
}

export const recepcion = {
  lookup: (waId: string, conversationId: string) => call<LookupResult>("/api/integrations/whatsapp/lookup", { waId, conversationId }),
  push: (payload: Record<string, unknown>) => call<{ emailId: string | null; duplicate: boolean }>("/api/integrations/whatsapp/messages", payload),
  setMode: (projectId: string, mode: ReplyMode | null, by: string | null) => call<{ ok: boolean }>("/api/integrations/whatsapp/mode", { projectId, mode, by }),
};

/** Consulta Recepción y guarda el resultado en la conversación (caché para el agente y la bandeja). */
export async function refreshRecepcionInfo(db: SupabaseClient, conversationId: string, waId: string): Promise<LookupResult> {
  const r = await recepcion.lookup(waId, conversationId);
  await db
    .from("conversations")
    .update({
      recepcion_kind: r.kind,
      recepcion_mode: r.mode,
      recepcion_mode_source: r.modeSource,
      recepcion_project_id: r.project?.id ?? null,
      recepcion_project_code: r.project?.code ?? null,
      recepcion_project_url: r.project?.url ?? null,
      recepcion_staff_name: r.staff?.name ?? null,
      recepcion_checked_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
  return r;
}

/** Modo efectivo de la conversación: el elegido en la bandeja manda sobre el de Recepción. */
export function effectiveMode(conv: { reply_mode_override?: string | null; recepcion_mode?: string | null; recepcion_kind?: string | null }): ReplyMode {
  if (conv.recepcion_kind === "personal") return "solo_recibir";
  return ((conv.reply_mode_override ?? conv.recepcion_mode ?? "asistente") as ReplyMode);
}

// ---------------------------------------------------------------------------------------------
// Reenvío de mensajes a Recepción
// ---------------------------------------------------------------------------------------------

interface PendingMsg {
  id: string;
  type: string;
  content: Record<string, unknown>;
  text_preview: string | null;
  media_status: string;
  wa_message_id: string | null;
  created_at: string;
}

function messageText(m: PendingMsg): string {
  const c = m.content ?? {};
  if (m.type === "text") return String(c.body ?? m.text_preview ?? "");
  if (m.type === "audio") return c.transcript ? `[Nota de voz] ${c.transcript}` : "[Nota de voz sin transcribir]";
  if (m.type === "location") return `[Ubicación] ${c.name ?? ""} ${c.address ?? ""} (${c.latitude}, ${c.longitude})`.trim();
  if (c.caption) return `[${m.type}] ${c.caption}`;
  return m.text_preview ?? "";
}

/** Mensajes del cliente aún no enviados a Recepción (excluye reacciones y la elección de expediente). */
async function pendingMessages(db: SupabaseClient, conversationId: string, since: string | null): Promise<PendingMsg[]> {
  let q = db
    .from("messages")
    .select("id, type, content, text_preview, media_status, wa_message_id, created_at")
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound")
    .neq("type", "reaction")
    .order("created_at", { ascending: true })
    .limit(50);
  if (since) q = q.gt("created_at", since);
  const { data, error } = await q;
  if (error) throw new Error(`[db:messages] ${error.message}`);
  return ((data ?? []) as PendingMsg[]).filter((m) => !String(m.content?.id ?? "").startsWith(PROJECT_OPTION_PREFIX));
}

async function signedAttachments(db: SupabaseClient, messageIds: string[]) {
  if (!messageIds.length) return [];
  const { data } = await db.from("attachments").select("storage_bucket, storage_path, mime_type, original_filename, caption, kind").in("message_id", messageIds);
  const out: { url: string; filename: string; mime: string; caption: string | null }[] = [];
  for (const a of data ?? []) {
    if (a.kind === "audio") continue; // las notas de voz van transcritas en el texto
    const { data: s } = await db.storage.from(a.storage_bucket).createSignedUrl(a.storage_path, 3600);
    if (s?.signedUrl) out.push({ url: s.signedUrl, filename: a.original_filename ?? a.storage_path.split("/").pop() ?? "adjunto", mime: a.mime_type ?? "application/octet-stream", caption: a.caption ?? null });
  }
  return out;
}

/** Envía a Recepción los mensajes pendientes de una conversación (cliente con expediente o personal). */
export async function forwardPending(db: SupabaseClient, conversationId: string, opts: { projectId?: string | null } = {}): Promise<number> {
  const { data: conv } = await db
    .from("conversations")
    .select("id, recepcion_forwarded_until, contact:contacts!inner(wa_id, name, profile_name, email)")
    .eq("id", conversationId)
    .single();
  if (!conv) return 0;
  const contact = conv.contact as unknown as { wa_id: string; name: string | null; profile_name: string | null; email: string | null };
  const pending = await pendingMessages(db, conversationId, conv.recepcion_forwarded_until as string | null);
  if (!pending.length) return 0;
  // Esperar a que se descargue/transcriba la multimedia
  const stillProcessing = pending.some((m) => m.media_status === "pending" || (m.type === "audio" && !m.content?.transcript && m.content?.transcript_status !== "failed" && m.media_status === "stored" && !!process.env.GROQ_API_KEY));
  const ageMs = Date.now() - new Date(pending[pending.length - 1]!.created_at).getTime();
  if (stillProcessing && ageMs < 120_000) throw new RetryLaterError("Multimedia en proceso", 5_000);

  const last = pending[pending.length - 1]!;
  const text = pending.map(messageText).filter(Boolean).join("\n");
  const attachments = await signedAttachments(db, pending.map((m) => m.id));
  await recepcion.push({
    kind: "message",
    key: `wa:${last.wa_message_id ?? last.id}`,
    conversationId,
    from: { waId: contact.wa_id, name: contact.name ?? contact.profile_name, email: contact.email },
    text,
    attachments,
    projectId: opts.projectId ?? null,
    sentAt: last.created_at,
  });
  await db.from("conversations").update({ recepcion_forwarded_until: last.created_at }).eq("id", conversationId);
  await db.from("events").insert({ type: "recepcion.forwarded", actor: "system", conversation_id: conversationId, data: { messages: pending.length, attachments: attachments.length, project: opts.projectId ?? null } });
  return pending.length;
}

/**
 * Trabajo recepcion_forward: decide qué hacer con lo que acaba de escribir un número.
 *  - Personal de Wink → sus mensajes van al expediente elegido (si hay varias opciones, se le pregunta con una lista).
 *  - Cliente con expediente → se envía a Recepción (se incorpora al expediente y se avisa al responsable).
 *  - Cliente nuevo → nada: lo atiende el asistente de captación; al reservar visita se crea el expediente.
 */
export async function runForwardJob(db: SupabaseClient, conversationId: string): Promise<void> {
  if (!recepcionEnabled()) return;
  const { data: conv } = await db
    .from("conversations")
    .select("id, staff_project_id, staff_project_code, staff_project_at, contact:contacts!inner(wa_id)")
    .eq("id", conversationId)
    .single();
  if (!conv) return;
  const waId = (conv.contact as unknown as { wa_id: string }).wa_id;
  const info = await refreshRecepcionInfo(db, conversationId, waId);

  if (info.kind === "cliente_con_expediente") {
    await forwardPending(db, conversationId);
    return;
  }
  if (info.kind !== "personal") return;

  // ¿Acaba de elegir expediente en la lista?
  const { data: lastIn } = await db
    .from("messages")
    .select("content, created_at")
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound")
    .eq("type", "interactive")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const chosenId = String((lastIn?.content as Record<string, unknown> | null)?.id ?? "");
  let projectId = conv.staff_project_id as string | null;
  let projectCode = conv.staff_project_code as string | null;
  const fresh = conv.staff_project_at && Date.now() - new Date(conv.staff_project_at as string).getTime() < STAFF_PROJECT_TTL_MS;

  // Código escrito a mano ("WNK-2026-0004") en un mensaje posterior a la última elección: manda siempre
  const { data: lastText } = await db
    .from("messages")
    .select("content, created_at")
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound")
    .eq("type", "text")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const typedCode = /WNK-\d{4}-\d{3,5}/i.exec(String((lastText?.content as Record<string, unknown> | null)?.body ?? ""))?.[0]?.toUpperCase();
  const typedIsNew = !!lastText && (!conv.staff_project_at || new Date(lastText.created_at) > new Date(conv.staff_project_at as string));
  const byTypedCode = typedCode && typedIsNew ? info.projectOptions.find((o) => o.code.toUpperCase() === typedCode) : undefined;
  const choiceIsNew = chosenId.startsWith(PROJECT_OPTION_PREFIX) && lastIn && (!conv.staff_project_at || new Date(lastIn.created_at) > new Date(conv.staff_project_at as string));

  if (byTypedCode && (!choiceIsNew || new Date(lastText!.created_at) > new Date(lastIn!.created_at))) {
    projectId = byTypedCode.id;
    projectCode = byTypedCode.code;
    await db.from("conversations").update({ staff_project_id: projectId, staff_project_code: projectCode, staff_project_at: new Date().toISOString() }).eq("id", conversationId);
    await sendMessage(db, { conversationId, author: "system", content: { type: "text", body: `Anotado ✅ Lo que envíes durante las próximas horas irá al expediente ${projectCode}.` } });
  } else if (typedCode && typedIsNew && !byTypedCode) {
    await sendMessage(db, { conversationId, author: "system", content: { type: "text", body: `No encuentro el expediente ${typedCode} entre los activos. Revisa el código o elige uno de la lista.` } });
    projectId = null;
  } else if (choiceIsNew) {
    const id = chosenId.slice(PROJECT_OPTION_PREFIX.length);
    const opt = info.projectOptions.find((o) => o.id === id);
    if (opt) {
      projectId = opt.id;
      projectCode = opt.code;
      await db.from("conversations").update({ staff_project_id: projectId, staff_project_code: projectCode, staff_project_at: new Date().toISOString() }).eq("id", conversationId);
      await sendMessage(db, { conversationId, author: "system", content: { type: "text", body: `Anotado ✅ Lo que envíes durante las próximas horas irá al expediente ${projectCode}.` } });
    }
  } else if (!fresh) {
    projectId = null;
    const only = info.projectOptions.length === 1 ? info.projectOptions[0] : undefined;
    const pick = only;
    if (pick) {
      projectId = pick.id;
      projectCode = pick.code;
      await db.from("conversations").update({ staff_project_id: projectId, staff_project_code: projectCode, staff_project_at: new Date().toISOString() }).eq("id", conversationId);
      await sendMessage(db, { conversationId, author: "system", content: { type: "text", body: `Anotado ✅ Lo envío al expediente ${projectCode}.` } });
    }
  }

  if (projectId) {
    await forwardPending(db, conversationId, { projectId });
    return;
  }

  // Sin expediente elegido: preguntar (una vez cada 10 minutos como mucho)
  const { data: asked } = await db
    .from("events")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("type", "recepcion.ask_project")
    .gt("created_at", new Date(Date.now() - 10 * 60_000).toISOString())
    .limit(1);
  if (asked?.length) return;
  if (!info.projectOptions.length) {
    await sendMessage(db, { conversationId, author: "system", content: { type: "text", body: `Hola ${info.staff?.name.split(" ")[0] ?? ""}. No tienes expedientes asignados ni visitas próximas. Escríbeme el código del expediente (por ejemplo WNK-2026-0001) para guardar lo que envíes.` } });
  } else {
    await sendMessage(db, {
      conversationId,
      author: "system",
      content: {
        type: "list",
        body: `Hola ${info.staff?.name.split(" ")[0] ?? ""}. ¿A qué expediente guardo lo que me envías?`,
        buttonText: "Elegir expediente",
        sections: [
          {
            rows: info.projectOptions.slice(0, 10).map((o) => ({
              id: `${PROJECT_OPTION_PREFIX}${o.id}`,
              title: o.code.slice(0, 24),
              description: (o.title ?? (o.visitAt ? `Visita ${new Date(o.visitAt).toLocaleString("es-ES", { timeZone: "Europe/Madrid", dateStyle: "short", timeStyle: "short" })}` : "")).slice(0, 72),
            })),
          },
        ],
      },
    });
  }
  await db.from("events").insert({ type: "recepcion.ask_project", actor: "system", conversation_id: conversationId, data: { options: info.projectOptions.length } });
}

/** Trabajo recepcion_lead: visita reservada por el asistente → expediente en Recepción con todo lo recibido. */
export async function runLeadJob(db: SupabaseClient, leadId: string): Promise<void> {
  if (!recepcionEnabled()) return;
  const { data: lead } = await db.from("leads").select("*, contact:contacts!inner(wa_id, name, profile_name, email)").eq("id", leadId).single();
  if (!lead || !lead.visit_at || !lead.conversation_id) return;
  const contact = lead.contact as { wa_id: string; name: string | null; profile_name: string | null; email: string | null };

  const { data: msgs } = await db
    .from("messages")
    .select("id, direction, author, type, content, text_preview, created_at")
    .eq("conversation_id", lead.conversation_id)
    .neq("type", "reaction")
    .order("created_at", { ascending: true })
    .limit(200);
  const transcript = (msgs ?? [])
    .map((m) => `${m.direction === "inbound" ? "Cliente" : m.author === "agent" ? "Asistente" : "Wink"}: ${messageText(m as unknown as PendingMsg)}`)
    .join("\n");
  const ficha = [
    `Nombre: ${lead.full_name ?? contact.name ?? contact.profile_name ?? "—"}`,
    `Teléfono: +${contact.wa_id}`,
    lead.contact_email ?? contact.email ? `Email: ${lead.contact_email ?? contact.email}` : null,
    lead.project_type ? `Tipo de proyecto: ${lead.project_type}${lead.project_type_other ? ` (${lead.project_type_other})` : ""}` : null,
    lead.address ? `Dirección: ${lead.address}` : null,
    lead.surface_m2 ? `Superficie aproximada: ${lead.surface_m2} m²` : null,
    lead.property_state ? `Estado actual: ${lead.property_state}` : null,
    lead.goals ? `Qué quiere: ${lead.goals}` : null,
    lead.budget_range ? `Presupuesto orientativo: ${lead.budget_range}` : null,
    lead.desired_timeline ? `Plazos: ${lead.desired_timeline}` : null,
  ].filter(Boolean);

  const { data: atts } = await db.from("attachments").select("message_id").eq("conversation_id", lead.conversation_id);
  const attachments = await signedAttachments(db, (atts ?? []).map((a) => a.message_id as string));

  const r = await recepcion.push({
    kind: "lead_visit_booked",
    key: `lead:${leadId}:${lead.visit_at}`,
    conversationId: lead.conversation_id,
    from: { waId: contact.wa_id, name: lead.full_name ?? contact.name ?? contact.profile_name, email: lead.contact_email ?? contact.email },
    text: [
      "Encargo recibido por WhatsApp. El asistente de captación ha reservado la visita técnica.",
      "",
      "FICHA RECOGIDA POR EL ASISTENTE:",
      ...ficha,
      "",
      "CONVERSACIÓN COMPLETA (las respuestas del asistente son contexto, no datos del cliente):",
      transcript,
    ].join("\n"),
    attachments,
    visit: { start: new Date(lead.visit_at).toISOString(), end: lead.visit_end_at ? new Date(lead.visit_end_at).toISOString() : null },
    sentAt: new Date().toISOString(),
  });
  const last = (msgs ?? []).filter((m) => m.direction === "inbound").pop();
  await db.from("leads").update({ recepcion_sent_at: new Date().toISOString() }).eq("id", leadId);
  if (last) await db.from("conversations").update({ recepcion_forwarded_until: last.created_at }).eq("id", lead.conversation_id);
  await db.from("events").insert({ type: "recepcion.lead_sent", actor: "system", conversation_id: lead.conversation_id, lead_id: leadId, data: { attachments: attachments.length, duplicate: r.duplicate } });
  log.info("recepcion.lead_sent", { leadId, attachments: attachments.length });
}
