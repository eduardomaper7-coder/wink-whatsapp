import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

let client: SupabaseClient | null = null;

/**
 * Cliente con service role: SOLO en el servidor (webhook, worker, rutas API).
 * Salta RLS, así que nunca debe importarse desde componentes de cliente.
 */
export function supabaseAdmin(): SupabaseClient {
  if (client) return client;
  const e = env();
  client = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
