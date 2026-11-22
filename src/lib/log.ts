/**
 * Logger JSON estructurado con redacción de datos sensibles.
 * Regla: nunca registrar tokens, secretos ni datos personales completos.
 * - Claves sensibles (token, secret, authorization…) → "[REDACTED]"
 * - Teléfonos / wa_id → solo los 3 últimos dígitos
 * - Contenido libre del cliente (body, text, caption…) → solo su longitud
 */

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const SECRET_KEYS = /(token|secret|password|authorization|api[_-]?key|signature|cookie|service[_-]?role)/i;
const PHONE_KEYS = /^(wa_id|from|to|phone|recipient_id|display_phone_number|telefono)$/i;
const FREE_TEXT_KEYS = /^(body|text|caption|content|message|name|address|emoji|title|description)$/i;
const MAX_DEPTH = 6;

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `***${digits.slice(-3)}`;
}

/** Elimina patrones de token aunque aparezcan dentro de un texto (p. ej. un mensaje de error). */
export function scrubString(s: string): string {
  return s
    .replace(/EAA[A-Za-z0-9]{10,}/g, "[REDACTED_TOKEN]")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-ant-[A-Za-z0-9_\-]+/g, "[REDACTED_KEY]")
    .replace(/\+?\d{9,15}/g, (m) => maskPhone(m));
}

export function redact(value: unknown, key = "", depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[…]";
  if (key && SECRET_KEYS.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (key && PHONE_KEYS.test(key)) return maskPhone(value);
    if (key && FREE_TEXT_KEYS.test(key)) return `[text:${value.length}]`;
    return scrubString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return { name: value.name, message: scrubString(value.message) };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, key, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v, k, depth + 1);
    return out;
  }
  return String(value);
}

function currentLevel(): Level | "silent" {
  const l = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return (l in ORDER ? l : "info") as Level | "silent";
}

function write(level: Level, msg: string, ctx?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[currentLevel()]) return;
  const line = JSON.stringify({
    level,
    msg,
    time: new Date().toISOString(),
    ...(ctx ? (redact(ctx) as Record<string, unknown>) : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => write("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => write("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => write("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => write("error", msg, ctx),
};
