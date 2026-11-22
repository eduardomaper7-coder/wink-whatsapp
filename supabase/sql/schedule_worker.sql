-- =====================================================================
-- Programa el worker de la cola cada minuto desde Supabase (pg_cron + pg_net).
-- Ejecutar UNA VEZ en el SQL Editor de Supabase tras desplegar en Vercel.
-- Requiere activar las extensiones pg_cron y pg_net (Database → Extensions).
--
-- 1) Guarda la URL y el secreto en Vault (no quedan en texto plano en cron.job):
--      select vault.create_secret('https://TU-DOMINIO.vercel.app/api/jobs/run', 'worker_url');
--      select vault.create_secret('EL_MISMO_VALOR_QUE_CRON_SECRET', 'cron_secret');
-- 2) Ejecuta lo siguiente:
-- =====================================================================
select cron.schedule(
  'wink-jobs-worker',
  '* * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'worker_url'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'Content-Type',  'application/json'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- Limpieza semanal de trabajos terminados y webhooks crudos antiguos (minimización de datos)
select cron.schedule(
  'wink-jobs-cleanup',
  '17 3 * * 0',
  $$
  delete from public.jobs where status = 'done' and updated_at < now() - interval '14 days';
  delete from public.wa_webhook_events where processed_at is not null and received_at < now() - interval '30 days';
  $$
);

-- Para desactivarlo:  select cron.unschedule('wink-jobs-worker');
