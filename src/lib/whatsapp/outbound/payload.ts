import type { OutboundContent, TemplateContent } from "./schema";

/** Media ya resuelta para Meta: id subido (recomendado) o URL pública. */
export type ResolvedMedia = { id: string } | { link: string };

export interface BuildOptions {
  to: string;
  /** Nuestro id interno; Meta lo devuelve en los webhooks de estado (biz_opaque_callback_data). */
  callbackRef?: string;
  /** wamid al que se responde (aparece citado en WhatsApp). */
  replyToWaMessageId?: string;
  /** Media resuelta para image/document o para la cabecera de una plantilla. */
  media?: ResolvedMedia;
}

/**
 * Traduce nuestro contenido al cuerpo de POST /{phone-number-id}/messages.
 * Función pura: sin red ni base de datos (fácil de probar).
 */
export function buildMessagePayload(content: OutboundContent, opts: BuildOptions): Record<string, unknown> {
  const base: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: opts.to,
    ...(opts.callbackRef ? { biz_opaque_callback_data: opts.callbackRef } : {}),
    ...(opts.replyToWaMessageId ? { context: { message_id: opts.replyToWaMessageId } } : {}),
  };

  switch (content.type) {
    case "text":
      return { ...base, type: "text", text: { body: content.body, preview_url: content.previewUrl ?? false } };

    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          ...(content.header ? { header: { type: "text", text: content.header } } : {}),
          body: { text: content.body },
          ...(content.footer ? { footer: { text: content.footer } } : {}),
          action: { buttons: content.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
        },
      };

    case "list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          ...(content.header ? { header: { type: "text", text: content.header } } : {}),
          body: { text: content.body },
          ...(content.footer ? { footer: { text: content.footer } } : {}),
          action: {
            button: content.buttonText,
            sections: content.sections.map((s) => ({
              ...(s.title ? { title: s.title } : {}),
              rows: s.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })),
            })),
          },
        },
      };

    case "image":
      return { ...base, type: "image", image: { ...requireMedia(opts), ...(content.caption ? { caption: content.caption } : {}) } };

    case "document":
      return {
        ...base,
        type: "document",
        document: {
          ...requireMedia(opts),
          ...(content.caption ? { caption: content.caption } : {}),
          ...(content.filename ? { filename: content.filename } : {}),
        },
      };

    case "template":
      return { ...base, type: "template", template: buildTemplate(content, opts.media) };
  }
}

function requireMedia(opts: BuildOptions): ResolvedMedia {
  if (!opts.media) throw new Error("Falta la media resuelta para este mensaje");
  return opts.media;
}

export function buildTemplate(t: TemplateContent, media?: ResolvedMedia): Record<string, unknown> {
  const components: Record<string, unknown>[] = [];

  if (t.header) {
    if (t.header.type === "text") {
      components.push({ type: "header", parameters: [{ type: "text", text: t.header.text }] });
    } else {
      if (!media) throw new Error("Falta la media de la cabecera de la plantilla");
      const param =
        t.header.type === "image"
          ? { type: "image", image: media }
          : { type: "document", document: { ...media, ...(t.header.filename ? { filename: t.header.filename } : {}) } };
      components.push({ type: "header", parameters: [param] });
    }
  }

  if (t.body) {
    const parameters = Array.isArray(t.body)
      ? t.body.map((text) => ({ type: "text", text }))
      : Object.entries(t.body).map(([name, text]) => ({ type: "text", parameter_name: name, text }));
    if (parameters.length) components.push({ type: "body", parameters });
  }

  for (const b of t.urlButtons ?? []) {
    components.push({ type: "button", sub_type: "url", index: String(b.index), parameters: [{ type: "text", text: b.suffix }] });
  }

  return { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) };
}

/** Texto plano para la bandeja y para el historial que verá el agente. */
export function previewOf(content: OutboundContent, templateBody?: string | null): string {
  switch (content.type) {
    case "text":
      return content.body;
    case "buttons":
      return `${content.body}\n${content.buttons.map((b) => `[${b.title}]`).join(" ")}`;
    case "list":
      return `${content.body}\n[${content.buttonText}]`;
    case "image":
      return content.caption ? `📷 ${content.caption}` : "📷 Imagen";
    case "document":
      return `📄 ${content.filename ?? content.caption ?? "Documento"}`;
    case "template":
      return templateBody ? renderTemplateText(templateBody, content.body) : `Plantilla: ${content.name}`;
  }
}

/** Sustituye {{1}} / {{nombre}} por los valores para mostrar el texto final. */
export function renderTemplateText(text: string, body?: string[] | Record<string, string>): string {
  if (!body) return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, key: string) => {
    if (Array.isArray(body)) {
      const i = Number(key);
      return Number.isInteger(i) && i >= 1 && body[i - 1] !== undefined ? body[i - 1]! : m;
    }
    return body[key] ?? m;
  });
}
