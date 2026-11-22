import type { SupabaseClient } from "@supabase/supabase-js";
import { sendNotification, setVapidDetails } from "web-push";
import { log } from "@/lib/log";

/**
 * Notificaciones Web Push (estándar, gratuito; sin Firebase).
 * Claves VAPID: npx web-push generate-vapid-keys
 * iOS/iPadOS: solo llegan si la PWA está instalada en la pantalla de inicio (iOS 16.4+).
 */
export { PUSH_JOB } from "./constants";

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
  urgent?: boolean;
  badge?: number;
  timestamp?: number;
}

export interface PushResult {
  recipients: number;
  sent: number;
  removed: number;
  skipped?: string;
}

/** Notificaciones capturadas con PUSH_TRANSPORT=log (tests). */
export const capturedPushes: Array<{ userId: string; endpoint: string; payload: PushPayload }> = [];

function config() {
  return {
    publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.VAPID_PRIVATE_KEY ?? "",
    subject: process.env.VAPID_SUBJECT ?? "mailto:prueba@aibetech.es",
    transport: process.env.PUSH_TRANSPORT === "log" ? "log" : "webpush",
  } as const;
}

export function pushConfigured(): boolean {
  const c = config();
  return c.transport === "log" || (!!c.publicKey && !!c.privateKey);
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Envía una notificación a miembros activos del equipo.
 * `userIds` limita los destinatarios; `adminsOnly` solo a administradores.
 * Borra las suscripciones caducadas (404/410).
 */
export async function notifyTeam(db: SupabaseClient, payload: PushPayload, opts: { userIds?: string[]; adminsOnly?: boolean } = {}): Promise<PushResult> {
  const c = config();
  if (!pushConfigured()) return { recipients: 0, sent: 0, removed: 0, skipped: "VAPID sin configurar" };

  let q = db.from("profiles").select("id").eq("active", true);
  if (opts.adminsOnly) q = q.eq("role", "admin");
  if (opts.userIds?.length) q = q.in("id", opts.userIds);
  const { data: people, error } = await q;
  if (error) throw new Error(`[db:profiles] ${error.message}`);
  const ids = (people ?? []).map((p) => p.id as string);
  if (!ids.length) return { recipients: 0, sent: 0, removed: 0 };

  const { data: subs, error: subErr } = await db.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", ids);
  if (subErr) throw new Error(`[db:push_subscriptions] ${subErr.message}`);

  if (c.transport === "webpush") setVapidDetails(c.subject, c.publicKey, c.privateKey);
  let sent = 0;
  const expired: string[] = [];
  const body = JSON.stringify({ ...payload, timestamp: payload.timestamp ?? Date.now() });

  await Promise.all(
    ((subs ?? []) as SubscriptionRow[]).map(async (s) => {
      if (c.transport === "log") {
        capturedPushes.push({ userId: s.user_id, endpoint: s.endpoint, payload });
        sent++;
        return;
      }
      try {
        await sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
          TTL: payload.urgent ? 24 * 3600 : 4 * 3600,
          urgency: payload.urgent ? "high" : "normal",
          timeout: 10_000,
        });
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) expired.push(s.id);
        else log.warn("push.send_failed", { status: status ?? null, error: e });
      }
    }),
  );

  if (expired.length) await db.from("push_subscriptions").delete().in("id", expired);
  if (sent) await db.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).in("user_id", ids);
  return { recipients: ids.length, sent, removed: expired.length };
}

/** Total de conversaciones con mensajes sin leer (insignia del icono de la app). */
export async function unreadBadge(db: SupabaseClient): Promise<number> {
  const { count } = await db.from("conversations").select("id", { count: "exact", head: true }).gt("unread_count", 0).neq("status", "closed");
  return count ?? 0;
}
