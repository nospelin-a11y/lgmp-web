-- =====================================================================
--  LGMP · Fase 5b · Numeración de socios
--
--  Los números 1 a 7 son de la Junta fundadora. El primer socio que entre
--  por el panel (Confirmar pago) recibe el nº 8, aunque a la Junta aún no
--  se le haya puesto número en su ficha. Idempotente.
-- =====================================================================

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
  -- Del 1 al 7, la Junta fundadora.
  select greatest(coalesce(max(x.num_socio), 0), 7) + 1 into nuevo_num from public.socios x;

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

revoke all on function public.confirmar_pago(bigint, date) from public, anon;
grant execute on function public.confirmar_pago(bigint, date) to authenticated;
