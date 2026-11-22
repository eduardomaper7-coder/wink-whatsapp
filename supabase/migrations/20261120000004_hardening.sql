-- =====================================================================
-- Endurecimiento (recomendaciones del asesor de seguridad de Supabase)
-- =====================================================================

-- search_path fijo en todas las funciones (evita secuestro por esquemas)
alter function public.set_updated_at()                                                         set search_path = public;
alter function public.conversation_window_open(public.conversations)                           set search_path = public;
alter function public.message_status_rank(public.message_status)                               set search_path = public;
alter function public.claim_jobs(integer, interval)                                            set search_path = public;
alter function public.touch_conversation_inbound(uuid, timestamptz, text, boolean)             set search_path = public;
alter function public.apply_message_status(text, public.message_status, timestamptz, jsonb, text) set search_path = public;
alter function public.touch_conversation_outbound(uuid, timestamptz, text, boolean, uuid)      set search_path = public;
alter function public.schedule_agent_run(uuid, integer)                                        set search_path = public;
alter function public.try_lock_agent(uuid, integer)                                            set search_path = public;
alter function public.release_agent_lock(uuid)                                                 set search_path = public;

-- Funciones de trigger: nadie debe poder llamarlas por la API
revoke execute on function public.handle_new_user()          from public, anon, authenticated;
revoke execute on function public.guard_profile_privileges() from public, anon, authenticated;

-- Helpers de RLS: no para anónimos (los autenticados los necesitan para evaluar las políticas
-- y solo revelan si el propio usuario es miembro/admin)
revoke execute on function public.is_team_member() from public, anon;
revoke execute on function public.is_admin()       from public, anon;
grant  execute on function public.is_team_member() to authenticated, service_role;
grant  execute on function public.is_admin()       to authenticated, service_role;
