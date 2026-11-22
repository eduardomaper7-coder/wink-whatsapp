-- =====================================================================
-- Wink · WhatsApp — esquema inicial
-- Incluye el modelo completo (aunque algunas tablas se usan en fases
-- posteriores) para no tener que migrar datos más adelante.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
create type public.team_role            as enum ('admin', 'agent');
create type public.conversation_status  as enum ('bot', 'human', 'closed');
create type public.message_direction    as enum ('inbound', 'outbound');
create type public.message_author       as enum ('customer', 'agent', 'human', 'system');
create type public.message_type         as enum (
  'text', 'image', 'document', 'audio', 'video', 'sticker', 'location',
  'interactive', 'button', 'reaction', 'template', 'unsupported', 'system'
);
create type public.message_status       as enum ('received', 'queued', 'sent', 'delivered', 'read', 'played', 'failed');
create type public.media_status         as enum ('none', 'pending', 'stored', 'failed');
create type public.lead_status          as enum ('new', 'qualifying', 'visit_scheduled', 'handed_off', 'won', 'lost', 'closed');
create type public.project_type         as enum ('reforma_integral', 'reforma_parcial', 'interiorismo', 'obra_nueva', 'otro');
create type public.contact_preference   as enum ('whatsapp', 'llamada', 'email');
create type public.job_status           as enum ('queued', 'running', 'done', 'failed', 'dead');

-- ---------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Equipo (perfiles enlazados a Supabase Auth)
-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  full_name   text not null default '',
  email       text,
  role        public.team_role not null default 'agent',
  active      boolean not null default false,   -- un admin debe activar a cada miembro
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Crea el perfil al dar de alta un usuario en Auth (inactivo por defecto).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role, active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce((new.raw_app_meta_data ->> 'role')::public.team_role, 'agent'),
    coalesce((new.raw_app_meta_data ->> 'active')::boolean, false)
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_team_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role = 'admin');
$$;

-- ---------------------------------------------------------------------
-- Contactos
-- ---------------------------------------------------------------------
create table public.contacts (
  id                      uuid primary key default gen_random_uuid(),
  wa_id                   text not null unique,          -- teléfono en formato WhatsApp (sin +)
  name                    text,                          -- nombre confirmado por el cliente
  profile_name            text,                          -- nombre del perfil de WhatsApp
  email                   text,
  consent_notice_sent_at  timestamptz,                   -- cuándo se envió el aviso de privacidad
  consent_at              timestamptz,                   -- cuándo continuó tras el aviso
  opted_out_at            timestamptz,                   -- pidió no ser contactado
  is_existing_client      boolean not null default false,-- obra en curso
  is_supplier             boolean not null default false,
  notes                   text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create trigger contacts_updated_at before update on public.contacts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Conversaciones (una por contacto; se reabre al volver a escribir)
-- ---------------------------------------------------------------------
create table public.conversations (
  id                    uuid primary key default gen_random_uuid(),
  contact_id            uuid not null unique references public.contacts (id) on delete cascade,
  status                public.conversation_status not null default 'bot',
  agent_active          boolean not null default true,
  assigned_to           uuid references public.profiles (id) on delete set null,
  handoff_reason        text,
  last_inbound_at       timestamptz,          -- base de la ventana de 24 h
  last_message_at       timestamptz,
  last_message_preview  text,
  unread_count          integer not null default 0,
  closed_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index conversations_last_message_idx on public.conversations (last_message_at desc nulls last);
create index conversations_status_idx       on public.conversations (status);
create index conversations_assigned_idx     on public.conversations (assigned_to);
create trigger conversations_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();

-- Ventana de servicio de 24 h calculada en la base de datos (fuente única de verdad).
create or replace function public.conversation_window_open(c public.conversations) returns boolean
language sql stable as $$
  select c.last_inbound_at is not null and c.last_inbound_at > now() - interval '24 hours';
$$;

-- ---------------------------------------------------------------------
-- Expedientes (leads)
-- ---------------------------------------------------------------------
create table public.leads (
  id                    uuid primary key default gen_random_uuid(),
  contact_id            uuid not null references public.contacts (id) on delete cascade,
  conversation_id       uuid references public.conversations (id) on delete set null,
  status                public.lead_status not null default 'new',
  source                text,                       -- p. ej. anuncio click-to-WhatsApp, web…
  -- Cualificación
  full_name             text,
  project_type          public.project_type,
  project_type_other    text,
  address               text,                       -- dirección o barrio
  city                  text default 'Madrid',
  surface_m2            numeric(8,2),
  property_state        text,                       -- estado actual de la vivienda
  goals                 text,                       -- qué quiere conseguir
  budget_range          text,                       -- presupuesto orientativo (texto del cliente)
  desired_timeline      text,                       -- plazos deseados
  contact_preference    public.contact_preference,
  contact_preference_notes text,
  missing_fields        text[] not null default '{}',
  -- Visita técnica
  visit_at              timestamptz,
  visit_calendar_event_id text,
  -- Briefing para el arquitecto
  briefing_md           text,
  briefing_generated_at timestamptz,
  briefing_sent_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index leads_contact_idx      on public.leads (contact_id);
create index leads_conversation_idx on public.leads (conversation_id);
create index leads_status_idx       on public.leads (status);
create trigger leads_updated_at before update on public.leads
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Mensajes
-- ---------------------------------------------------------------------
create table public.messages (
  id                     uuid primary key default gen_random_uuid(),
  conversation_id        uuid not null references public.conversations (id) on delete cascade,
  direction              public.message_direction not null,
  author                 public.message_author not null,
  sent_by                uuid references public.profiles (id) on delete set null,  -- si author = human
  type                   public.message_type not null,
  content                jsonb not null default '{}'::jsonb,   -- forma normalizada por tipo
  text_preview           text,                                  -- texto plano para listas/búsqueda
  wa_message_id          text unique,                           -- wamid.* (idempotencia)
  reply_to_wa_message_id text,
  status                 public.message_status not null,
  status_updated_at      timestamptz,
  error                  jsonb,                                 -- {code,title,details}
  customer_reaction      text,                                  -- emoji del cliente sobre este mensaje
  media_id               text,                                  -- id de media en Meta
  media_status           public.media_status not null default 'none',
  wa_timestamp           timestamptz,                           -- hora según WhatsApp
  created_at             timestamptz not null default now()
);
create index messages_conversation_idx on public.messages (conversation_id, created_at);
create index messages_status_idx       on public.messages (status) where direction = 'outbound';

-- Orden de estados: nunca se retrocede (Meta puede enviar read antes que delivered).
create or replace function public.message_status_rank(s public.message_status) returns int
language sql immutable as $$
  select case s
    when 'received'  then 0
    when 'queued'    then 1
    when 'sent'      then 2
    when 'delivered' then 3
    when 'read'      then 4
    when 'played'    then 5
    when 'failed'    then 6
  end;
$$;

-- Aplica un estado de salida. Devuelve true si el mensaje existe (aunque no cambie).
create or replace function public.apply_message_status(
  p_wa_message_id text,
  p_status        public.message_status,
  p_at            timestamptz,
  p_error         jsonb default null
) returns boolean
language plpgsql as $$
declare
  v_current public.message_status;
begin
  select status into v_current from public.messages
   where wa_message_id = p_wa_message_id
   for update;
  if not found then
    return false;
  end if;

  -- failed solo si aún no se había leído; el resto solo avanza
  if (p_status = 'failed' and v_current not in ('read', 'played'))
     or (p_status <> 'failed' and v_current <> 'failed'
         and public.message_status_rank(p_status) > public.message_status_rank(v_current)) then
    update public.messages
       set status = p_status,
           status_updated_at = p_at,
           error = coalesce(p_error, error)
     where wa_message_id = p_wa_message_id;
  end if;
  return true;
end $$;

-- Actualiza la conversación al entrar un mensaje del cliente (atómico).
create or replace function public.touch_conversation_inbound(
  p_conversation_id uuid,
  p_at              timestamptz,
  p_preview         text,
  p_count_unread    boolean
) returns void
language sql as $$
  update public.conversations
     set last_inbound_at      = greatest(coalesce(last_inbound_at, p_at), p_at),
         last_message_at      = greatest(coalesce(last_message_at, p_at), p_at),
         last_message_preview = case when p_preview is null then last_message_preview else left(p_preview, 140) end,
         unread_count         = unread_count + case when p_count_unread then 1 else 0 end,
         -- Si estaba cerrada, se reabre con el agente activo
         status               = case when status = 'closed' then 'bot'::public.conversation_status else status end,
         agent_active         = case when status = 'closed' then true else agent_active end,
         closed_at            = case when status = 'closed' then null else closed_at end
   where id = p_conversation_id;
$$;

-- ---------------------------------------------------------------------
-- Adjuntos (Storage)
-- ---------------------------------------------------------------------
create table public.attachments (
  id               uuid primary key default gen_random_uuid(),
  message_id       uuid references public.messages (id) on delete set null,
  conversation_id  uuid references public.conversations (id) on delete cascade,
  lead_id          uuid references public.leads (id) on delete set null,
  storage_bucket   text not null,
  storage_path     text not null,
  kind             text not null,           -- image | document | audio | video | sticker
  mime_type        text,
  size_bytes       bigint,
  sha256           text,
  original_filename text,
  caption          text,
  created_at       timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);
create unique index attachments_message_uidx on public.attachments (message_id) where message_id is not null;
create index attachments_lead_idx         on public.attachments (lead_id);
create index attachments_conversation_idx on public.attachments (conversation_id);

-- ---------------------------------------------------------------------
-- Auditoría del agente: herramientas usadas y por qué
-- ---------------------------------------------------------------------
create table public.agent_runs (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  trigger_message_ids uuid[] not null default '{}',
  model            text not null,
  input_tokens     integer,
  output_tokens    integer,
  tool_calls       jsonb not null default '[]'::jsonb,  -- [{name,input,reason,result,ms}]
  reply_text       text,
  outcome          text not null,                       -- replied | handed_off | skipped | error
  error            text,
  duration_ms      integer,
  created_at       timestamptz not null default now()
);
create index agent_runs_conversation_idx on public.agent_runs (conversation_id, created_at desc);

-- ---------------------------------------------------------------------
-- Plantillas aprobadas (caché sincronizada desde la WABA)
-- ---------------------------------------------------------------------
create table public.templates (
  id            text primary key,          -- id de Meta
  name          text not null,
  language      text not null,
  category      text,
  status        text not null,             -- APPROVED, PAUSED, REJECTED…
  components    jsonb not null default '[]'::jsonb,
  synced_at     timestamptz not null default now(),
  unique (name, language)
);

-- ---------------------------------------------------------------------
-- Suscripciones Web Push
-- ---------------------------------------------------------------------
create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);

-- ---------------------------------------------------------------------
-- Webhooks recibidos (crudos, para depurar y reprocesar)
-- ---------------------------------------------------------------------
create table public.wa_webhook_events (
  id            bigint generated always as identity primary key,
  body_sha256   text not null unique,      -- Meta reintenta con el mismo cuerpo → dedupe
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);

-- ---------------------------------------------------------------------
-- Cola de trabajos
-- ---------------------------------------------------------------------
create table public.jobs (
  id            bigint generated always as identity primary key,
  type          text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        public.job_status not null default 'queued',
  attempts      integer not null default 0,
  max_attempts  integer not null default 8,
  run_after     timestamptz not null default now(),
  locked_at     timestamptz,
  last_error    text,
  dedupe_key    text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index jobs_ready_idx on public.jobs (run_after) where status = 'queued';
create trigger jobs_updated_at before update on public.jobs
  for each row execute function public.set_updated_at();

-- Reclama trabajos listos sin pisarse entre workers concurrentes.
create or replace function public.claim_jobs(p_limit integer default 10, p_stale_after interval default interval '5 minutes')
returns setof public.jobs
language plpgsql as $$
begin
  -- Recupera trabajos que se quedaron "running" (función cortada por timeout)
  update public.jobs
     set status = 'queued', locked_at = null,
         last_error = coalesce(last_error, '') || ' [recuperado tras bloqueo]'
   where status = 'running' and locked_at < now() - p_stale_after;

  return query
  update public.jobs j
     set status = 'running', locked_at = now(), attempts = j.attempts + 1
   where j.id in (
     select id from public.jobs
      where status = 'queued' and run_after <= now()
      order by run_after
      limit p_limit
      for update skip locked
   )
  returning j.*;
end $$;

-- ---------------------------------------------------------------------
-- Auditoría general
-- ---------------------------------------------------------------------
create table public.events (
  id               bigint generated always as identity primary key,
  type             text not null,              -- message.received, status.failed, agent.handoff…
  actor            text not null default 'system', -- system | agent | user:<uuid> | customer
  conversation_id  uuid references public.conversations (id) on delete cascade,
  lead_id          uuid references public.leads (id) on delete set null,
  message_id       uuid references public.messages (id) on delete set null,
  data             jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);
create index events_conversation_idx on public.events (conversation_id, created_at desc);
create index events_type_idx         on public.events (type, created_at desc);

-- =====================================================================
-- Row Level Security
-- El backend usa la service role (salta RLS). El navegador usa la clave
-- anónima + sesión del usuario, y solo ve datos si es miembro activo.
-- =====================================================================
alter table public.profiles           enable row level security;
alter table public.contacts           enable row level security;
alter table public.conversations      enable row level security;
alter table public.leads              enable row level security;
alter table public.messages           enable row level security;
alter table public.attachments        enable row level security;
alter table public.agent_runs         enable row level security;
alter table public.templates          enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.wa_webhook_events  enable row level security;
alter table public.jobs               enable row level security;
alter table public.events             enable row level security;

-- Perfiles
create policy "equipo ve perfiles"        on public.profiles for select to authenticated using (public.is_team_member() or id = auth.uid());
create policy "admin gestiona perfiles"   on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "cada uno edita su perfil"  on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Un miembro no admin no puede cambiarse el rol ni activarse a sí mismo.
create or replace function public.guard_profile_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin()
     and (new.role is distinct from old.role or new.active is distinct from old.active) then
    raise exception 'Solo un administrador puede cambiar el rol o el estado de un usuario';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- Datos operativos: lectura para el equipo; cambios puntuales permitidos
create policy "equipo lee contactos"       on public.contacts      for select to authenticated using (public.is_team_member());
create policy "equipo edita contactos"     on public.contacts      for update to authenticated using (public.is_team_member()) with check (public.is_team_member());
create policy "equipo lee conversaciones"  on public.conversations for select to authenticated using (public.is_team_member());
create policy "equipo edita conversaciones" on public.conversations for update to authenticated using (public.is_team_member()) with check (public.is_team_member());
create policy "equipo lee leads"           on public.leads         for select to authenticated using (public.is_team_member());
create policy "equipo edita leads"         on public.leads         for update to authenticated using (public.is_team_member()) with check (public.is_team_member());
create policy "equipo lee mensajes"        on public.messages      for select to authenticated using (public.is_team_member());
create policy "equipo lee adjuntos"        on public.attachments   for select to authenticated using (public.is_team_member());
create policy "equipo lee plantillas"      on public.templates     for select to authenticated using (public.is_team_member());
create policy "equipo lee eventos"         on public.events        for select to authenticated using (public.is_team_member());
-- Los mensajes salientes se envían siempre por la API del servidor (valida ventana 24 h), no por insert directo.

-- Solo administradores
create policy "admin lee ejecuciones agente" on public.agent_runs        for select to authenticated using (public.is_admin());
create policy "admin lee webhooks"           on public.wa_webhook_events for select to authenticated using (public.is_admin());
create policy "admin lee cola"               on public.jobs              for select to authenticated using (public.is_admin());

-- Push: cada usuario gestiona las suyas
create policy "push propias select" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "push propias insert" on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid() and public.is_team_member());
create policy "push propias delete" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

-- Funciones internas: solo la service role
revoke execute on function public.claim_jobs(integer, interval)                         from public, anon, authenticated;
revoke execute on function public.apply_message_status(text, public.message_status, timestamptz, jsonb) from public, anon, authenticated;
revoke execute on function public.touch_conversation_inbound(uuid, timestamptz, text, boolean) from public, anon, authenticated;
grant  execute on function public.claim_jobs(integer, interval)                         to service_role;
grant  execute on function public.apply_message_status(text, public.message_status, timestamptz, jsonb) to service_role;
grant  execute on function public.touch_conversation_inbound(uuid, timestamptz, text, boolean) to service_role;

-- =====================================================================
-- Storage: bucket privado para la multimedia de WhatsApp
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('whatsapp-media', 'whatsapp-media', false, 104857600)  -- 100 MB (límite de documentos en WhatsApp)
on conflict (id) do nothing;

create policy "equipo lee media whatsapp" on storage.objects for select to authenticated
  using (bucket_id = 'whatsapp-media' and public.is_team_member());

-- =====================================================================
-- Realtime: tablas que la bandeja escucha en directo
-- =====================================================================
alter publication supabase_realtime add table public.conversations, public.messages, public.leads, public.attachments;
