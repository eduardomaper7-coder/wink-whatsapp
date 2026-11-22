import type { MessageType, NormalizedStatus, TemplateStatusUpdate } from "../types";

/**
 * Operaciones de persistencia que necesita el procesado de webhooks.
 * Separadas en una interfaz para poder probar la lógica sin base de datos
 * (ver tests/helpers/memory-store.ts) y para no acoplarla a Supabase.
 */
export interface InboundMessageRow {
  conversationId: string;
  type: MessageType;
  content: Record<string, unknown>;
  textPreview: string | null;
  waMessageId: string;
  replyToWaMessageId?: string;
  mediaId?: string;
  waTimestamp: Date;
}

export interface EnqueueOptions {
  dedupeKey?: string;
  runAfter?: Date;
  maxAttempts?: number;
}

export interface AuditEvent {
  type: string;
  actor?: string;
  conversationId?: string;
  messageId?: string;
  data?: Record<string, unknown>;
}

export interface InboundStore {
  upsertContact(waId: string, profileName?: string): Promise<{ id: string }>;
  getOrCreateConversation(contactId: string): Promise<{ id: string; status: "bot" | "human" | "closed" }>;
  /** Devuelve null si el wamid ya existía (reintento de Meta). */
  insertInboundMessage(row: InboundMessageRow): Promise<{ id: string } | null>;
  touchConversationInbound(conversationId: string, at: Date, preview: string | null, countUnread: boolean): Promise<void>;
  /** Guarda la reacción del cliente sobre un mensaje. false si el mensaje no existe. */
  setCustomerReaction(targetWaMessageId: string, emoji: string | null): Promise<boolean>;
  /** false si no existe el mensaje saliente (aún). */
  applyStatus(status: NormalizedStatus): Promise<boolean>;
  /** Actualiza la caché de plantillas al recibir un cambio de estado de Meta. */
  updateTemplateStatus(update: TemplateStatusUpdate): Promise<void>;
  /** Programa (o retrasa) la respuesta del agente. false si está pausado o en modo humano. */
  scheduleAgent(conversationId: string, delaySeconds: number): Promise<boolean>;
  enqueueJob(type: string, payload: Record<string, unknown>, opts?: EnqueueOptions): Promise<void>;
  logEvent(event: AuditEvent): Promise<void>;
}
