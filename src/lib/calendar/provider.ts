import { createSign } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { agentEnv, loadAgenda } from "@/lib/agent/config";
import { log } from "@/lib/log";
import { demoBusy, type Interval } from "./agenda";

export interface CalendarEventInput {
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location?: string | null;
}

export interface CalendarProvider {
  readonly name: "google" | "demo";
  busy(from: Date, to: Date): Promise<Interval[]>;
  createEvent(e: CalendarEventInput): Promise<{ id: string; link?: string }>;
}

export function calendarProvider(db: SupabaseClient): CalendarProvider {
  return agentEnv().CALENDAR_PROVIDER === "google" ? new GoogleCalendar() : new DemoCalendar(db);
}

// ---------------------------------------------------------------------
// Modo demo: sin Google. Ocupado = visitas ya reservadas + franjas simuladas.
// ---------------------------------------------------------------------
export class DemoCalendar implements CalendarProvider {
  readonly name = "demo" as const;
  constructor(private readonly db: SupabaseClient) {}

  async busy(from: Date, to: Date): Promise<Interval[]> {
    const { data } = await this.db
      .from("leads")
      .select("visit_at, visit_end_at")
      .gte("visit_at", new Date(from.getTime() - 86_400_000).toISOString())
      .lte("visit_at", to.toISOString())
      .not("visit_at", "is", null);
    const booked = (data ?? []).map((r) => ({
      start: new Date(r.visit_at as string),
      end: new Date((r.visit_end_at as string | null) ?? new Date(new Date(r.visit_at as string).getTime() + 3_600_000).toISOString()),
    }));
    const days = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
    return [...booked, ...demoBusy(loadAgenda(), from, days)];
  }

  async createEvent(): Promise<{ id: string }> {
    return { id: `demo_${Date.now().toString(36)}` };
  }
}

// ---------------------------------------------------------------------
// Google Calendar con cuenta de servicio (gratuito).
// Requisitos: Calendar API activada en Google Cloud, una cuenta de servicio
// con su clave JSON, y el calendario de visitas compartido con el email de
// la cuenta de servicio con permiso "Hacer cambios en eventos".
// ---------------------------------------------------------------------
interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let tokenCache: { token: string; exp: number } | null = null;

export class GoogleCalendar implements CalendarProvider {
  readonly name = "google" as const;
  private readonly calendarId: string;
  private readonly sa: ServiceAccount;

  constructor() {
    const env = agentEnv();
    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.GOOGLE_CALENDAR_ID) {
      throw new Error("Faltan GOOGLE_SERVICE_ACCOUNT_JSON o GOOGLE_CALENDAR_ID (o usa CALENDAR_PROVIDER=demo)");
    }
    const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
    this.sa = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")) as ServiceAccount;
    this.calendarId = env.GOOGLE_CALENDAR_ID;
  }

  private async token(): Promise<string> {
    if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
      iss: this.sa.client_email,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.sa.private_key, "base64url");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Google OAuth ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    tokenCache = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  async busy(from: Date, to: Date): Promise<Interval[]> {
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: this.calendarId }] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Google freeBusy ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { calendars: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> };
    const cal = json.calendars[this.calendarId];
    if (cal?.errors?.length) throw new Error(`Google freeBusy: sin acceso al calendario (${JSON.stringify(cal.errors).slice(0, 200)})`);
    return (cal?.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  async createEvent(e: CalendarEventInput): Promise<{ id: string; link?: string }> {
    const tz = loadAgenda().zonaHoraria;
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: e.summary,
        description: e.description,
        ...(e.location ? { location: e.location } : {}),
        start: { dateTime: e.start.toISOString(), timeZone: tz },
        end: { dateTime: e.end.toISOString(), timeZone: tz },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Google events.insert ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { id: string; htmlLink?: string };
    log.info("calendar.event_created", { provider: "google" });
    return { id: json.id, link: json.htmlLink };
  }
}
