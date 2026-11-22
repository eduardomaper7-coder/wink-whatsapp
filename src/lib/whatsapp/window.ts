/**
 * Ventana de atención al cliente de WhatsApp: 24 h desde el ÚLTIMO mensaje del cliente.
 * Dentro: cualquier mensaje. Fuera: solo plantillas aprobadas (error 131047 si no).
 */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Margen de seguridad: avisamos y bloqueamos texto libre 2 min antes del cierre real. */
export const WINDOW_SAFETY_MS = 2 * 60 * 1000;

export interface WindowState {
  open: boolean;
  lastInboundAt: string | null;
  closesAt: string | null;
  /** Minutos restantes (0 si cerrada). Útil para el indicador de la bandeja. */
  minutesLeft: number;
  /** Aviso cuando quedan menos de 2 h. */
  closingSoon: boolean;
}

export function windowState(lastInboundAt: string | Date | null | undefined, now: Date = new Date()): WindowState {
  if (!lastInboundAt) return { open: false, lastInboundAt: null, closesAt: null, minutesLeft: 0, closingSoon: false };
  const last = new Date(lastInboundAt);
  const closes = new Date(last.getTime() + WINDOW_MS);
  const msLeft = closes.getTime() - now.getTime() - WINDOW_SAFETY_MS;
  const open = msLeft > 0;
  return {
    open,
    lastInboundAt: last.toISOString(),
    closesAt: closes.toISOString(),
    minutesLeft: open ? Math.floor(msLeft / 60_000) : 0,
    closingSoon: open && msLeft < 2 * 60 * 60 * 1000,
  };
}
