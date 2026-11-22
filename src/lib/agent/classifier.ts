import { callClaude, textOf } from "@/lib/ai/anthropic";
import { agentEnv } from "./config";

/**
 * Clasificador rápido y económico (Haiku) que se ejecuta antes del agente.
 * Detecta de forma determinista los casos de derivación obligatoria, para no
 * depender solo de que el modelo conversacional decida derivar.
 */
export interface Classification {
  categoria: "cliente_potencial" | "obra_en_curso" | "proveedor" | "otro";
  pide_humano: boolean;
  molesto: boolean;
  urgente: boolean;
  confianza: number; // 0–1
  resumen: string; // 1–2 frases para el equipo
}

const PROMPT = `Eres un clasificador de mensajes de WhatsApp que recibe Wink, un estudio de arquitectura y reformas de Madrid.
Analiza los últimos mensajes del cliente y responde SOLO con un objeto JSON, sin texto adicional, con esta forma exacta:
{"categoria":"cliente_potencial|obra_en_curso|proveedor|otro","pide_humano":bool,"molesto":bool,"urgente":bool,"confianza":0-1,"resumen":"..."}

Criterios:
- cliente_potencial: alguien interesado en una reforma, interiorismo u obra que aún no es cliente.
- obra_en_curso: ya es cliente de Wink y escribe sobre SU obra o proyecto en marcha (incidencias, pagos, visitas de obra, plazos de su obra).
- proveedor: proveedores, comerciales, ofertas de servicios, candidatos a empleo, colaboraciones.
- otro: cualquier otra cosa (equivocados, spam, saludos sin contexto…). Ante la duda en un primer saludo, usa cliente_potencial.
- pide_humano: true solo si pide explícitamente hablar con una persona, que le llamen o no quiere hablar con un bot.
- molesto: true si se queja, está enfadado o muestra frustración clara.
- urgente: true si describe una urgencia real (filtración, avería grave, riesgo).
- confianza: tu seguridad en la clasificación.
- resumen: 1–2 frases en español para el equipo (quién es y qué quiere).`;

export async function classify(customerText: string, context: { esPrimerContacto: boolean; yaEsCliente: boolean; esProveedor: boolean }): Promise<Classification | null> {
  const res = await callClaude(
    {
      model: agentEnv().AGENT_MODEL_CLASSIFY,
      max_tokens: 400,
      effort: "low",
      system: [{ type: "text", text: PROMPT }],
      messages: [
        {
          role: "user",
          content: `Contexto: ${JSON.stringify(context)}\n\nMensajes recientes del cliente (del más antiguo al más reciente):\n${customerText}`,
        },
      ],
    },
    { retries: 2, timeoutMs: 30_000 },
  );
  return parseClassification(textOf(res.content));
}

export function parseClassification(text: string): Classification | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const j = JSON.parse(match[0]) as Partial<Classification>;
    const categorias = ["cliente_potencial", "obra_en_curso", "proveedor", "otro"] as const;
    return {
      categoria: categorias.includes(j.categoria as never) ? (j.categoria as Classification["categoria"]) : "otro",
      pide_humano: j.pide_humano === true,
      molesto: j.molesto === true,
      urgente: j.urgente === true,
      confianza: typeof j.confianza === "number" ? Math.max(0, Math.min(1, j.confianza)) : 0.5,
      resumen: typeof j.resumen === "string" ? j.resumen.slice(0, 500) : "",
    };
  } catch {
    return null;
  }
}

export type HandoffCategory = "lo_pide_cliente" | "cliente_molesto" | "obra_en_curso" | "proveedor" | "urgencia" | "duda" | "error" | "otro";

/** ¿Obliga la clasificación a derivar sin pasar por el agente? */
export function mandatoryHandoff(c: Classification | null, minConfidence = 0.7): HandoffCategory | null {
  if (!c || c.confianza < minConfidence) return null;
  if (c.urgente) return "urgencia";
  if (c.pide_humano) return "lo_pide_cliente";
  if (c.molesto) return "cliente_molesto";
  if (c.categoria === "obra_en_curso") return "obra_en_curso";
  if (c.categoria === "proveedor") return "proveedor";
  return null;
}

export const HANDOFF_MESSAGES: Record<HandoffCategory, string> = {
  lo_pide_cliente: "Claro, te paso con una persona del equipo. Te escribirá por aquí en cuanto pueda.",
  cliente_molesto: "Siento mucho las molestias. Te paso ahora con una persona del equipo para que lo vea personalmente.",
  obra_en_curso: "Gracias por escribir. Te paso con la persona del equipo que lleva las obras para que te ayude directamente.",
  proveedor: "Gracias por contactar con Wink. Paso tu mensaje al equipo y te responderán por aquí.",
  urgencia: "Entendido, es importante. Aviso ahora mismo a una persona del equipo para que te atienda cuanto antes.",
  duda: "Prefiero que esto te lo confirme una persona del equipo. Te escribirá por aquí en cuanto pueda.",
  error: "Te paso con una persona del equipo, que te escribirá por aquí en cuanto pueda.",
  otro: "Te paso con una persona del equipo, que te escribirá por aquí en cuanto pueda.",
};
