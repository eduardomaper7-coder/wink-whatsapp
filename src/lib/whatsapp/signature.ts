import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Valida la cabecera X-Hub-Signature-256 que Meta añade a cada POST del webhook.
 * Formato: "sha256=<hex HMAC-SHA256 del cuerpo en crudo con el App Secret>".
 * IMPORTANTE: hay que firmar el cuerpo EXACTO recibido (sin re-serializar el JSON).
 */
export function isValidSignature(rawBody: string | Buffer, header: string | null | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const [algo, received] = header.split("=", 2);
  if (algo !== "sha256" || !received || !/^[a-f0-9]{64}$/i.test(received)) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(received, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function sign(rawBody: string | Buffer, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}

/** Verificación GET del webhook (hub.mode / hub.verify_token / hub.challenge). */
export function verifySubscription(params: URLSearchParams, verifyToken: string): string | null {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (mode !== "subscribe" || !token || !challenge) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return challenge;
}
