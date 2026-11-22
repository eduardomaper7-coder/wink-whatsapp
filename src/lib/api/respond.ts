import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth/server";
import { log } from "@/lib/log";
import { ValidationError } from "@/lib/whatsapp/outbound/schema";
import { SendRejectedError, WindowClosedError } from "@/lib/whatsapp/outbound/service";

/** Traduce errores conocidos a respuestas JSON coherentes para la interfaz. */
export function errorResponse(e: unknown, extra: Record<string, unknown> = {}) {
  if (e instanceof AuthError) return NextResponse.json({ error: e.message, code: "auth" }, { status: e.httpStatus });
  if (e instanceof ValidationError) return NextResponse.json({ error: e.message, code: "validation", issues: e.issues }, { status: 400 });
  if (e instanceof WindowClosedError) {
    return NextResponse.json({ error: e.message, code: "window_closed", window: e.window, ...extra }, { status: e.httpStatus });
  }
  if (e instanceof SendRejectedError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.httpStatus });
  log.error("api.unexpected", { error: e });
  return NextResponse.json({ error: "Error inesperado. Inténtalo de nuevo.", code: "internal" }, { status: 500 });
}
