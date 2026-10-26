-- =====================================================================
--  LGMP · 09 · Inscritos a eventos → invitados de Google Calendar
--
--  · eventos.google_evento_id: id del evento en el Google Calendar de la
--    cuenta conectada. Vacío = ese evento no invita a nadie. No es público
--    (no está en el grant de columnas de 07-eventos-online.sql).
--  · inscripciones_evento.google_estado: null (sin intentar) · ok · error.
--    Los errores los reintenta la función `recordatorios` cada 10 minutos.
--  · integraciones: guarda el permiso (refresh token) de la cuenta de
--    Google. Seguridad por filas activada y SIN reglas: solo la clave
--    secreta (las Edge Functions) puede leerla. Ni la web ni el panel.
-- =====================================================================

alter table public.eventos
  add column if not exists google_evento_id text;

alter table public.inscripciones_evento
  add column if not exists google_estado text,
  add column if not exists google_detalle text,
  add column if not exists google_en timestamptz;

do $$ begin
  alter table public.inscripciones_evento add constraint inscripciones_google_estado_ok
    check (google_estado in ('ok', 'error'));
exception when duplicate_object then null; end $$;

create table if not exists public.integraciones (
  nombre         text primary key,
  valor          text not null,
  cuenta         text,
  actualizado_en timestamptz not null default now()
);
alter table public.integraciones enable row level security;
revoke all on public.integraciones from anon, authenticated;
