-- =====================================================================
--  LGMP · 07 · Eventos online, inscripción sin duplicados y recordatorios
--
--  · eventos: modalidad (presencial / online), imagen para compartir,
--    recordatorios sí/no y el enlace privado de la videollamada.
--  · El enlace de la videollamada NO lo puede leer la clave pública: la
--    web solo recibe las columnas que se enumeran abajo.
--  · inscripciones_evento: a qué evento va cada inscripción (evento_id),
--    un correo solo puede apuntarse una vez a cada evento, y cuándo se
--    mandó cada recordatorio.
--  · Cada 10 minutos, pg_cron llama a la Edge Function `recordatorios`.
--
--  Se puede ejecutar más de una vez sin daño, salvo el bloque final de
--  pg_cron, que lleva la clave y se ejecuta aparte (ver al final).
-- =====================================================================

alter table public.eventos
  add column if not exists modalidad text not null default 'presencial',
  add column if not exists imagen_url text,
  add column if not exists recordatorios boolean not null default false,
  add column if not exists enlace_reunion text;

do $$ begin
  alter table public.eventos add constraint eventos_modalidad_ok
    check (modalidad in ('presencial', 'online'));
exception when duplicate_object then null; end $$;

-- La clave pública (rol anon) solo ve estas columnas. Si se añade una
-- columna nueva que deba salir en la web, hay que sumarla aquí.
revoke select on public.eventos from anon;
grant select (id, creado_en, titulo, fecha, hora, lugar, descripcion, url_inscripcion,
              publicado, slug, cuerpo, modalidad, imagen_url, recordatorios)
  on public.eventos to anon;

alter table public.inscripciones_evento
  add column if not exists evento_id bigint references public.eventos(id) on delete set null,
  add column if not exists recordatorio_dia_en timestamptz,
  add column if not exists recordatorio_hora_en timestamptz;

create unique index if not exists inscripciones_evento_una_por_email
  on public.inscripciones_evento (evento_id, lower(email))
  where evento_id is not null;

-- =====================================================================
--  Programación de los recordatorios (ejecutar una sola vez).
--  Sustituir <CLAVE_RECORDATORIOS> por la misma clave que se guarda en el
--  secreto RECORDATORIOS_CLAVE de la Edge Function. NO subirla a GitHub.
-- =====================================================================
--
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;
-- select vault.create_secret('<CLAVE_RECORDATORIOS>', 'recordatorios_clave');
-- select cron.schedule('lgmp-recordatorios', '*/10 * * * *', $cron$
--   select net.http_post(
--     url     := 'https://cegicdvznbvbemqoftod.supabase.co/functions/v1/recordatorios',
--     headers := jsonb_build_object(
--                  'Content-Type', 'application/json',
--                  'x-clave', (select decrypted_secret from vault.decrypted_secrets
--                              where name = 'recordatorios_clave')),
--     body    := '{}'::jsonb)
-- $cron$);
--
-- Para pararlo:  select cron.unschedule('lgmp-recordatorios');
