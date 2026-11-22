import { agentEnv } from "@/lib/agent/config";
import { log } from "@/lib/log";

/**
 * Cliente mínimo de la Messages API de Anthropic (fetch directo, sin SDK):
 * control total de los parámetros nuevos (output_config.effort, thinking) y
 * fácil de simular en tests.
 *
 * Notas de los modelos 5.5 (docs de Claude):
 *  - tool_choice "any"/"tool" devuelve 400 → usamos siempre "auto".
 *  - temperature/top_p/top_k devuelven 400 → no se envían.
 *  - Los bloques de pensamiento deben devolverse intactos en el bucle de herramientas.
 */
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

export type ContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "thinking"; [k: string]: unknown }
  | { type: "redacted_thinking"; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: ClaudeMessage[];
  tools?: ToolDefinition[];
  effort?: "low" | "medium" | "high";
}

export interface ClaudeResponse {
  id: string;
  model: string;
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "pause_turn" | "refusal" | string;
  content: ContentBlock[];
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

export class ClaudeApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = "ClaudeApiError";
  }
}

export async function callClaude(req: ClaudeRequest, opts: { retries?: number; timeoutMs?: number } = {}): Promise<ClaudeResponse> {
  const key = agentEnv().ANTHROPIC_API_KEY;
  if (!key) throw new ClaudeApiError("Falta ANTHROPIC_API_KEY", 0, false);

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_tokens,
    messages: req.messages,
    ...(req.system ? { system: req.system } : {}),
    ...(req.tools?.length ? { tools: req.tools, tool_choice: { type: "auto" } } : {}),
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
  };

  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
      });
    } catch (e) {
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new ClaudeApiError(`Sin respuesta de la API de Claude: ${e instanceof Error ? e.message : e}`, 0, true);
    }

    if (res.ok) {
      const json = (await res.json()) as ClaudeResponse;
      log.debug("claude.usage", { model: json.model, ...json.usage });
      return json;
    }

    // 429 (límite), 529 (sobrecarga) y 5xx son temporales
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    const text = await res.text().catch(() => "");
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20_000) : backoff(attempt));
      continue;
    }
    throw new ClaudeApiError(`API de Claude ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
  }
}

const backoff = (attempt: number) => Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Texto concatenado de los bloques de texto de una respuesta. */
export function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
