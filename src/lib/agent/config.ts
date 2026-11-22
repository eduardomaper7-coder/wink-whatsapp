import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Configuración del agente. Todo es opcional para que las fases anteriores
 * funcionen sin estas variables; el agente avisa claramente si falta algo.
 */
const agentEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  // Modelos (configurables). Conversación: equilibrio calidad/latencia.
  AGENT_MODEL_CHAT: z.string().default("claude-sonnet-5-5"),
  // Económico: clasificar intención y resumir derivaciones.
  AGENT_MODEL_CLASSIFY: z.string().default("claude-haiku-5-5"),
  // Potente: solo para redactar el briefing del arquitecto.
  AGENT_MODEL_BRIEFING: z.string().default("claude-opus-5-5"),
  AGENT_EFFORT_CHAT: z.enum(["low", "medium", "high"]).default("medium"),
  AGENT_MAX_TURNS: z.coerce.number().int().min(1).max(12).default(6),
  AGENT_HISTORY_MESSAGES: z.coerce.number().int().min(5).max(200).default(40),

  PRIVACY_POLICY_URL: z.string().url().default("https://winkgroup.es/politica-de-privacidad"),
  APP_URL: z.string().url().optional(),

  // Agenda
  CALENDAR_PROVIDER: z.enum(["demo", "google"]).default("demo"),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(), // JSON o base64 del JSON
  GOOGLE_CALENDAR_ID: z.string().optional(),

  // Email (SMTP, p. ej. Hostinger)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(465),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  BRIEFING_EMAIL_TO: z.string().optional(), // uno o varios, separados por comas
  EMAIL_TRANSPORT: z.enum(["smtp", "log"]).default("smtp"), // "log" = no envía (tests/demo sin correo)

  // Transcripción de notas de voz (Groq Whisper, plan gratuito)
  GROQ_API_KEY: z.string().optional(),
  TRANSCRIPTION_MODEL: z.string().default("whisper-large-v3-turbo"),
});

export type AgentEnv = z.infer<typeof agentEnvSchema>;
let cachedEnv: AgentEnv | null = null;

export function agentEnv(): AgentEnv {
  if (!cachedEnv) cachedEnv = agentEnvSchema.parse(process.env);
  return cachedEnv;
}
export function resetAgentEnv() {
  cachedEnv = null;
}

// ---------------------------------------------------------------------
// Archivos editables (agent-config/)
// ---------------------------------------------------------------------
const CONFIG_DIR = process.env.AGENT_CONFIG_DIR ?? path.join(process.cwd(), "agent-config");
const fileCache = new Map<string, string>();

function readConfigFile(name: string): string {
  // En desarrollo se relee siempre (editar el .md se nota al instante)
  if (process.env.NODE_ENV === "production" && fileCache.has(name)) return fileCache.get(name)!;
  const content = readFileSync(path.join(CONFIG_DIR, name), "utf8");
  fileCache.set(name, content);
  return content;
}

export const loadSystemPrompt = () => readConfigFile("system-prompt.md");
export const loadKnowledgeBase = () => readConfigFile("knowledge-base.md");

export interface AgendaConfig {
  zonaHoraria: string;
  duracionVisitaMin: number;
  margenEntreVisitasMin: number;
  antelacionMinimaHoras: number;
  horizonteDias: number;
  huecosAProponer: number;
  pasoMin: number;
  /** Día ISO (1 = lunes … 7 = domingo) → franjas [["09:30","13:30"], …] */
  horario: Record<string, Array<[string, string]>>;
  festivos: string[];
  demo?: { ocupadoSemanal?: Record<string, Array<[string, string]>> };
}

export function loadAgenda(): AgendaConfig {
  return JSON.parse(readConfigFile("agenda.json")) as AgendaConfig;
}

export function privacyNotice(): string {
  return `Al escribirnos aceptas que tratemos tus datos para atender tu consulta; más info en ${agentEnv().PRIVACY_POLICY_URL}`;
}
