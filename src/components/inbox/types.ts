export interface Contact {
  id: string;
  wa_id: string;
  name: string | null;
  profile_name: string | null;
}

export interface ConversationItem {
  id: string;
  status: "bot" | "human" | "closed";
  agent_active: boolean;
  assigned_to: string | null;
  handoff_reason: string | null;
  last_inbound_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  contact: Contact;
}

export interface MessageItem {
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  author: "customer" | "agent" | "human" | "system";
  sent_by: string | null;
  type: string;
  content: Record<string, unknown>;
  text_preview: string | null;
  wa_message_id: string | null;
  status: string;
  error: Record<string, unknown> | null;
  customer_reaction: string | null;
  media_status: string;
  created_at: string;
}

export interface Attachment {
  id: string;
  message_id: string | null;
  lead_id: string | null;
  storage_bucket: string;
  storage_path: string;
  kind: string;
  mime_type: string | null;
  original_filename: string | null;
  description: string | null;
  caption: string | null;
  created_at: string;
}

export interface Lead {
  id: string;
  status: string;
  source: string | null;
  full_name: string | null;
  project_type: string | null;
  project_type_other: string | null;
  address: string | null;
  surface_m2: number | null;
  property_state: string | null;
  goals: string | null;
  budget_range: string | null;
  desired_timeline: string | null;
  contact_preference: string | null;
  contact_preference_notes: string | null;
  contact_email: string | null;
  visit_at: string | null;
  briefing_md: string | null;
  briefing_sent_at: string | null;
  handoff_summary: string | null;
  updated_at: string;
}

export interface TeamMember {
  id: string;
  full_name: string;
  email: string | null;
  role: "admin" | "agent";
}

export interface EventItem {
  id: number;
  type: string;
  actor: string;
  data: Record<string, unknown>;
  created_at: string;
}
