import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { toApiError } from "../errors";
import { graphUrl } from "../graph";

/** Plantilla tal como la devuelve GET /{waba-id}/message_templates. */
export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category?: string;
  parameter_format?: string;
  components?: Array<{ type: string; format?: string; text?: string; buttons?: Array<{ type: string; text?: string; url?: string }> }>;
  rejected_reason?: string;
}

export interface TemplateRow {
  id: string;
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: MetaTemplate["components"];
  parameter_format: string | null;
}

/** Descripción de lo que hay que rellenar para enviar una plantilla (para la interfaz y el agente). */
export interface TemplateShape {
  bodyText: string | null;
  bodyVariables: string[]; // ["1","2"] o ["nombre","fecha"]
  headerFormat: "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO" | "LOCATION" | null;
  headerVariables: string[];
  urlButtons: Array<{ index: number; text: string }>; // botones URL con sufijo variable
  quickReplies: string[];
}

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const varsIn = (text?: string | null) => [...new Set([...(text ?? "").matchAll(VAR_RE)].map((m) => m[1]!))];

export function templateShape(components: MetaTemplate["components"] = []): TemplateShape {
  const header = components.find((c) => c.type === "HEADER");
  const body = components.find((c) => c.type === "BODY");
  const buttons = components.find((c) => c.type === "BUTTONS")?.buttons ?? [];
  return {
    bodyText: body?.text ?? null,
    bodyVariables: varsIn(body?.text),
    headerFormat: (header?.format as TemplateShape["headerFormat"]) ?? null,
    headerVariables: header?.format === "TEXT" ? varsIn(header.text) : [],
    urlButtons: buttons.flatMap((b, index) => (b.type === "URL" && b.url && /\{\{\s*[A-Za-z0-9_]+\s*\}\}/.test(b.url) ? [{ index, text: b.text ?? "" }] : [])),
    quickReplies: buttons.filter((b) => b.type === "QUICK_REPLY").map((b) => b.text ?? ""),
  };
}

/**
 * Sincroniza las plantillas de la WABA con la tabla `templates`.
 * Las que ya no existen en Meta se marcan como DELETED (no se borran: hay mensajes que las referencian).
 */
export async function syncTemplates(db: SupabaseClient): Promise<{ total: number; approved: number }> {
  const fields = "id,name,language,status,category,components,parameter_format,rejected_reason";
  let url: string | null = graphUrl(`${env().WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates?fields=${fields}&limit=100`);
  const all: MetaTemplate[] = [];

  for (let page = 0; url && page < 50; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${env().WHATSAPP_TOKEN}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw await toApiError(res);
    const json = (await res.json()) as { data: MetaTemplate[]; paging?: { next?: string } };
    all.push(...json.data);
    url = json.paging?.next ?? null;
  }

  const now = new Date().toISOString();
  if (all.length) {
    const { error } = await db.from("templates").upsert(
      all.map((t) => ({
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category ?? null,
        status: t.status,
        components: t.components ?? [],
        parameter_format: t.parameter_format ?? null,
        rejected_reason: t.rejected_reason && t.rejected_reason !== "NONE" ? t.rejected_reason : null,
        synced_at: now,
      })),
      { onConflict: "id" },
    );
    if (error) throw new Error(`[db:templates] ${error.message}`);
  }

  const ids = all.map((t) => t.id);
  const stale = db.from("templates").update({ status: "DELETED", synced_at: now }).neq("status", "DELETED");
  const { error: staleErr } = ids.length ? await stale.not("id", "in", `(${ids.join(",")})`) : await stale;
  if (staleErr) throw new Error(`[db:templates] ${staleErr.message}`);

  const approved = all.filter((t) => t.status === "APPROVED").length;
  log.info("templates.synced", { total: all.length, approved });
  return { total: all.length, approved };
}

/** Plantillas utilizables ahora mismo (APPROVED), con su forma para rellenar. */
export async function listApprovedTemplates(db: SupabaseClient) {
  const { data, error } = await db
    .from("templates")
    .select("id, name, language, category, status, components, parameter_format")
    .eq("status", "APPROVED")
    .order("name");
  if (error) throw new Error(`[db:templates] ${error.message}`);
  return (data as TemplateRow[]).map((t) => ({ ...t, shape: templateShape(t.components) }));
}

/** Comprueba que los valores encajan con la plantilla antes de llamar a Meta (evita el error 132000). */
export function checkTemplateValues(
  shape: TemplateShape,
  values: { body?: string[] | Record<string, string>; header?: { type: string }; urlButtons?: Array<{ index: number }> },
): string[] {
  const problems: string[] = [];
  const given = Array.isArray(values.body) ? values.body.map((_, i) => String(i + 1)) : Object.keys(values.body ?? {});
  const missing = shape.bodyVariables.filter((v) => !given.includes(v));
  if (missing.length) problems.push(`Faltan variables de la plantilla: ${missing.map((v) => `{{${v}}}`).join(", ")}`);
  const extra = given.filter((v) => !shape.bodyVariables.includes(v));
  if (extra.length) problems.push(`Sobran variables: ${extra.map((v) => `{{${v}}}`).join(", ")}`);
  if (shape.headerFormat && ["IMAGE", "DOCUMENT", "VIDEO"].includes(shape.headerFormat) && !values.header)
    problems.push("La plantilla necesita una imagen o documento en la cabecera");
  if (shape.headerFormat === "TEXT" && shape.headerVariables.length && values.header?.type !== "text")
    problems.push("La plantilla necesita el texto variable de la cabecera");
  for (const b of shape.urlButtons) {
    if (!values.urlButtons?.some((u) => u.index === b.index)) problems.push(`Falta el final de la URL del botón «${b.text}»`);
  }
  return problems;
}

export async function findTemplate(db: SupabaseClient, name: string, language: string): Promise<TemplateRow | null> {
  const { data } = await db.from("templates").select("id, name, language, category, status, components, parameter_format").eq("name", name).eq("language", language).maybeSingle();
  return (data as TemplateRow | null) ?? null;
}
