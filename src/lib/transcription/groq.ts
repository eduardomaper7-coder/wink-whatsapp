import { agentEnv } from "@/lib/agent/config";

/**
 * Transcripción de notas de voz con Groq (Whisper, plan gratuito).
 * Endpoint compatible con OpenAI: POST https://api.groq.com/openai/v1/audio/transcriptions
 * Límites del plan gratuito (docs de Groq): 20 peticiones/min, 2.000/día, 25 MB por archivo.
 */
export const GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export class TranscriptionError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export function transcriptionEnabled(): boolean {
  return !!agentEnv().GROQ_API_KEY;
}

export async function transcribe(bytes: Uint8Array<ArrayBuffer>, mimeType: string, filename = "nota-de-voz.ogg"): Promise<string> {
  const env = agentEnv();
  if (!env.GROQ_API_KEY) throw new TranscriptionError("Transcripción no configurada (GROQ_API_KEY)", false);
  if (bytes.length > MAX_AUDIO_BYTES) throw new TranscriptionError("Audio demasiado largo para transcribir (> 25 MB)", false);

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType.split(";")[0] }), filename);
  form.append("model", env.TRANSCRIPTION_MODEL);
  form.append("language", "es");
  form.append("response_format", "json");
  form.append("prompt", "Conversación con un estudio de arquitectura y reformas de Madrid: reforma integral, cocina, baño, metros cuadrados, Chamberí, Salamanca.");

  let res: Response;
  try {
    res = await fetch(GROQ_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new TranscriptionError(`Sin respuesta de Groq: ${e instanceof Error ? e.message : e}`, true);
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new TranscriptionError(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`, retryable);
  }
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}
