\set ON_ERROR_STOP 1
-- Datos base
insert into public.contacts (id, wa_id) values ('00000000-0000-0000-0000-0000000000c1', '34600111222');
insert into public.conversations (id, contact_id, status, agent_active) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'closed', false);
insert into public.messages (conversation_id, direction, author, type, wa_message_id, status)
  values ('00000000-0000-0000-0000-0000000000a1', 'outbound', 'agent', 'text', 'wamid.OUT1', 'sent');

-- 1) read llega antes que delivered → se queda en read
select public.apply_message_status('wamid.OUT1', 'read', now(), null) as found_read;
select public.apply_message_status('wamid.OUT1', 'delivered', now(), null) as found_delivered;
do $$ begin assert (select status from public.messages where wa_message_id='wamid.OUT1') = 'read', 'read no debe retroceder'; end $$;
-- 2) failed no pisa un read
select public.apply_message_status('wamid.OUT1', 'failed', now(), '{"code":131026}'::jsonb);
do $$ begin assert (select status from public.messages where wa_message_id='wamid.OUT1') = 'read', 'failed no pisa read'; end $$;
-- 3) id desconocido → false
do $$ begin assert public.apply_message_status('wamid.NOPE', 'sent', now(), null) = false, 'desconocido = false'; end $$;
-- 4) touch reabre conversación cerrada y cuenta no leídos
select public.touch_conversation_inbound('00000000-0000-0000-0000-0000000000a1', now(), 'Hola', true);
do $$ declare c public.conversations; begin
  select * into c from public.conversations where id='00000000-0000-0000-0000-0000000000a1';
  assert c.status='bot' and c.agent_active and c.unread_count=1 and public.conversation_window_open(c), 'reapertura';
end $$;
-- 5) cola: claim con skip locked, dedupe_key
insert into public.jobs (type, payload, dedupe_key) values ('process_webhook', '{}', 'k1');
insert into public.jobs (type, payload, dedupe_key) values ('process_webhook', '{}', 'k1') on conflict (dedupe_key) do nothing;
do $$ begin assert (select count(*) from public.jobs) = 1, 'dedupe'; end $$;
do $$ begin assert (select count(*) from public.claim_jobs(10)) = 1, 'claim 1'; end $$;
do $$ begin assert (select count(*) from public.claim_jobs(10)) = 0, 'no reclama dos veces'; end $$;
update public.jobs set locked_at = now() - interval '10 minutes';
do $$ begin assert (select count(*) from public.claim_jobs(10)) = 1, 'recupera bloqueados'; end $$;
-- 6) RLS: usuario autenticado NO miembro no ve nada; miembro activo sí
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e1', 'x@wink.es');
grant usage on schema public to authenticated; grant select, update on all tables in schema public to authenticated;
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', false);
do $$ begin assert (select count(*) from public.messages) = 0, 'inactivo no ve mensajes'; end $$;
-- intento de autoactivarse debe fallar
do $$ begin
  begin update public.profiles set active = true where id = auth.uid(); raise exception 'debió fallar';
  exception when others then if sqlerrm = 'debió fallar' then raise; end if; end;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', false);  -- service role: sin usuario
update public.profiles set active = true where id='00000000-0000-0000-0000-0000000000e1';
set role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', false);
do $$ begin assert (select count(*) from public.messages) = 1, 'activo ve mensajes'; end $$;
do $$ begin assert (select count(*) from public.jobs) = 0, 'agent no ve la cola'; end $$;
reset role;
select 'SQL_BEHAVIOUR_OK';

-- ===================== Fase 2 =====================
-- 7) Recuperación de wamid por biz_opaque_callback_data
insert into public.messages (id, conversation_id, direction, author, type, status)
  values ('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000a1', 'outbound', 'agent', 'text', 'queued');
do $$ begin assert public.apply_message_status('wamid.LOST', 'sent', now(), null, '00000000-0000-0000-0000-00000000000b'), 'recupera por callback'; end $$;
do $$ begin assert (select wa_message_id = 'wamid.LOST' and status = 'sent' from public.messages where id = '00000000-0000-0000-0000-00000000000b'), 'wamid enlazado'; end $$;
-- callback basura no rompe
do $$ begin assert public.apply_message_status('wamid.X', 'sent', now(), null, 'no-es-uuid') = false, 'callback inválido'; end $$;
-- 8) Envío humano: modo humano, agente pausado, no leídos a 0, se asigna
select set_config('request.jwt.claim.sub', '', false);
select public.touch_conversation_outbound('00000000-0000-0000-0000-0000000000a1', now(), 'Hola, soy Marta', true, '00000000-0000-0000-0000-0000000000e1');
do $$ declare c public.conversations; begin
  select * into c from public.conversations where id='00000000-0000-0000-0000-0000000000a1';
  assert c.status='human' and not c.agent_active and c.unread_count=0 and c.assigned_to='00000000-0000-0000-0000-0000000000e1', 'pausa agente';
end $$;
-- 9) client_ref único
insert into public.messages (conversation_id, direction, author, type, status, client_ref) values ('00000000-0000-0000-0000-0000000000a1','outbound','human','text','queued','ui-123');
do $$ begin
  begin insert into public.messages (conversation_id, direction, author, type, status, client_ref) values ('00000000-0000-0000-0000-0000000000a1','outbound','human','text','queued','ui-123'); raise exception 'dup';
  exception when unique_violation then null; end;
end $$;
select 'SQL_PHASE2_OK';

-- ===================== Fase 3 =====================
-- 10) schedule_agent_run: no actúa en modo humano; agrupa ráfagas
update public.conversations set status='human', agent_active=false where id='00000000-0000-0000-0000-0000000000a1';
do $$ begin assert public.schedule_agent_run('00000000-0000-0000-0000-0000000000a1', 6) = false, 'pausado → no programa'; end $$;
update public.conversations set status='bot', agent_active=true where id='00000000-0000-0000-0000-0000000000a1';
do $$ begin assert public.schedule_agent_run('00000000-0000-0000-0000-0000000000a1', 6), 'programa'; end $$;
do $$ begin assert public.schedule_agent_run('00000000-0000-0000-0000-0000000000a1', 20), 'reprograma'; end $$;
do $$ begin
  assert (select count(*) from public.jobs where type='agent_reply') = 1, 'una sola ejecución en cola';
  assert (select run_after > now() + interval '15 seconds' from public.jobs where type='agent_reply'), 'se retrasa con cada mensaje';
end $$;
-- 11) bloqueo por conversación
do $$ begin
  assert public.try_lock_agent('00000000-0000-0000-0000-0000000000a1', 60), 'primer bloqueo';
  assert not public.try_lock_agent('00000000-0000-0000-0000-0000000000a1', 60), 'segundo bloqueo rechazado';
end $$;
select public.release_agent_lock('00000000-0000-0000-0000-0000000000a1');
do $$ begin assert public.try_lock_agent('00000000-0000-0000-0000-0000000000a1', 60), 'bloqueo tras liberar'; end $$;
select 'SQL_PHASE3_OK';
