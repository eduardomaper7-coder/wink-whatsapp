"use client";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";
import type { Attachment, ConversationItem, EventItem, Lead, MessageItem, TeamMember } from "./types";

/**
 * Suscripción a cambios de Postgres (Supabase Realtime). Si el canal no llega a
 * conectarse, se sondea cada `pollMs` para que la bandeja nunca se quede congelada.
 */
function useLive(key: string, tables: Array<{ table: string; filter?: string }>, onChange: () => void, pollMs = 5000) {
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    if (!key) return;
    const sb = supabaseBrowser();
    let channel: RealtimeChannel = sb.channel(`live:${key}:${Math.random().toString(36).slice(2)}`);
    for (const t of tables) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table: t.table, ...(t.filter ? { filter: t.filter } : {}) }, () => cb.current());
    }
    let subscribed = false;
    channel.subscribe((status) => {
      subscribed = status === "SUBSCRIBED";
    });
    // Respaldo: si el tiempo real no está conectado, se sondea
    const poll = setInterval(() => {
      if (!subscribed && document.visibilityState === "visible") cb.current();
    }, pollMs);
    const onFocus = () => cb.current();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", onFocus);
      void sb.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

function useDebounced(fn: () => void, ms = 150) {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  return useCallback(() => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(fn, ms);
  }, [fn, ms]);
}

const CONV_COLUMNS = "id, status, agent_active, assigned_to, handoff_reason, last_inbound_at, last_message_at, last_message_preview, unread_count, contact:contacts!inner(id, wa_id, name, profile_name)";

export function useConversations() {
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const load = useCallback(async () => {
    const { data } = await supabaseBrowser().from("conversations").select(CONV_COLUMNS).order("last_message_at", { ascending: false, nullsFirst: false }).limit(300);
    if (data) setItems(data as unknown as ConversationItem[]);
  }, []);
  const reload = useDebounced(load);
  useEffect(() => {
    void load();
  }, [load]);
  useLive("conversations", [{ table: "conversations" }, { table: "contacts" }], reload);
  return { items, reload: load };
}

export function useMessages(conversationId: string | null) {
  const [messages, setMessages] = useState<MessageItem[] | null>(null);
  const [attachments, setAttachments] = useState<Record<string, Attachment>>({});
  const load = useCallback(async () => {
    if (!conversationId) return;
    const sb = supabaseBrowser();
    const [m, a] = await Promise.all([
      sb
        .from("messages")
        .select("id, conversation_id, direction, author, sent_by, type, content, text_preview, wa_message_id, status, error, customer_reaction, media_status, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(400),
      sb.from("attachments").select("*").eq("conversation_id", conversationId),
    ]);
    if (m.data) setMessages((m.data as MessageItem[]).reverse());
    if (a.data) setAttachments(Object.fromEntries((a.data as Attachment[]).filter((x) => x.message_id).map((x) => [x.message_id!, x])));
  }, [conversationId]);
  const reload = useDebounced(load, 80);
  useEffect(() => {
    setMessages(null);
    setAttachments({});
    void load();
  }, [load]);
  useLive(
    conversationId ? `messages:${conversationId}` : "",
    [
      { table: "messages", filter: `conversation_id=eq.${conversationId}` },
      { table: "attachments", filter: `conversation_id=eq.${conversationId}` },
    ],
    reload,
    3000,
  );
  return { messages, attachments, reload: load };
}

export function useLead(conversationId: string | null) {
  const [lead, setLead] = useState<Lead | null>(null);
  const [docs, setDocs] = useState<Attachment[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const load = useCallback(async () => {
    if (!conversationId) return;
    const sb = supabaseBrowser();
    const [l, e] = await Promise.all([
      sb.from("leads").select("*").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      sb.from("events").select("id, type, actor, data, created_at").eq("conversation_id", conversationId).in("type", ["agent.handoff", "agent.paused", "visit.booked", "conversation.closed"]).order("created_at"),
    ]);
    setLead((l.data as Lead | null) ?? null);
    setEvents((e.data as EventItem[] | null) ?? []);
    if (l.data) {
      const { data } = await sb.from("attachments").select("*").eq("lead_id", (l.data as Lead).id).order("created_at");
      setDocs((data as Attachment[] | null) ?? []);
    } else setDocs([]);
  }, [conversationId]);
  const reload = useDebounced(load, 100);
  useEffect(() => {
    setLead(null);
    setDocs([]);
    setEvents([]);
    void load();
  }, [load]);
  useLive(
    conversationId ? `lead:${conversationId}` : "",
    [
      { table: "leads", filter: `conversation_id=eq.${conversationId}` },
      { table: "attachments", filter: `conversation_id=eq.${conversationId}` },
      { table: "events", filter: `conversation_id=eq.${conversationId}` },
    ],
    reload,
    3000,
  );
  return { lead, docs, events };
}

export function useTeam() {
  const [team, setTeam] = useState<TeamMember[]>([]);
  useEffect(() => {
    void supabaseBrowser()
      .from("profiles")
      .select("id, full_name, email, role")
      .eq("active", true)
      .order("full_name")
      .then(({ data }) => setTeam((data as TeamMember[] | null) ?? []));
  }, []);
  return team;
}

/** URL firmada (1 h) de un archivo privado de Storage, con caché en memoria. */
const urlCache = new Map<string, { url: string; exp: number }>();
export function useSignedUrl(bucket: string | undefined, path: string | undefined) {
  const [url, setUrl] = useState<string | null>(() => {
    const c = bucket && path ? urlCache.get(`${bucket}/${path}`) : undefined;
    return c && c.exp > Date.now() ? c.url : null;
  });
  useEffect(() => {
    if (!bucket || !path) return;
    const key = `${bucket}/${path}`;
    const c = urlCache.get(key);
    if (c && c.exp > Date.now()) {
      setUrl(c.url);
      return;
    }
    void supabaseBrowser()
      .storage.from(bucket)
      .createSignedUrl(path, 3600)
      .then(({ data }) => {
        if (data?.signedUrl) {
          urlCache.set(key, { url: data.signedUrl, exp: Date.now() + 50 * 60_000 });
          setUrl(data.signedUrl);
        }
      });
  }, [bucket, path]);
  return url;
}

/** Llamada a las rutas API propias con manejo de errores uniforme. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; status: number; data: T & { error?: string; code?: string } }> {
  const res = await fetch(path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  return { ok: res.ok, status: res.status, data };
}
