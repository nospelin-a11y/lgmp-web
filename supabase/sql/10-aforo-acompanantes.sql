-- =====================================================================
--  10 · Aforo y acompañantes en los eventos (16 nov 2026)
--
--  Para la Reunión de Navidad (23 dic 2026): cada inscrito puede venir
--  con amigos, y el local tiene un aforo de 100 personas.
--
--  · eventos.aforo: personas como máximo (inscritos + acompañantes).
--    Vacío = sin límite.
--  · eventos.acompanantes_max: cuántos amigos puede traer cada inscrito.
--    0 = el formulario no pregunta por acompañantes ni por si es socio.
--  · inscripciones_evento.es_socio: lo que contesta la persona
--    («Sí», «No», «Aún no, pero quiero serlo»). El panel sigue cruzando
--    el correo con el Libro de Registro en la columna «¿Socio?».
--  · inscripciones_evento.acompanantes / acompanantes_nombres.
--  · plazas_ocupadas(evento): suma de inscritos + acompañantes. Pública,
--    porque solo devuelve un número: la página la usa para enseñar
--    «Quedan N plazas» y la Edge Function para no pasarse del aforo.
-- =====================================================================

alter table public.eventos
  add column if not exists aforo integer check (aforo is null or aforo > 0),
  add column if not exists acompanantes_max smallint not null default 0
    check (acompanantes_max between 0 and 10);

-- La web los necesita: se suman a la lista de columnas públicas (07).
grant select (aforo, acompanantes_max) on public.eventos to anon, authenticated;

alter table public.inscripciones_evento
  add column if not exists es_socio text,
  add column if not exists acompanantes smallint not null default 0
    check (acompanantes between 0 and 10),
  add column if not exists acompanantes_nombres text;

create or replace function public.plazas_ocupadas(p_evento bigint)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(1 + acompanantes), 0)::integer
  from public.inscripciones_evento
  where evento_id = p_evento;
$$;

revoke all on function public.plazas_ocupadas(bigint) from public;
grant execute on function public.plazas_ocupadas(bigint) to anon, authenticated, service_role;
