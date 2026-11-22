/**
 * Errores de la Graph API / WhatsApp Cloud API.
 * Clasificación basada en la tabla oficial de códigos de error
 * (developers.facebook.com → WhatsApp → Support → Error codes). Meta recomienda
 * decidir por `code`, no por el estado HTTP ni el subcódigo.
 */

export type ErrorKind =
  | "retryable" //        temporal: reintentar con backoff
  | "rate_limited" //     límites de envío: reintentar más despacio
  | "window_closed" //    fuera de la ventana de 24 h: usar plantilla
  | "recipient" //        número no válido / no entregable / se dio de baja
  | "template" //         problema con la plantilla
  | "media" //            subida/descarga de multimedia
  | "auth" //             token/permisos: requiere intervención (alerta al admin)
  | "account" //          cuenta bloqueada, pagos, número no registrado…
  | "invalid_request" //  parámetros mal formados (bug nuestro)
  | "unknown";

interface CodeInfo {
  kind: ErrorKind;
  es: string; // mensaje para el equipo (interfaz)
  retryAfterMs?: number;
}

const CODES: Record<number, CodeInfo> = {
  // Autorización
  0: { kind: "auth", es: "El token de WhatsApp no es válido o ha caducado." },
  3: { kind: "auth", es: "La app no tiene permiso para esta operación." },
  10: { kind: "auth", es: "Permiso no concedido a la app de WhatsApp." },
  190: { kind: "auth", es: "El token de WhatsApp ha caducado. Hay que renovarlo." },
  // Errores temporales genéricos de la Graph API
  1: { kind: "retryable", es: "Error temporal de la API de Meta; se reintentará." },
  2: { kind: "retryable", es: "Servicio de Meta no disponible temporalmente; se reintentará.", retryAfterMs: 60_000 },
  // Límites
  4: { kind: "rate_limited", es: "Límite de llamadas de la app alcanzado; se reintentará.", retryAfterMs: 60_000 },
  80007: { kind: "rate_limited", es: "Límite de la cuenta de WhatsApp alcanzado; se reintentará.", retryAfterMs: 60_000 },
  130429: { kind: "rate_limited", es: "Límite de envío por segundo alcanzado; se reintentará.", retryAfterMs: 15_000 },
  131056: { kind: "rate_limited", es: "Demasiados mensajes seguidos a este cliente; se reintentará en unos minutos.", retryAfterMs: 120_000 },
  131048: { kind: "account", es: "Envíos restringidos por calidad (mensajes bloqueados/denunciados). Revisa WhatsApp Manager." },
  131064: { kind: "account", es: "Límite de mensajes por clasificación de plantillas." },
  // Integridad / cuenta
  368: { kind: "account", es: "La cuenta de WhatsApp está restringida por incumplimiento de políticas." },
  130497: { kind: "account", es: "La cuenta no puede enviar mensajes a este país." },
  131031: { kind: "account", es: "La cuenta de WhatsApp está bloqueada." },
  131037: { kind: "account", es: "El nombre visible del número no está aprobado." },
  131042: { kind: "account", es: "Problema con el método de pago de la cuenta de WhatsApp." },
  131045: { kind: "account", es: "El número de envío no está registrado correctamente." },
  133010: { kind: "account", es: "El número de envío no está registrado en la Cloud API." },
  131057: { kind: "retryable", es: "La cuenta está en mantenimiento; se reintentará.", retryAfterMs: 300_000 },
  // Envío
  131000: { kind: "retryable", es: "Error desconocido de WhatsApp; se reintentará." },
  131016: { kind: "retryable", es: "Servicio de WhatsApp no disponible; se reintentará.", retryAfterMs: 60_000 },
  133004: { kind: "retryable", es: "Servidor de WhatsApp no disponible; se reintentará.", retryAfterMs: 60_000 },
  131005: { kind: "auth", es: "Se retiró un permiso de la app." },
  131008: { kind: "invalid_request", es: "Falta un parámetro obligatorio en el mensaje." },
  131009: { kind: "invalid_request", es: "Un parámetro del mensaje no es válido." },
  100: { kind: "invalid_request", es: "Parámetro no válido en la petición." },
  135000: { kind: "invalid_request", es: "Error de parámetros en la petición." },
  131021: { kind: "recipient", es: "No se puede enviar al mismo número que envía." },
  131026: { kind: "recipient", es: "No se pudo entregar: el número no usa WhatsApp, no ha aceptado las condiciones o tiene la app desactualizada." },
  131030: { kind: "recipient", es: "Con el número de prueba de Meta solo se puede escribir a los teléfonos autorizados (máx. 5). Añádelo en WhatsApp → Configuración de la API." },
  131047: { kind: "window_closed", es: "Han pasado más de 24 h desde el último mensaje del cliente: solo se pueden enviar plantillas." },
  131049: { kind: "recipient", es: "WhatsApp no entregó el mensaje de marketing para proteger la experiencia del cliente. Espera 24 h." },
  131050: { kind: "recipient", es: "El cliente ha pedido no recibir mensajes de marketing." },
  131051: { kind: "invalid_request", es: "Tipo de mensaje no soportado." },
  131052: { kind: "media", es: "No se pudo descargar la multimedia." },
  131053: { kind: "media", es: "No se pudo subir la multimedia (¿formato o tamaño no soportado?)." },
  // Plantillas
  132000: { kind: "template", es: "El número de variables no coincide con la plantilla." },
  132001: { kind: "template", es: "La plantilla no existe o no está aprobada en ese idioma." },
  132005: { kind: "template", es: "El texto de la plantilla traducida es demasiado largo." },
  132007: { kind: "template", es: "La plantilla incumple la política de contenido de WhatsApp." },
  132012: { kind: "template", es: "El formato de una variable no coincide con la plantilla." },
  132015: { kind: "template", es: "La plantilla está pausada por baja calidad." },
  132016: { kind: "template", es: "La plantilla está desactivada de forma permanente." },
  132018: { kind: "template", es: "Error de validación de los parámetros de la plantilla." },
  134101: { kind: "retryable", es: "La plantilla aún se está sincronizando; se reintentará.", retryAfterMs: 600_000 },
};

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly fbtraceId?: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = "WhatsAppApiError";
  }

  get info(): CodeInfo {
    if (this.code !== undefined && CODES[this.code]) return CODES[this.code]!;
    if (this.httpStatus === 429) return { kind: "rate_limited", es: "Límite de peticiones alcanzado; se reintentará.", retryAfterMs: 60_000 };
    if (this.httpStatus >= 500) return { kind: "retryable", es: "Error temporal de WhatsApp; se reintentará." };
    return { kind: "unknown", es: `Error de WhatsApp${this.code ? ` (código ${this.code})` : ""}.` };
  }

  get kind(): ErrorKind {
    return this.info.kind;
  }

  /** ¿Merece la pena reintentar? */
  get retryable(): boolean {
    return this.kind === "retryable" || this.kind === "rate_limited";
  }

  /** Forma que guardamos en messages.error y mostramos en la interfaz. */
  toRecord() {
    return {
      code: this.code ?? null,
      kind: this.kind,
      title: this.message,
      details: this.details ?? null,
      message_es: this.info.es,
      fbtrace_id: this.fbtraceId ?? null,
    };
  }
}

/** Información de un código (también para errores que llegan en webhooks de estado). */
export function describeErrorCode(code: number | undefined): CodeInfo {
  return (code !== undefined && CODES[code]) || { kind: "unknown", es: `Error de WhatsApp${code ? ` (código ${code})` : ""}.` };
}

export async function toApiError(res: Response): Promise<WhatsAppApiError> {
  let body: { error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string; error_data?: { details?: string } } } = {};
  try {
    body = await res.json();
  } catch {
    /* cuerpo no JSON */
  }
  const e = body.error ?? {};
  return new WhatsAppApiError(e.message ?? `HTTP ${res.status}`, res.status, e.code, e.error_subcode, e.fbtrace_id, e.error_data?.details);
}

/** Timeout o fallo de red: no sabemos si Meta recibió la petición. */
export class AmbiguousSendError extends Error {
  constructor(cause: unknown) {
    super(`Sin respuesta de WhatsApp: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AmbiguousSendError";
  }
}
