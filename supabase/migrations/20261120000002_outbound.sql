-- =====================================================================
-- Fase 2 · Envío de mensajes
-- =====================================================================

-- Clave de idempotencia del cliente (doble clic en "Enviar" no duplica)
alter table public.messages add column client_ref text unique;
-- Mensajes salientes pendientes/en reintento
create index messages_outbound_pending_idx on public.messages (created_at)
  where direction = 'outbound' and wa_message_id is null;

-- Plantillas: más detalle para la interfaz y auditoría
alter table public.templates
  add column rejected_reason   text,
  add column parameter_format  text,           -- POSITIONAL | NAMED
  add column updated_at        timestamptz not null default now();
create trigger templates_updated_at before update on public.templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- apply_message_status con recuperación por biz_opaque_callback_data:
-- si no conocemos el wamid (p. ej. se perdió la respuesta de Meta por timeout)
-- pero el estado trae nuestro id interno, enlazamos el wamid y aplicamos.
-- ---------------------------------------------------------------------
drop function public.apply_message_status(text, public.message_status, timestamptz, jsonb);

create or replace function public.apply_message_status(
  p_wa_message_id text,
  p_status        public.message_status,
  p_at            timestamptz,
  p_error         jsonb default null,
  p_callback_ref  text  default null
) returns boolean
language plpgsql as $$
declare
  v_current public.message_status;
begin
  select status into v_current from public.messages
   where wa_message_id = p_wa_message_id
   for update;

  if not found and p_callback_ref is not null
     and p_callback_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    update public.messages
       set wa_message_id = p_wa_message_id
     where id = p_callback_ref::uuid and wa_message_id is null and direction = 'outbound'
    returning status into v_current;
  end if;

  if v_current is null then
    return false;
  end if;

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

revoke execute on function public.apply_message_status(text, public.message_status, timestamptz, jsonb, text) from public, anon, authenticated;
grant  execute on function public.apply_message_status(text, public.message_status, timestamptz, jsonb, text) to service_role;

-- ---------------------------------------------------------------------
-- Actualiza la conversación al enviar. Si escribe una persona del equipo:
-- pasa a modo humano, se pausa el agente y se marcan como leídos.
-- ---------------------------------------------------------------------
create or replace function public.touch_conversation_outbound(
  p_conversation_id uuid,
  p_at              timestamptz,
  p_preview         text,
  p_by_human        boolean,
  p_user            uuid default null
) returns void
language sql as $$
  update public.conversations
     set last_message_at      = greatest(coalesce(last_message_at, p_at), p_at),
         last_message_preview = left(p_preview, 140),
         status       = case when p_by_human then 'human'::public.conversation_status else status end,
         agent_active = case when p_by_human then false else agent_active end,
         assigned_to  = case when p_by_human and assigned_to is null then p_user else assigned_to end,
         unread_count = case when p_by_human then 0 else unread_count end,
         closed_at    = case when p_by_human then null else closed_at end
   where id = p_conversation_id;
$$;
revoke execute on function public.touch_conversation_outbound(uuid, timestamptz, text, boolean, uuid) from public, anon, authenticated;
grant  execute on function public.touch_conversation_outbound(uuid, timestamptz, text, boolean, uuid) to service_role;

-- ---------------------------------------------------------------------
-- Storage: el equipo sube adjuntos salientes a whatsapp-media/outbound/…
-- (el envío real lo hace el servidor, que valida la ruta)
-- ---------------------------------------------------------------------
create policy "equipo sube adjuntos salientes" on storage.objects for insert to authenticated
  with check (bucket_id = 'whatsapp-media' and name like 'outbound/%' and public.is_team_member());

-- Realtime de plantillas (la interfaz refleja aprobaciones/rechazos)
alter publication supabase_realtime add table public.templates;
