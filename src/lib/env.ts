import { z } from "zod";

/**
 * Variables de entorno validadas en tiempo de ejecución.
 * Se leen de forma perezosa para que `next build` no falle sin credenciales.
 * Cambiar del número de prueba al definitivo = cambiar estas variables, nada más.
 */
const serverSchema = z.object({
  // WhatsApp Cloud API
  WHATSAPP_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().regex(/^\d+$/, "Debe ser el ID numérico del número"),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().regex(/^\d+$/),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v26.0"),

  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_MEDIA_BUCKET: z.string().default("whatsapp-media"),

  // Worker de la cola
  CRON_SECRET: z.string().min(16, "Usa un secreto largo (mín. 16 caracteres)"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    // Solo nombres de variables: nunca valores.
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuración inválida → ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

/** Solo para tests. */
export function resetEnvCache() {
  cached = null;
}
