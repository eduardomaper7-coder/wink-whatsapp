import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaude, textOf } from "@/lib/ai/anthropic";
import { longLabel } from "@/lib/calendar/time";
import { log } from "@/lib/log";
import { markdownToHtml, sendEmail } from "@/lib/notify/email";
import { agentEnv, loadAgenda } from "./config";
import { leadForPrompt, type LeadRow } from "./lead";
import { buildTranscript, type HistoryMessage } from "./transcript";

const BRIEFING_PROMPT = `Eres un asistente del estudio de arquitectura Wink (Madrid). Redacta el BRIEFING que leerá el arquitecto antes de la visita técnica a la vivienda de un cliente.

Escribe en español de España, en Markdown, claro y profesional, sin relleno. Usa EXACTAMENTE estas secciones:

## Resumen
2–3 frases: quién es el cliente, qué quiere y en qué punto está.

## Cliente
Nombre, teléfono, preferencia de contacto y cualquier dato personal relevante que haya compartido (sin inventar).

## Necesidades y objetivos
Lo que quiere conseguir, estilo, prioridades, presupuesto orientativo y plazos deseados TAL COMO LOS EXPRESÓ el cliente.

## Datos del inmueble
Dirección, superficie, estado actual, particularidades mencionadas.

## Documentación recibida
Lista de fotos/planos/documentos con su descripción. Si no hay, indícalo.

## Dudas y puntos a confirmar en la visita
Lo que falta por saber o conviene comprobar (datos pendientes, preguntas que hizo el cliente y que se le dijo que valoraría el arquitecto, posibles condicionantes que mencionó).

## Recomendaciones para la visita
3–5 viñetas prácticas basadas SOLO en lo hablado.

Reglas: no inventes datos; si algo no se sabe, escribe «No indicado». No incluyas precios ni estimaciones de coste o plazos de obra.`;

/** Genera el briefing con el modelo potente, lo guarda en el expediente y lo envía por email. */
export async function generateAndSendBriefing(db: SupabaseClient, leadId: string): Promise<{ emailed: boolean }> {
  const aenv = agentEnv();
  const { data: lead, error } = await db.from("leads").select("*, contact:contacts!inner(wa_id, profile_name)").eq("id", leadId).single();
  if (error || !lead) throw new Error(`[db:briefing lead] ${error?.message}`);
  const l = lead as LeadRow & { contact: { wa_id: string; profile_name: string | null } };

  const { data: msgs } = await db
    .from("messages")
    .select("id, direction, author, type, content, text_preview, created_at, sender:profiles(full_name)")
    .eq("conversation_id", l.conversation_id!)
    .order("created_at", { ascending: true })
    .limit(300);
  const history = (msgs ?? []).map((m) => ({ ...(m as unknown as HistoryMessage), sender_name: (m.sender as unknown as { full_name: string } | null)?.full_name ?? null }));
  const transcript = buildTranscript(history)
    .map((m) => `${m.role === "user" ? "CLIENTE" : "WINK"}: ${String(m.content)}`)
    .join("\n");

  const { data: atts } = await db.from("attachments").select("id, kind, original_filename, description, storage_bucket, storage_path, created_at").eq("lead_id", leadId);
  const tz = loadAgenda().zonaHoraria;
  const visit = l.visit_at ? longLabel(new Date(l.visit_at), tz) : "sin fecha";

  const res = await callClaude(
    {
      model: aenv.AGENT_MODEL_BRIEFING,
      max_tokens: 3000,
      system: [{ type: "text", text: BRIEFING_PROMPT }],
      messages: [
        {
          role: "user",
          content: [
            `Visita técnica: ${visit} · Dirección: ${l.address ?? "No indicada"}`,
            `Teléfono (WhatsApp): +${l.contact.wa_id}`,
            `Origen: ${l.source ?? "whatsapp"}`,
            "",
            "FICHA:",
            JSON.stringify(leadForPrompt(l), null, 2),
            "",
            "DOCUMENTOS:",
            (atts ?? []).map((a) => `- ${a.kind}: ${a.original_filename ?? "sin nombre"} — ${a.description ?? "sin descripción"}`).join("\n") || "Ninguno",
            "",
            "CONVERSACIÓN COMPLETA:",
            transcript,
          ].join("\n"),
        },
      ],
    },
    { retries: 3, timeoutMs: 120_000 },
  );
  const briefing = textOf(res.content);
  if (!briefing) throw new Error("El modelo no devolvió briefing");

  await db.from("leads").update({ briefing_md: briefing, briefing_generated_at: new Date().toISOString(), briefing_error: null }).eq("id", leadId);
  await db.from("events").insert({ type: "briefing.generated", actor: "agent", conversation_id: l.conversation_id, lead_id: leadId, data: { model: aenv.AGENT_MODEL_BRIEFING } });

  // Enlaces firmados (7 días) a la documentación para abrirla desde el email
  const links: string[] = [];
  for (const a of atts ?? []) {
    const { data: signed } = await db.storage.from(a.storage_bucket).createSignedUrl(a.storage_path, 7 * 86_400);
    if (signed?.signedUrl) links.push(`- [${a.original_filename ?? a.description ?? a.kind}](${signed.signedUrl})`);
  }
  const appLink = aenv.APP_URL && l.conversation_id ? `\n\n[Abrir el expediente en la bandeja](${aenv.APP_URL}/inbox/${l.conversation_id})` : "";
  const body = `${briefing}${links.length ? `\n\n## Enlaces a la documentación (válidos 7 días)\n${links.join("\n")}` : ""}${appLink}`;

  const to = aenv.BRIEFING_EMAIL_TO?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  if (!to.length) {
    log.warn("briefing.no_recipient");
    return { emailed: false };
  }
  const result = await sendEmail({
    to,
    subject: `Visita técnica ${visit} · ${l.full_name ?? "Cliente"} · ${l.address ?? ""}`.trim(),
    text: body,
    html: markdownToHtml(body),
  });
  if (result.sent) await db.from("leads").update({ briefing_sent_at: new Date().toISOString() }).eq("id", leadId);
  await db.from("events").insert({
    type: result.sent ? "briefing.emailed" : "briefing.email_skipped",
    conversation_id: l.conversation_id,
    lead_id: leadId,
    data: { to_count: to.length, skipped: result.skipped ?? null },
  });
  return { emailed: result.sent };
}
