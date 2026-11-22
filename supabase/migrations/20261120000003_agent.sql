-- =====================================================================
-- Fase 3 · Agente de captación y seguimiento
-- =====================================================================

-- Conversación: bloqueo para que nunca haya dos ejecuciones del agente a la vez
alter table public.conversations
  add column agent_lock_until  timestamptz,
  add column agent_last_run_at timestamptz;

-- Expediente: datos que gestiona el agente
alter table public.leads
  add column offered_slots     jsonb not null default '[]'::jsonb,  -- huecos propuestos [{id,start,end,label}]
  add column visit_end_at      timestamptz,
  add column contact_email     text,
  add column classification    jsonb,                               -- última clasificación (Haiku)
  add column handoff_summary   text,
  add column briefing_error    text;

-- Adjuntos: descripción que da el agente al registrarlos en el expediente
alter table public.attachments add column description text;

-- ---------------------------------------------------------------------
-- Programa (o retrasa) la respuesta del agente: agrupa ráfagas de mensajes.
-- Si ya hay una ejecución en cola para la conversación, solo se retrasa.
-- Devuelve false si el agente no debe actuar (pausado o modo humano).
-- ---------------------------------------------------------------------
create index jobs_agent_queued_idx on public.jobs ((payload ->> 'conversationId'))
  where type = 'agent_reply' and status = 'queued';

create or replace function public.schedule_agent_run(p_conversation_id uuid, p_delay_seconds integer default 6)
returns boolean
language plpgsql as $$
declare
  v_ok boolean;
begin
  select (agent_active and status = 'bot') into v_ok from public.conversations where id = p_conversation_id;
  if not coalesce(v_ok, false) then
    return false;
  end if;

  update public.jobs
     set run_after = greatest(run_after, now() + make_interval(secs => p_delay_seconds))
   where type = 'agent_reply' and status = 'queued'
     and payload ->> 'conversationId' = p_conversation_id::text;
  if found then
    return true;
  end if;

  insert into public.jobs (type, payload, run_after, max_attempts)
  values ('agent_reply', jsonb_build_object('conversationId', p_conversation_id), now() + make_interval(secs => p_delay_seconds), 4);
  return true;
end $$;

-- Bloqueo por conversación (expira solo si el proceso muere)
create or replace function public.try_lock_agent(p_conversation_id uuid, p_seconds integer default 120)
returns boolean
language sql as $$
  with locked as (
    update public.conversations
       set agent_lock_until = now() + make_interval(secs => p_seconds)
     where id = p_conversation_id
       and (agent_lock_until is null or agent_lock_until < now())
    returning id
  )
  select exists (select 1 from locked);
$$;

create or replace function public.release_agent_lock(p_conversation_id uuid)
returns void
language sql as $$
  update public.conversations set agent_lock_until = null, agent_last_run_at = now() where id = p_conversation_id;
$$;

revoke execute on function public.schedule_agent_run(uuid, integer) from public, anon, authenticated;
revoke execute on function public.try_lock_agent(uuid, integer)      from public, anon, authenticated;
revoke execute on function public.release_agent_lock(uuid)           from public, anon, authenticated;
grant  execute on function public.schedule_agent_run(uuid, integer) to service_role;
grant  execute on function public.try_lock_agent(uuid, integer)      to service_role;
grant  execute on function public.release_agent_lock(uuid)           to service_role;

-- La bandeja escucha los eventos (derivaciones, visitas, avisos) en tiempo real
alter publication supabase_realtime add table public.events;
