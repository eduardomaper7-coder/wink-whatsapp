import nodemailer from "nodemailer";
import { agentEnv } from "@/lib/agent/config";
import { log } from "@/lib/log";

/**
 * Envío de email por SMTP (gratuito con el buzón de Hostinger: smtp.hostinger.com, 465 SSL;
 * alternativa 587 STARTTLS). EMAIL_TRANSPORT=log no envía nada (tests / demo sin correo).
 */
export interface EmailInput {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

export interface EmailResult {
  sent: boolean;
  skipped?: string;
  messageId?: string;
}

/** Correos capturados con EMAIL_TRANSPORT=log (para tests). */
export const capturedEmails: EmailInput[] = [];

export async function sendEmail(input: EmailInput): Promise<EmailResult> {
  const env = agentEnv();
  if (env.EMAIL_TRANSPORT === "log") {
    capturedEmails.push(input);
    log.info("email.logged", { subject: input.subject });
    return { sent: false, skipped: "EMAIL_TRANSPORT=log" };
  }
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    log.warn("email.not_configured");
    return { sent: false, skipped: "SMTP sin configurar" };
  }
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465, // 465 = SSL directo; 587 = STARTTLS
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 15_000,
  });
  const info = await transport.sendMail({
    from: env.EMAIL_FROM ?? `Asistente Wink <${env.SMTP_USER}>`,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
  log.info("email.sent", { subject: input.subject });
  return { sent: true, messageId: info.messageId };
}

/** Markdown sencillo → HTML (títulos, listas, negritas, párrafos) para el briefing. */
export function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  const out: string[] = [];
  let inList = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (!li && inList) {
      out.push("</ul>");
      inList = false;
    }
    if (h) out.push(`<h${h[1]!.length + 1} style="margin:18px 0 6px;font-family:Georgia,serif">${inline(h[2]!)}</h${h[1]!.length + 1}>`);
    else if (li) {
      if (!inList) {
        out.push('<ul style="margin:4px 0 8px;padding-left:20px">');
        inList = true;
      }
      out.push(`<li>${inline(li[1]!)}</li>`);
    } else if (line.trim()) out.push(`<p style="margin:6px 0">${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#111;max-width:680px">${out.join("\n")}</div>`;
}
