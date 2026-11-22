import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueJob } from "@/lib/jobs/queue";
import type { NormalizedStatus, TemplateStatusUpdate } from "../types";
import type { AuditEvent, EnqueueOptions, InboundMessageRow, InboundStore } from "./store";

function fail(op: string, error: { message: string; code?: string } | null): never {
  throw new Error(`[db:${op}] ${error?.code ?? ""} ${error?.message ?? "error desconocido"}`);
}

export class SupabaseInboundStore implements InboundStore {
  constructor(private readonly db: SupabaseClient) {}

  async upsertContact(waId: string, profileName?: string) {
    const row: Record<string, unknown> = { wa_id: waId };
    if (profileName) row.profile_name = profileName;
    const { data, error } = await this.db
      .from("contacts")
      .upsert(row, { onConflict: "wa_id" })
      .select("id")
      .single();
    if (error || !data) fail("upsertContact", error);
    return { id: data.id as string };
  }

  async getOrCreateConversation(contactId: string) {
    const { error: insErr } = await this.db
      .from("conversations")
      .upsert({ contact_id: contactId }, { onConflict: "contact_id", ignoreDuplicates: true });
    if (insErr) fail("createConversation", insErr);
    const { data, error } = await this.db.from("conversations").select("id, status").eq("contact_id", contactId).single();
    if (error || !data) fail("getConversation", error);
    return { id: data.id as string, status: data.status as "bot" | "human" | "closed" };
  }

  async insertInboundMessage(row: InboundMessageRow) {
    const { data, error } = await this.db
      .from("messages")
      .upsert(
        {
          conversation_id: row.conversationId,
          direction: "inbound",
          author: "customer",
          type: row.type,
          content: row.content,
          text_preview: row.textPreview,
          wa_message_id: row.waMessageId,
          reply_to_wa_message_id: row.replyToWaMessageId ?? null,
          status: "received",
          media_id: row.mediaId ?? null,
          media_status: row.mediaId ? "pending" : "none",
          wa_timestamp: row.waTimestamp.toISOString(),
        },
        { onConflict: "wa_message_id", ignoreDuplicates: true },
      )
      .select("id");
    if (error) fail("insertInboundMessage", error);
    const first = data?.[0];
    return first ? { id: first.id as string } : null;
  }

  async touchConversationInbound(conversationId: string, at: Date, preview: string | null, countUnread: boolean) {
    const { error } = await this.db.rpc("touch_conversation_inbound", {
      p_conversation_id: conversationId,
      p_at: at.toISOString(),
      p_preview: preview,
      p_count_unread: countUnread,
    });
    if (error) fail("touchConversationInbound", error);
  }

  async setCustomerReaction(targetWaMessageId: string, emoji: string | null) {
    const { data, error } = await this.db
      .from("messages")
      .update({ customer_reaction: emoji })
      .eq("wa_message_id", targetWaMessageId)
      .select("id");
    if (error) fail("setCustomerReaction", error);
    return (data?.length ?? 0) > 0;
  }

  async applyStatus(s: NormalizedStatus) {
    const { data, error } = await this.db.rpc("apply_message_status", {
      p_wa_message_id: s.waMessageId,
      p_status: s.status,
      p_at: s.timestamp.toISOString(),
      p_error: s.error ?? null,
      p_callback_ref: s.callbackRef ?? null,
    });
    if (error) fail("applyStatus", error);
    return data === true;
  }

  async updateTemplateStatus(u: TemplateStatusUpdate) {
    const id = String(u.message_template_id);
    const reason = u.rejection_info?.reason ?? (u.reason && u.reason !== "NONE" ? u.reason : null);
    const row = {
      id,
      name: u.message_template_name,
      language: u.message_template_language,
      status: u.event,
      rejected_reason: u.event === "REJECTED" ? reason : null,
      ...(u.message_template_category ? { category: u.message_template_category } : {}),
    };
    const { error } = await this.db.from("templates").upsert(row, { onConflict: "id" });
    if (error) fail("updateTemplateStatus", error);
  }

  async scheduleAgent(conversationId: string, delaySeconds: number) {
    const { data, error } = await this.db.rpc("schedule_agent_run", { p_conversation_id: conversationId, p_delay_seconds: delaySeconds });
    if (error) fail("scheduleAgent", error);
    return data === true;
  }

  async enqueueJob(type: string, payload: Record<string, unknown>, opts?: EnqueueOptions) {
    await enqueueJob(this.db, type, payload, opts);
  }

  async logEvent(e: AuditEvent) {
    const { error } = await this.db.from("events").insert({
      type: e.type,
      actor: e.actor ?? "system",
      conversation_id: e.conversationId ?? null,
      message_id: e.messageId ?? null,
      data: e.data ?? {},
    });
    if (error) fail("logEvent", error);
  }
}
