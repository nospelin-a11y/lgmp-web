-- =====================================================================
--  LGMP · 08 · Inscritos a eventos → MailerLite
--
--  · eventos.mailerlite_grupo: id del grupo de MailerLite del evento.
--    Vacío = ese evento no se manda a MailerLite. No es público (no está
--    en el grant de columnas de 07-eventos-online.sql).
--  · inscripciones_evento.mailerlite_estado:
--      null   todavía no se ha intentado
--      ok     dada de alta / actualizada
--      baja   estaba dada de baja, rebotada o como spam: NO se toca
--      error  falló; la función `recordatorios` lo reintenta cada 10 min
--    mailerlite_detalle guarda el motivo y mailerlite_en, la última vez.
--
--  Regla de consentimiento: ver supabase/functions/_shared/mailerlite.ts.
-- =====================================================================

alter table public.eventos
  add column if not exists mailerlite_grupo text;

alter table public.inscripciones_evento
  add column if not exists mailerlite_estado text,
  add column if not exists mailerlite_detalle text,
  add column if not exists mailerlite_en timestamptz;

do $$ begin
  alter table public.inscripciones_evento add constraint inscripciones_mailerlite_estado_ok
    check (mailerlite_estado in ('ok', 'baja', 'error'));
exception when duplicate_object then null; end $$;

-- Grupos creados el 27 sep 2026
update public.eventos set mailerlite_grupo = '199780751457125864' where id = 3;  -- ASOC-Despuesdelacarreraque-21_10_26
update public.eventos set mailerlite_grupo = '199780752637822054' where id = 6;  -- WEBINAR_recursoshumanossinfiltros_12-11-26
