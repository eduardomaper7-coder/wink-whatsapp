import { randomUUID } from "node:crypto";
import type { AuditEvent, EnqueueOptions, InboundMessageRow, InboundStore } from "@/lib/whatsapp/inbound/store";
import type { NormalizedStatus, TemplateStatusUpdate } from "@/lib/whatsapp/types";

const RANK: Record<string, number> = { received: 0, queued: 1, sent: 2, delivered: 3, read: 4, played: 5, failed: 6 };

/** Implementación en memoria que replica la semántica de la base de datos (incl. apply_message_status). */
export class MemoryStore implements InboundStore {
  contacts = new Map<string, { id: string; waId: string; profileName?: string }>();
  conversations = new Map<string, { id: string; contactId: string; unread: number; lastInboundAt?: Date; preview?: string | null; status: "bot" | "human" | "closed" }>();
  messages: Array<InboundMessageRow & { id: string; status: string; customerReaction?: string | null; error?: unknown; direction: string }> = [];
  jobs: Array<{ type: string; payload: Record<string, unknown>; opts?: EnqueueOptions }> = [];
  events: AuditEvent[] = [];
  templates = new Map<string, { name: string; language: string; status: string; rejectedReason: string | null }>();

  async upsertContact(waId: string, profileName?: string) {
    let c = this.contacts.get(waId);
    if (!c) this.contacts.set(waId, (c = { id: randomUUID(), waId }));
    if (profileName) c.profileName = profileName;
    return { id: c.id };
  }
  async getOrCreateConversation(contactId: string) {
    for (const c of this.conversations.values()) if (c.contactId === contactId) return { id: c.id, status: c.status };
    const id = randomUUID();
    this.conversations.set(id, { id, contactId, unread: 0, status: "bot" });
    return { id, status: "bot" as const };
  }
  async insertInboundMessage(row: InboundMessageRow) {
    if (this.messages.some((m) => m.waMessageId === row.waMessageId)) return null;
    const id = randomUUID();
    this.messages.push({ ...row, id, status: "received", direction: "inbound" });
    return { id };
  }
  async touchConversationInbound(conversationId: string, at: Date, preview: string | null, countUnread: boolean) {
    const c = this.conversations.get(conversationId)!;
    if (!c.lastInboundAt || at > c.lastInboundAt) c.lastInboundAt = at;
    if (preview !== null) c.preview = preview;
    if (countUnread) c.unread++;
  }
  async setCustomerReaction(target: string, emoji: string | null) {
    const m = this.messages.find((x) => x.waMessageId === target);
    if (!m) return false;
    m.customerReaction = emoji;
    return true;
  }
  async updateTemplateStatus(u: TemplateStatusUpdate) {
    this.templates.set(String(u.message_template_id), {
      name: u.message_template_name,
      language: u.message_template_language,
      status: u.event,
      rejectedReason: u.event === "REJECTED" ? (u.rejection_info?.reason ?? u.reason ?? null) : null,
    });
  }
  async applyStatus(s: NormalizedStatus) {
    let m = this.messages.find((x) => x.waMessageId === s.waMessageId);
    if (!m && s.callbackRef) {
      m = this.messages.find((x) => x.id === s.callbackRef && x.direction === "outbound" && !x.waMessageId);
      if (m) m.waMessageId = s.waMessageId;
    }
    if (!m) return false;
    const cur = m.status;
    if ((s.status === "failed" && !["read", "played"].includes(cur)) || (s.status !== "failed" && cur !== "failed" && RANK[s.status]! > RANK[cur]!)) {
      m.status = s.status;
      if (s.error) m.error = s.error;
    }
    return true;
  }
  agentPaused = new Set<string>();
  agentRuns = new Map<string, number>(); // conversación → retraso programado
  async scheduleAgent(conversationId: string, delaySeconds: number) {
    if (this.agentPaused.has(conversationId)) return false;
    this.agentRuns.set(conversationId, Math.max(this.agentRuns.get(conversationId) ?? 0, delaySeconds));
    return true;
  }
  async enqueueJob(type: string, payload: Record<string, unknown>, opts?: EnqueueOptions) {
    if (opts?.dedupeKey && this.jobs.some((j) => j.opts?.dedupeKey === opts.dedupeKey)) return;
    this.jobs.push({ type, payload, opts });
  }
  async logEvent(e: AuditEvent) {
    this.events.push(e);
  }

  /** Simula un mensaje saliente ya enviado (fase 2). */
  addOutbound(waMessageId: string, conversationId: string = randomUUID(), status = "sent", id: string = randomUUID()) {
    this.messages.push({ id, conversationId, type: "text", content: {}, textPreview: null, waMessageId, waTimestamp: new Date(), status, direction: "outbound" });
  }
}
