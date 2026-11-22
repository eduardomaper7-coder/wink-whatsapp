-- =====================================================================
-- Integración con «Recepción del encargo» (app de expedientes de Wink)
-- Las dos apps se comunican por API con un secreto compartido (INTEGRATION_SECRET).
-- Aquí se guarda una copia de lo que Recepción sabe del número, para decidir rápido
-- si responde el asistente y a qué expediente van los mensajes.
-- =====================================================================
alter table public.conversations
  add column if not exists recepcion_kind text,                 -- personal | cliente_con_expediente | cliente | desconocido
  add column if not exists recepcion_mode text,                 -- modo efectivo según Recepción
  add column if not exists recepcion_mode_source text,          -- expediente | ajustes
  add column if not exists recepcion_project_id text,
  add column if not exists recepcion_project_code text,
  add column if not exists recepcion_project_url text,
  add column if not exists recepcion_staff_name text,
  add column if not exists recepcion_checked_at timestamptz,
  add column if not exists reply_mode_override text
    check (reply_mode_override in ('solo_recibir', 'borrador', 'asistente', 'solo_equipo')),
  -- Personal de Wink: expediente elegido para sus mensajes (válido unas horas)
  add column if not exists staff_project_id text,
  add column if not exists staff_project_code text,
  add column if not exists staff_project_at timestamptz,
  -- Hasta qué mensaje se ha enviado ya a Recepción
  add column if not exists recepcion_forwarded_until timestamptz;

alter table public.leads
  add column if not exists recepcion_sent_at timestamptz;
