-- =====================================================================
--  LGMP · Fase 5 · Registro de socios
--
--  Pegar entero en Supabase → SQL Editor → Run. Es idempotente: se puede
--  ejecutar más de una vez sin romper nada.
--
--  NO BORRA NINGÚN DATO. Solo añade columnas, funciones y permisos.
--  Las solicitudes que ya había en `altas_socio` se quedan tal cual.
--
--  Qué hace:
--    1. `altas_socio` pasa a ser la bandeja de SOLICITUDES
--       (pendiente → aprobado → pagado · o rechazado).
--    2. `socios` pasa a ser el LIBRO DE REGISTRO DE SOCIOS, con nº de socio.
--    3. Protege los datos personales de `socios`: el público solo puede
--       leer las columnas de la tarjeta de la web.
--    4. Funciones que usan los botones del panel: aprobar y confirmar pago.
--    5. Funciones del formulario "Completar mi alta" (DNI y declaración).
--    6. Carpeta pública para las fotos de los socios.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. SOLICITUDES  (tabla altas_socio)
-- ---------------------------------------------------------------------

alter table public.altas_socio add column if not exists fecha_nacimiento date;
alter table public.altas_socio add column if not exists tipo             text not null default 'ordinario';
alter table public.altas_socio add column if not exists aprobado_junta   boolean not null default false;
alter table public.altas_socio add column if not exists aprobado_en      timestamptz;
alter table public.altas_socio add column if not exists token            uuid not null default gen_random_uuid();
alter table public.altas_socio add column if not exists dni              text;
alter table public.altas_socio add column if not exists acepta_estatutos boolean not null default false;
alter table public.altas_socio add column if not exists acepta_imagen    boolean not null default false;
alter table public.altas_socio add column if not exists completado_en    timestamptz;
alter table public.altas_socio add column if not exists pagado_en        date;
alter table public.altas_socio add column if not exists socio_id         bigint;
alter table public.altas_socio add column if not exists notas_internas   text;

create unique index if not exists altas_socio_token on public.altas_socio (token);

-- El antiguo estado "aceptado" pasa a llamarse "aprobado". No se pierde nada.
update public.altas_socio
   set estado = 'aprobado', aprobado_junta = true, aprobado_en = coalesce(aprobado_en, now())
 where estado = 'aceptado';


-- ---------------------------------------------------------------------
-- 2. LIBRO DE REGISTRO DE SOCIOS  (tabla socios)
--    Las 7 fichas de la junta que ya existen se conservan.
-- ---------------------------------------------------------------------

alter table public.socios add column if not exists num_socio         int;
alter table public.socios add column if not exists tipo              text not null default 'ordinario';
alter table public.socios add column if not exists email             text;
alter table public.socios add column if not exists telefono          text;
alter table public.socios add column if not exists dni               text;
alter table public.socios add column if not exists fecha_nacimiento  date;
alter table public.socios add column if not exists fecha_inscripcion date;
alter table public.socios add column if not exists municipio         text;
alter table public.socios add column if not exists tramo             text;
alter table public.socios add column if not exists situacion         text;
alter table public.socios add column if not exists estudios          text;
alter table public.socios add column if not exists como_conocio      text;
alter table public.socios add column if not exists expectativas      text;
alter table public.socios add column if not exists acepta_comunicaciones boolean not null default false;
alter table public.socios add column if not exists acepta_imagen     boolean not null default false;
alter table public.socios add column if not exists aprobado_junta    boolean not null default true;
alter table public.socios add column if not exists fecha_pago        date;
alter table public.socios add column if not exists renovacion        date;
alter table public.socios add column if not exists baja_en           date;
alter table public.socios add column if not exists motivo_baja       text;
alter table public.socios add column if not exists solicitud_id      bigint;
alter table public.socios add column if not exists notas_internas    text;

create unique index if not exists socios_num_socio on public.socios (num_socio) where num_socio is not null;

-- Quien ya sale en la web lo hace con consentimiento por escrito (así lo
-- exigía el panel). Se deja constancia para que la regla de abajo se cumpla.
update public.socios set acepta_imagen = true where publicar and not acepta_imagen;

-- Nadie puede salir en la web sin permiso de imagen.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'socios_web_con_permiso') then
    alter table public.socios add constraint socios_web_con_permiso
      check (not publicar or acepta_imagen);
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 3. PROTEGER LOS DATOS PERSONALES DE `socios`
--    La política pública deja leer las filas marcadas para la web. Con
--    esto, además, solo se pueden leer las columnas de la tarjeta: nunca
--    email, teléfono, DNI ni fecha de nacimiento.
-- ---------------------------------------------------------------------

revoke select on public.socios from anon;
grant select (id, nombre, cargo_asociacion, cargo_profesional, empresa,
              linkedin, twitter, foto_url, es_junta, publicar, orden)
  on public.socios to anon;


-- ---------------------------------------------------------------------
-- 4. BOTONES DEL PANEL
--    Solo los puede usar alguien que esté en la tabla `junta`.
-- ---------------------------------------------------------------------

-- 4.1 Aprobar. Si ya estaba aprobada, no cambia nada y devuelve los datos
--     (así sirve también para reenviar el correo de pago).
create or replace function public.aprobar_solicitud(p_id bigint)
returns table (id bigint, nombre text, email text, tramo text, tipo text, token uuid, estado text)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.es_junta() then raise exception 'Sin permiso'; end if;

  update public.altas_socio a
     set estado = 'aprobado', aprobado_junta = true, aprobado_en = coalesce(a.aprobado_en, now())
   where a.id = p_id and a.estado in ('pendiente', 'aprobado');

  if not found then raise exception 'La solicitud no existe o ya no está en curso'; end if;

  return query
    select a.id, a.nombre, a.email, a.tramo, a.tipo, a.token, a.estado
      from public.altas_socio a where a.id = p_id;
end $$;

-- 4.2 Confirmar pago: da el número de socio y pasa la persona al libro.
create or replace function public.confirmar_pago(p_id bigint, p_fecha date default current_date)
returns table (socio_id bigint, num_socio int, nombre text, email text, renovacion date)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare s public.altas_socio; nuevo_id bigint; nuevo_num int;
begin
  if not public.es_junta() then raise exception 'Sin permiso'; end if;

  select * into s from public.altas_socio where id = p_id for update;
  if not found then raise exception 'La solicitud no existe'; end if;
  if s.estado <> 'aprobado' then raise exception 'Primero hay que aprobar la solicitud'; end if;

  -- Números correlativos, sin huecos por dos clics a la vez.
  lock table public.socios in share row exclusive mode;
  select coalesce(max(x.num_socio), 0) + 1 into nuevo_num from public.socios x;

  insert into public.socios (
    nombre, num_socio, tipo, email, telefono, dni, fecha_nacimiento, fecha_inscripcion,
    municipio, tramo, situacion, estudios, linkedin, como_conocio, expectativas,
    acepta_comunicaciones, acepta_imagen, aprobado_junta, fecha_pago, renovacion,
    solicitud_id, es_junta, publicar, activo, orden)
  values (
    s.nombre, nuevo_num, s.tipo, s.email, s.telefono, s.dni, s.fecha_nacimiento, p_fecha,
    s.municipio, s.tramo, s.situacion, s.sector, s.linkedin, s.como_conocio, s.expectativas,
    s.acepta_comunicaciones, s.acepta_imagen, true, p_fecha, (p_fecha + interval '12 months')::date,
    s.id, false, false, true, 100)
  returning id into nuevo_id;

  update public.altas_socio
     set estado = 'pagado', pagado_en = p_fecha, socio_id = nuevo_id
   where id = p_id;

  return query
    select x.id, x.num_socio, x.nombre, x.email, x.renovacion
      from public.socios x where x.id = nuevo_id;
end $$;

revoke all on function public.aprobar_solicitud(bigint)    from public, anon;
revoke all on function public.confirmar_pago(bigint, date) from public, anon;
grant execute on function public.aprobar_solicitud(bigint)    to authenticated;
grant execute on function public.confirmar_pago(bigint, date) to authenticated;


-- ---------------------------------------------------------------------
-- 5. FORMULARIO "COMPLETAR MI ALTA"
--    Solo los llama la Edge Function (service_role). El enlace del correo
--    lleva un código único e imposible de adivinar.
-- ---------------------------------------------------------------------

create or replace function public.consultar_alta(p_token uuid)
returns table (nombre text, estado text, completado boolean)
language sql security definer stable set search_path = public
as $$
  select a.nombre, a.estado, a.completado_en is not null
    from public.altas_socio a
   where a.token = p_token and a.estado in ('aprobado', 'pagado')
$$;

create or replace function public.completar_alta(p_token uuid, p_dni text, p_imagen boolean)
returns table (id bigint, nombre text)
language plpgsql security definer set search_path = public
as $$
#variable_conflict use_column
declare s public.altas_socio;
begin
  update public.altas_socio a
     set dni = p_dni, acepta_estatutos = true, acepta_imagen = p_imagen, completado_en = now()
   where a.token = p_token and a.estado in ('aprobado', 'pagado')
  returning * into s;

  if not found then raise exception 'Enlace no válido'; end if;

  -- Si ya había pagado, se copia también a su ficha del libro.
  if s.socio_id is not null then
    update public.socios x
       set dni = p_dni, acepta_imagen = p_imagen,
           publicar = case when p_imagen then x.publicar else false end
     where x.id = s.socio_id;
  end if;

  return query select s.id, s.nombre;
end $$;

revoke all on function public.consultar_alta(uuid)                from public, anon, authenticated;
revoke all on function public.completar_alta(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.consultar_alta(uuid)                to service_role;
grant execute on function public.completar_alta(uuid, text, boolean) to service_role;


-- ---------------------------------------------------------------------
-- 6. FOTOS DE LOS SOCIOS
--    Carpeta pública (la foto se ve en la web); solo la junta sube o borra.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('fotos-socios', 'fotos-socios', true)
on conflict (id) do nothing;

drop policy if exists fotos_socios_junta_sube   on storage.objects;
drop policy if exists fotos_socios_junta_cambia on storage.objects;
drop policy if exists fotos_socios_junta_borra  on storage.objects;

create policy fotos_socios_junta_sube on storage.objects
  for insert to authenticated with check (bucket_id = 'fotos-socios' and public.es_junta());
create policy fotos_socios_junta_cambia on storage.objects
  for update to authenticated using (bucket_id = 'fotos-socios' and public.es_junta());
create policy fotos_socios_junta_borra on storage.objects
  for delete to authenticated using (bucket_id = 'fotos-socios' and public.es_junta());


-- ---------------------------------------------------------------------
-- 7. Comprobación final: lo que verás en pantalla al terminar.
-- ---------------------------------------------------------------------

select 'Solicitudes' as que, estado as detalle, count(*)::text as total
  from public.altas_socio group by estado
union all
select 'Socios en el libro', case when activo then 'activos' else 'de baja' end, count(*)::text
  from public.socios group by activo
order by 1, 2;
