/**
 * Red de seguridad sobre lo que escribe el agente (además de las instrucciones del prompt).
 * Si se cuela una cifra económica, se sustituye el mensaje por uno seguro.
 */

// Cantidades con moneda: "900 €", "1.200€/m2", "15.000 euros", "20k€", "EUR 300", "€500"
const MONEY = /(\d[\d.,]*\s*(k\s*)?(€|euros?\b|eur\b))|((€|eur\s)\s*\d)|(\d[\d.,]*\s*mil\s+euros?)/i;
// Precio por metro cuadrado aunque no aparezca la moneda: "a 1.000 el metro", "900/m2"
const PER_M2 = /\d[\d.,]*\s*(\/|por|el|al)\s*(m2|m²|metro)/i;

export const SAFE_PRICE_REPLY =
  "Entiendo que es importante saberlo. Para darte cifras ajustadas a tu caso, el arquitecto tiene que ver la vivienda en la visita técnica: así la valoración será realista. ¿Te propongo unos huecos para la visita?";

export function mentionsPrice(text: string): boolean {
  return MONEY.test(text) || PER_M2.test(text);
}

export interface GuardResult {
  text: string;
  blocked: boolean;
  reason?: string;
}

export function guardOutgoing(text: string): GuardResult {
  if (mentionsPrice(text)) return { text: SAFE_PRICE_REPLY, blocked: true, reason: "precio" };
  return { text, blocked: false };
}

/** Garantiza el aviso de privacidad en el primer mensaje al cliente. */
export function ensurePrivacyNotice(text: string, notice: string, url: string): string {
  if (text.includes(url)) return text;
  return `${text.trim()}\n\n${notice}`;
}
