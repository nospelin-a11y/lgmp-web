// =====================================================================
//  LGMP · Edge Function `recordatorios`
//
//  La llama la base de datos (pg_cron) cada 10 minutos. Para cada evento
//  publicado con "Mandar recordatorios" marcado:
//
//    · Día antes:  desde 24 h antes del inicio hasta 3 h antes.
//    · Hora antes: desde 1 h antes hasta que termina el evento.
//
//  Cada inscripción guarda cuándo recibió cada recordatorio
//  (`recordatorio_dia_en`, `recordatorio_hora_en`), así que nadie recibe
//  el mismo dos veces aunque la función se ejecute muchas veces. Si Resend
//  falla, no se marca y se reintenta en la siguiente vuelta.
//
//  Quien se apunta tarde (menos de 3 h antes) no recibe el del día antes,
//  pero sí el de la hora antes, que lleva el enlace.
//
//  Además, en cada vuelta reintenta las altas en MailerLite que fallaron o
//  que no llegaron a hacerse (ver _shared/mailerlite.ts), solo de eventos
//  que todavía no han pasado.
//
//  Prueba: POST con {"prueba":"correo@ejemplo.com","evento_id":7} manda
//  los dos recordatorios de ese evento solo a ese correo, sin marcar nada.
//
//  Variables de entorno (Supabase → Edge Functions → Secrets):
//    RECORDATORIOS_CLAVE  secreta · la misma que guarda pg_cron en Vault
//    RESEND_API_KEY       la de siempre
//    REMITENTE_SOCIOS     opcional · por defecto hola@lageneracionmejorpreparada.com
//    CLAVE_SECRETA        la clave secreta del proyecto
// =====================================================================

import { correoRecordatorio, inicioFin, type Evento, CORREO_LGMP } from '../_shared/eventos.ts';
import { altaEnMailerLite, mailerLiteConfigurado } from '../_shared/mailerlite.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SECRETA      = Deno.env.get('CLAVE_SECRETA') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CLAVE        = Deno.env.get('RECORDATORIOS_CLAVE') ?? '';
const RESEND_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const REMITENTE    = Deno.env.get('REMITENTE_SOCIOS') ??
                     'La Generación Mejor Preparada <hola@lageneracionmejorpreparada.com>';

const H = 3600000;
const LOTE = 50;   // correos por llamada a Resend (su máximo es 100)

type Inscrito = { id: number; nombre: string | null; email: string | null };

function json(cuerpo: unknown, estado = 200) {
  return new Response(JSON.stringify(cuerpo), {
    status: estado, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function db(ruta: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
    ...init,
    headers: {
      apikey: SECRETA, Authorization: `Bearer ${SECRETA}`,
      'Content-Type': 'application/json', ...(init.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`${ruta} (${r.status}): ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const COLS_EVENTO = 'id,titulo,fecha,hora,lugar,modalidad,slug,publicado,recordatorios,enlace_reunion';

/** Manda un lote por la API de envíos en bloque de Resend. */
async function mandar(ev: Evento, gente: Inscrito[], cual: 'dia' | 'hora', idem: string) {
  const correos = gente.map((p) => {
    const c = correoRecordatorio(ev, String(p.nombre ?? '').split(' ')[0] || 'hola', cual);
    return { from: REMITENTE, to: [String(p.email)], reply_to: CORREO_LGMP,
             subject: c.asunto, html: c.html, text: c.texto };
  });
  const r = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json',
      // Si esta misma llamada se repite (reintento), Resend no duplica.
      'Idempotency-Key': idem,
    },
    body: JSON.stringify(correos),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

async function recordar(ev: Evento, cual: 'dia' | 'hora') {
  const col = cual === 'dia' ? 'recordatorio_dia_en' : 'recordatorio_hora_en';
  const gente: Inscrito[] = (await db(
    `inscripciones_evento?select=id,nombre,email&evento_id=eq.${ev.id}&${col}=is.null&order=id`))
    .filter((p: Inscrito) => p.email);
  let enviados = 0;
  for (let i = 0; i < gente.length; i += LOTE) {
    const lote = gente.slice(i, i + LOTE);
    await mandar(ev, lote, cual, `lgmp-${ev.id}-${cual}-${lote[0].id}-${lote[lote.length - 1].id}`);
    await db(`inscripciones_evento?id=in.(${lote.map((p) => p.id).join(',')})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ [col]: new Date().toISOString() }),
    });
    enviados += lote.length;
  }
  return enviados;
}

/** Reintenta altas en MailerLite pendientes o fallidas (máx. 25 por vuelta). */
async function reintentarMailerLite(): Promise<number> {
  if (!mailerLiteConfigurado()) return 0;          // sin clave no tiene sentido llamar
  const hace5min = new Date(Date.now() - 5 * 60000).toISOString();
  const ayer = new Date(Date.now() - 24 * H).toISOString().slice(0, 10);
  const filas: {
    id: number; nombre: string | null; email: string | null; perfil: string | null;
    acepta_comunicaciones: boolean | null; eventos: { mailerlite_grupo: string | null };
  }[] = await db('inscripciones_evento?select=id,nombre,email,perfil,acepta_comunicaciones,' +
    'eventos!inner(mailerlite_grupo,fecha)' +
    '&or=(mailerlite_estado.is.null,mailerlite_estado.eq.error)' +
    `&creado_en=lt.${hace5min}&eventos.mailerlite_grupo=not.is.null&eventos.fecha=gte.${ayer}` +
    '&order=id&limit=25');
  let hechas = 0;
  for (const f of filas) {
    if (!f.email || !f.eventos?.mailerlite_grupo) continue;
    const res = await altaEnMailerLite({
      email: f.email, nombre: f.nombre, perfil: f.perfil,
      grupoEvento: f.eventos.mailerlite_grupo,
      aceptaComunicaciones: f.acepta_comunicaciones === true,
    });
    await db(`inscripciones_evento?id=eq.${f.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ mailerlite_estado: res.estado, mailerlite_detalle: res.detalle,
                             mailerlite_en: new Date().toISOString() }),
    });
    if (res.estado !== 'error') hechas++;
  }
  return hechas;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: false }, 405);
  if (!CLAVE || req.headers.get('x-clave') !== CLAVE) return json({ ok: false, error: 'No autorizado' }, 401);
  if (!RESEND_KEY) return json({ ok: false, error: 'Falta RESEND_API_KEY' }, 500);

  const cuerpo = await req.json().catch(() => ({}));

  // ---- Modo prueba: los dos recordatorios a un solo correo ----
  if (cuerpo?.prueba) {
    const [ev]: Evento[] = await db(`eventos?select=${COLS_EVENTO}&id=eq.${Number(cuerpo.evento_id)}`);
    if (!ev) return json({ ok: false, error: 'Evento no encontrado' }, 404);
    const yo = [{ id: 0, nombre: String(cuerpo.nombre ?? 'Prueba'), email: String(cuerpo.prueba) }];
    await mandar(ev, yo, 'dia', crypto.randomUUID());
    await mandar(ev, yo, 'hora', crypto.randomUUID());
    return json({ ok: true, prueba: cuerpo.prueba });
  }

  // ---- Vuelta normal ----
  const ahora = Date.now();
  const hoy = new Date(ahora - 24 * H).toISOString().slice(0, 10);
  const hasta = new Date(ahora + 48 * H).toISOString().slice(0, 10);
  const eventos: Evento[] = await db(`eventos?select=${COLS_EVENTO}` +
    `&publicado=eq.true&recordatorios=eq.true&fecha=gte.${hoy}&fecha=lte.${hasta}`);

  const hecho: Record<string, number> = {};
  const errores: string[] = [];
  try {
    const n = await reintentarMailerLite();
    if (n) hecho.mailerlite = n;
  } catch (e) {
    console.error('Reintento MailerLite:', e);
    errores.push(`mailerlite: ${e instanceof Error ? e.message : e}`);
  }
  for (const ev of eventos) {
    const t = inicioFin(ev);
    if (!t) continue;                                   // sin hora no se sabe cuándo avisar
    const ini = t.inicio.getTime(), fin = t.fin.getTime();
    try {
      if (ahora >= ini - 24 * H && ahora < ini - 3 * H) hecho[`${ev.id}-dia`] = await recordar(ev, 'dia');
      if (ahora >= ini - H && ahora < fin)              hecho[`${ev.id}-hora`] = await recordar(ev, 'hora');
    } catch (e) {
      console.error(`Evento ${ev.id}:`, e);
      errores.push(`${ev.id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return json({ ok: errores.length === 0, eventos: eventos.length, enviados: hecho, errores });
});
