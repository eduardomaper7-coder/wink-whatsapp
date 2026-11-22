import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaude, ClaudeApiError, textOf, type ClaudeMessage, type ContentBlock } from "@/lib/ai/anthropic";
import { localDate, longLabel } from "@/lib/calendar/time";
import { RetryLaterError } from "@/lib/jobs/queue";
import { log } from "@/lib/log";
import type { OutboundInput } from "@/lib/whatsapp/outbound/schema";
import { sendMessage } from "@/lib/whatsapp/outbound/service";
import { windowState } from "@/lib/whatsapp/window";
import { classify, HANDOFF_MESSAGES, mandatoryHandoff, type Classification } from "./classifier";
import { agentEnv, loadAgenda, loadKnowledgeBase, loadSystemPrompt, privacyNotice } from "./config";
import { ensurePrivacyNotice, guardOutgoing } from "./guardrails";
import { getOrCreateLead, leadForPrompt, type LeadRow } from "./lead";
import { applyHandoff, executeTool, TOOL_DEFINITIONS, type ToolContext } from "./tools";
import { effectiveMode, recepcionEnabled, refreshRecepcionInfo, REPLY_MODE_LABEL } from "@/lib/integrations/recepcion";
import { buildTranscript, hasPendingCustomerMessages, type HistoryMessage } from "./transcript";

export const AGENT_JOB = "agent_reply";

export type AgentOutcome = "replied" | "handed_off" | "skipped" | "superseded" | "rescheduled" | "error";

export interface AgentRunResult {
  outcome: AgentOutcome;
  reason?: string;
  sent: number;
  runId?: string;
}

interface ToolAudit {
  name: string;
  motivo: string | null;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  is_error: boolean;
  ms: number;
}

const MEDIA_WAIT_MS = 90_000;

/**
 * Una ejecución del agente sobre una conversación:
 * bloqueo → comprobaciones → clasificación (Haiku) → bucle con herramientas (Sonnet)
 * → salvaguardas → envío → auditoría (agent_runs).
 */
export async function runAgent(db: SupabaseClient, conversationId: string): Promise<AgentRunResult> {
  const env = agentEnv();
  if (!env.ANTHROPIC_API_KEY) {
    log.warn("agent.not_configured");
    return { outcome: "skipped", reason: "sin ANTHROPIC_API_KEY", sent: 0 };
  }

  const { data: locked } = await db.rpc("try_lock_agent", { p_conversation_id: conversationId, p_seconds: 150 });
  if (!locked) {
    // Otra ejecución en curso para esta conversación: probar en unos segundos
    throw new RetryLaterError("Conversación bloqueada por otra ejecución del agente", 8_000);
  }

  const started = Date.now();
  const runId = randomUUID();
  const audit: ToolAudit[] = [];
  const usage = { input: 0, output: 0 };
  let classification: Classification | null = null;

  try {
    // ------------------------------------------------------------ carga
    const { data: conv } = await db
      .from("conversations")
      .select("id, status, agent_active, last_inbound_at, contact:contacts!inner(id, wa_id, name, profile_name, consent_notice_sent_at, consent_at, is_existing_client, is_supplier)")
      .eq("id", conversationId)
      .maybeSingle();
    if (!conv) return { outcome: "skipped", reason: "conversación no encontrada", sent: 0 };
    if (!conv.agent_active || conv.status !== "bot") return { outcome: "skipped", reason: "agente pausado", sent: 0 };
    if (!windowState(conv.last_inbound_at as string | null).open) return { outcome: "skipped", reason: "ventana cerrada", sent: 0 };

    // Recepción del encargo: el personal de Wink y los modos distintos de «asistente» no los atiende el asistente
    if (recepcionEnabled()) {
      const { data: rc } = await db.from("conversations").select("recepcion_kind, recepcion_mode, reply_mode_override, recepcion_checked_at").eq("id", conversationId).single();
      let info = rc;
      const stale = !rc?.recepcion_checked_at || Date.now() - new Date(rc.recepcion_checked_at as string).getTime() > 10 * 60_000;
      if (stale) {
        try {
          const r = await refreshRecepcionInfo(db, conversationId, (conv.contact as unknown as { wa_id: string }).wa_id);
          info = { recepcion_kind: r.kind, recepcion_mode: r.mode, reply_mode_override: rc?.reply_mode_override ?? null, recepcion_checked_at: new Date().toISOString() };
        } catch (e) {
          log.warn("agent.recepcion_lookup_failed", { error: e });
        }
      }
      const mode = effectiveMode(info ?? {});
      if (info?.recepcion_kind === "personal" || mode !== "asistente") {
        const reason = info?.recepcion_kind === "personal" ? "personal de Wink" : `modo «${REPLY_MODE_LABEL[mode]}»`;
        await db.from("conversations").update({ agent_active: false, status: "human", handoff_reason: info?.recepcion_kind === "personal" ? "personal_wink" : `modo_${mode}` }).eq("id", conversationId).eq("status", "bot");
        return { outcome: "skipped", reason, sent: 0 };
      }
    }

    const contact = conv.contact as unknown as {
      id: string;
      wa_id: string;
      name: string | null;
      profile_name: string | null;
      consent_notice_sent_at: string | null;
      consent_at: string | null;
      is_existing_client: boolean;
      is_supplier: boolean;
    };

    const history = await loadHistory(db, conversationId, env.AGENT_HISTORY_MESSAGES);
    if (!hasPendingCustomerMessages(history)) return { outcome: "skipped", reason: "nada que responder", sent: 0 };

    // Esperar a que termine la descarga/transcripción de la multimedia reciente
    if (mediaStillProcessing(history)) {
      await db.rpc("schedule_agent_run", { p_conversation_id: conversationId, p_delay_seconds: 4 });
      return { outcome: "rescheduled", reason: "multimedia en proceso", sent: 0 };
    }

    const lastInboundId = [...history].reverse().find((m) => m.direction === "inbound")!.id;
    const pending = pendingCustomerMessages(history);
    const referral = pending.find((m) => m.content?.referral)?.content?.referral as { source_type?: string; headline?: string } | undefined;
    let lead = await getOrCreateLead(db, conversationId, contact.id, referral ? `anuncio: ${referral.headline ?? referral.source_type ?? "click-to-whatsapp"}` : "whatsapp");

    // Consentimiento: si ya se envió el aviso y el cliente sigue escribiendo, queda registrado
    if (contact.consent_notice_sent_at && !contact.consent_at) {
      await db.from("contacts").update({ consent_at: new Date().toISOString() }).eq("id", contact.id);
    }
    const firstContact = !contact.consent_notice_sent_at;

    // ------------------------------------------------------------ clasificación (Haiku)
    try {
      const customerText = history
        .filter((m) => m.direction === "inbound")
        .slice(-6)
        .map((m) => `- ${m.text_preview ?? ""}`)
        .join("\n");
      classification = await classify(customerText, { esPrimerContacto: firstContact, yaEsCliente: contact.is_existing_client, esProveedor: contact.is_supplier });
      if (classification) await db.from("leads").update({ classification }).eq("id", lead.id);
    } catch (e) {
      log.warn("agent.classify_failed", { error: e });
    }

    const forced = mandatoryHandoff(classification) ?? (contact.is_existing_client ? "obra_en_curso" : contact.is_supplier ? "proveedor" : null);
    if (forced) {
      const resumen = classification?.resumen || `Derivación automática (${forced}).`;
      await applyHandoff(db, conversationId, lead, forced, resumen, classification?.urgente ?? false, "agent");
      let text = HANDOFF_MESSAGES[forced];
      if (firstContact) text = `Hola, soy el asistente de Wink. ${text}`;
      const sent = await deliver(db, conversationId, runId, contact, firstContact, [{ type: "text", body: text }], { allowHuman: true });
      await saveRun(db, { runId, conversationId, pending, model: env.AGENT_MODEL_CLASSIFY, usage, audit, classification, reply: text, outcome: "handed_off", started });
      return { outcome: "handed_off", reason: forced, sent, runId };
    }

    // ------------------------------------------------------------ agente (Sonnet + herramientas)
    const ctx: ToolContext = { db, conversationId, contact: { id: contact.id, wa_id: contact.wa_id, name: contact.name }, lead, now: new Date(), outbox: [], state: {} };
    const system = [
      { type: "text" as const, text: `${loadSystemPrompt()}\n\n---\n\n${loadKnowledgeBase()}`, cache_control: { type: "ephemeral" as const } },
      { type: "text" as const, text: dynamicContext(lead, contact, firstContact, classification) },
    ];
    const messages: ClaudeMessage[] = buildTranscript(history);
    let finalText = "";

    for (let turn = 0; turn < env.AGENT_MAX_TURNS; turn++) {
      const res = await callClaude({ model: env.AGENT_MODEL_CHAT, max_tokens: 2000, system, messages, tools: TOOL_DEFINITIONS, effort: env.AGENT_EFFORT_CHAT });
      usage.input += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
      usage.output += res.usage.output_tokens;
      // Se devuelve el turno completo (incluidos bloques de pensamiento) sin modificar
      messages.push({ role: "assistant", content: res.content });

      const toolUses = res.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !toolUses.length) {
        finalText = textOf(res.content);
        break;
      }

      const results: ContentBlock[] = [];
      for (const tu of toolUses) {
        const t0 = Date.now();
        let out;
        try {
          out = await executeTool(tu.name, tu.input ?? {}, ctx);
        } catch (e) {
          log.error("agent.tool_failed", { tool: tu.name, error: e });
          out = { result: { error: "Error interno al ejecutar la herramienta. No lo reintentes; si es importante, deriva al equipo." }, isError: true };
        }
        audit.push({ name: tu.name, motivo: typeof tu.input?.motivo === "string" ? tu.input.motivo : null, input: tu.input ?? {}, result: out.result, is_error: !!out.isError, ms: Date.now() - t0 });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out.result), ...(out.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
      if (turn === env.AGENT_MAX_TURNS - 1) log.warn("agent.max_turns", { conversationId });
    }
    lead = ctx.lead;

    // ------------------------------------------------------------ antes de enviar
    // ¿Ha escrito el cliente mientras pensábamos? → descartar y responder a todo junto
    const { data: newer } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("direction", "inbound")
      .neq("type", "reaction")
      .gt("created_at", history.find((m) => m.id === lastInboundId)!.created_at)
      .limit(1);
    if (newer?.length && !ctx.state.handedOff) {
      await db.rpc("schedule_agent_run", { p_conversation_id: conversationId, p_delay_seconds: 2 });
      await saveRun(db, { runId, conversationId, pending, model: env.AGENT_MODEL_CHAT, usage, audit, classification, reply: finalText, outcome: "superseded", started });
      return { outcome: "superseded", sent: 0, runId };
    }

    const outgoing: OutboundInput[] = [];
    let guardBlocked = false;
    if (finalText) {
      const g = guardOutgoing(finalText);
      guardBlocked ||= g.blocked;
      outgoing.push({ type: "text", body: g.text });
    }
    for (const item of ctx.outbox) {
      if (item.type === "buttons" || item.type === "list") {
        const g = guardOutgoing(item.body);
        guardBlocked ||= g.blocked;
        outgoing.push(g.blocked ? { type: "text", body: g.text } : item);
      } else outgoing.push(item);
    }
    if (guardBlocked) await db.from("events").insert({ type: "agent.guardrail", actor: "agent", conversation_id: conversationId, data: { reason: "precio" } });

    const sent = await deliver(db, conversationId, runId, contact, firstContact, outgoing, { allowHuman: !!ctx.state.handedOff });

    if (ctx.state.close && !ctx.state.handedOff) {
      await db.from("conversations").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", conversationId);
      await db.from("events").insert({ type: "conversation.closed", actor: "agent", conversation_id: conversationId, data: {} });
    }

    const outcome: AgentOutcome = ctx.state.handedOff ? "handed_off" : "replied";
    await saveRun(db, { runId, conversationId, pending, model: env.AGENT_MODEL_CHAT, usage, audit, classification, reply: outgoing.map(previewText).join("\n---\n"), outcome, started });
    return { outcome, sent, runId };
  } catch (e) {
    if (e instanceof RetryLaterError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    await saveRun(db, { runId, conversationId, pending: [], model: env.AGENT_MODEL_CHAT, usage, audit, classification, reply: null, outcome: "error", started, error: message }).catch(() => {});
    if (e instanceof ClaudeApiError && e.retryable) throw new RetryLaterError(message, 20_000);
    throw e;
  } finally {
    await db.rpc("release_agent_lock", { p_conversation_id: conversationId });
  }
}

// ---------------------------------------------------------------------
// Envío (con aviso de privacidad en el primer contacto)
// ---------------------------------------------------------------------
async function deliver(
  db: SupabaseClient,
  conversationId: string,
  runId: string,
  contact: { id: string },
  firstContact: boolean,
  items: OutboundInput[],
  opts: { allowHuman: boolean },
): Promise<number> {
  if (!items.length) return 0;

  // Última comprobación: si una persona ha tomado la conversación, el agente no habla
  if (!opts.allowHuman) {
    const { data } = await db.from("conversations").select("agent_active, status").eq("id", conversationId).single();
    if (!data?.agent_active || data.status !== "bot") {
      log.info("agent.discarded_human_took_over", { conversationId });
      return 0;
    }
  }

  if (firstContact) {
    const url = agentEnv().PRIVACY_POLICY_URL;
    const idx = items.findIndex((i) => i.type === "text" || i.type === "buttons" || i.type === "list");
    if (idx >= 0) {
      const it = items[idx]!;
      if (it.type === "text") items[idx] = { ...it, body: ensurePrivacyNotice(it.body, privacyNotice(), url) };
      else if (it.type === "buttons" || it.type === "list") items[idx] = { ...it, body: ensurePrivacyNotice(it.body, privacyNotice(), url) };
    }
  }

  let sent = 0;
  for (const [i, content] of items.entries()) {
    const msg = await sendMessage(db, { conversationId, content, author: "agent", clientRef: `agent:${runId}:${i}` });
    if (msg.status !== "failed") sent++;
  }
  if (firstContact && sent > 0) {
    await db.from("contacts").update({ consent_notice_sent_at: new Date().toISOString() }).eq("id", contact.id);
  }
  return sent;
}

// ---------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------
async function loadHistory(db: SupabaseClient, conversationId: string, limit: number): Promise<HistoryMessage[]> {
  const { data, error } = await db
    .from("messages")
    .select("id, direction, author, type, content, text_preview, created_at, media_status, sender:profiles(full_name), attachment:attachments(id)")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`[db:history] ${error.message}`);
  return (data ?? []).reverse().map((m) => {
    const sender = m.sender as unknown as { full_name: string } | null;
    const att = m.attachment as unknown as Array<{ id: string }> | { id: string } | null;
    const attachmentId = Array.isArray(att) ? att[0]?.id : att?.id;
    return { ...(m as unknown as HistoryMessage), sender_name: sender?.full_name ?? null, attachment_id: attachmentId ?? null };
  });
}

function pendingCustomerMessages(history: HistoryMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (let i = history.length - 1; i >= 0 && history[i]!.direction === "inbound"; i--) out.unshift(history[i]!);
  return out;
}

export function mediaStillProcessing(history: HistoryMessage[], now = Date.now()): boolean {
  const recent = pendingCustomerMessages(history).filter((m) => now - new Date(m.created_at).getTime() < MEDIA_WAIT_MS);
  for (const m of recent) {
    if (m.media_status === "pending") return true;
    if (m.type === "audio" && agentEnv().GROQ_API_KEY && m.content?.transcript === undefined && m.content?.transcript_status !== "failed") return true;
  }
  return false;
}

function dynamicContext(lead: LeadRow, contact: { wa_id: string; profile_name: string | null }, firstContact: boolean, cls: Classification | null): string {
  const tz = loadAgenda().zonaHoraria;
  const now = new Date();
  const today = localDate(now, tz);
  return [
    "# Contexto de la conversación (generado automáticamente)",
    `- Ahora: ${longLabel(now, tz)} (${today.ymd}), hora de Madrid.`,
    `- Nombre del perfil de WhatsApp: ${contact.profile_name ?? "desconocido"} (no lo des por bueno; confirma cómo quiere que le llames).`,
    `- ¿Primer contacto? ${firstContact ? "SÍ → preséntate e incluye este aviso de privacidad en tu mensaje: «" + privacyNotice() + "»" : "No (el aviso de privacidad ya se envió)."}`,
    cls ? `- Clasificación automática: ${cls.categoria} (confianza ${cls.confianza}).` : "",
    lead.visit_at ? `- Visita ya reservada: ${longLabel(new Date(lead.visit_at), tz)}.` : "",
    lead.offered_slots?.length ? `- Huecos ofrecidos y aún válidos: ${lead.offered_slots.map((s) => `${s.id} (${s.label})`).join(", ")}.` : "",
    "",
    "## Ficha actual del expediente",
    "```json",
    JSON.stringify(leadForPrompt(lead), null, 2),
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function previewText(c: OutboundInput): string {
  if (c.type === "text") return c.body;
  if (c.type === "buttons") return `${c.body} [${c.buttons.map((b) => b.title).join(" | ")}]`;
  if (c.type === "list") return `${c.body} [lista: ${c.sections.flatMap((s) => s.rows.map((r) => r.title)).join(" | ")}]`;
  return c.type;
}

async function saveRun(
  db: SupabaseClient,
  r: {
    runId: string;
    conversationId: string;
    pending: HistoryMessage[];
    model: string;
    usage: { input: number; output: number };
    audit: ToolAudit[];
    classification: Classification | null;
    reply: string | null;
    outcome: AgentOutcome;
    started: number;
    error?: string;
  },
) {
  const toolCalls = [...(r.classification ? [{ name: "clasificacion", motivo: "Clasificación previa (modelo económico)", input: {}, result: r.classification, is_error: false, ms: 0 }] : []), ...r.audit];
  await db.from("agent_runs").insert({
    id: r.runId,
    conversation_id: r.conversationId,
    trigger_message_ids: r.pending.map((m) => m.id),
    model: r.model,
    input_tokens: r.usage.input,
    output_tokens: r.usage.output,
    tool_calls: toolCalls,
    reply_text: r.reply,
    outcome: r.outcome,
    error: r.error ?? null,
    duration_ms: Date.now() - r.started,
  });
}

/** Si el agente falla de forma definitiva, el cliente no puede quedarse sin respuesta: se deriva. */
export async function agentFailedHandoff(db: SupabaseClient, conversationId: string, error: string) {
  const { data: lead } = await db.from("leads").select("id, status").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  await applyHandoff(db, conversationId, lead ?? null, "error", `El asistente no pudo responder (${error.slice(0, 200)}). Revisa la conversación.`, true, "system");
}
