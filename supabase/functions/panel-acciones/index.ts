// =====================================================================
//  LGMP · Edge Function `panel-acciones`
//
//  Los botones del panel /admin/ que, además de cambiar datos, mandan un
//  correo. Solo responde a alguien con sesión iniciada en el panel y que
//  esté en la tabla `junta` (lo comprueba la propia base de datos).
//
//    aprobar          · marca la solicitud como aprobada y manda el correo
//                       de pago con el enlace "Completar mi alta".
//                       Si ya estaba aprobada, solo reenvía el correo.
//    confirmar-pago   · da el nº de socio, pasa la persona al libro y manda
//                       el correo de bienvenida.
//    enviar-correo    · correo a las personas seleccionadas en una lista.
//
//  Variables de entorno (Supabase → Edge Functions → Secrets):
//    RESEND_API_KEY   la misma que usa enviar-formulario
//    REMITENTE_SOCIOS opcional · por defecto hola@lageneracionmejorpreparada.com
//    IBAN             opcional · mientras no esté, sale "IBAN pdte. de confirmación"
//    WHATSAPP_URL     opcional · enlace de invitación al grupo de socios
// =====================================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const RESEND_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const REMITENTE    = Deno.env.get('REMITENTE_SOCIOS') ??
                     'La Generación Mejor Preparada <hola@lageneracionmejorpreparada.com>';
const IBAN         = Deno.env.get('IBAN') || 'IBAN pdte. de confirmación';
const WHATSAPP_URL = Deno.env.get('WHATSAPP_URL') ?? '';

const CORREO_LGMP = 'hola@lageneracionmejorpreparada.com';
const WEB         = 'https://lageneracionmejorpreparada.com';
const TITULAR     = 'Asociación La Generación Mejor Preparada';

// Cuotas anuales. Hasta FIN_DESCUENTO, las altas tienen un 50 % de descuento
// (lo que dice /hazte-socio/). Si cambian, se cambian aquí.
const FIN_DESCUENTO = '2026-12-31';
const CUOTAS: Record<string, { normal: string; descuento: string; texto: string }> = {
  menor30: { normal: '15,00 €', descuento: '7,50 €',  texto: 'menores de 30 años' },
  mayor30: { normal: '30,00 €', descuento: '15,00 €', texto: '30 años o más' },
};

const VENTAJAS = [
  'La comunidad de socios en WhatsApp.',
  'Una especialista en RRHH revisa tu CV y tu perfil de LinkedIn para mejorarlos.',
  'Un especialista en subvenciones te ayuda a localizar las que te interesan.',
  'Eventos y networking con profesionales jóvenes.',
  'Prioridad en las plazas de nuestros eventos.',
  'Bolsa de trabajo.',
  'Webinars y recursos descargables.',
];

const ORIGENES_OK = [
  'https://lageneracionmejorpreparada.com',
  'https://www.lageneracionmejorpreparada.com',
];

// Tablas a las que se puede escribir desde "Enviar correo".
const TABLAS_CORREO: Record<string, string> = {
  socios: 'id,nombre,email',
  altas_socio: 'id,nombre,email',
  inscripciones_evento: 'id,nombre,email',
  contactos: 'id,nombre,email',
};
const MAX_DESTINATARIOS = 100;   // el plan gratuito de Resend manda 100 al día

// ------------------------------------------------------------------ Base

function cors(origen: string | null) {
  return {
    'Access-Control-Allow-Origin': origen && ORIGENES_OK.includes(origen) ? origen : ORIGENES_OK[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function responder(cuerpo: unknown, estado: number, origen: string | null) {
  return new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { ...cors(origen), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

class Fallo extends Error {
  constructor(msg: string, public estado = 400) { super(msg); }
}

/** Petición a la base de datos COMO la persona del panel: se aplican sus permisos. */
async function bd(ruta: string, token: string, apikey: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
    ...init,
    headers: {
      apikey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const cuerpo = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = (cuerpo && (cuerpo.message || cuerpo.error)) || `Error ${r.status}`;
    throw new Fallo(String(msg), r.status === 401 || r.status === 403 ? 403 : 400);
  }
  return cuerpo;
}

const escapar = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const nombrePila = (n: string | null) => (n ?? '').trim().split(/\s+/)[0] || '';

const fechaES = (f: string) => f.split('-').reverse().join('/');

// ---------------------------------------------------------------- Correo

type Bloque =
  | { p: string }                          // párrafo
  | { lista: string[] }                    // viñetas
  | { datos: [string, string][] }          // tabla de datos (IBAN, importe…)
  | { boton: string; url: string };        // botón

function maquetar(titulo: string, bloques: Bloque[], pie: string) {
  const F = 'font-family:Arial,sans-serif;color:#1E2A4A';
  const cuerpo = bloques.map((b) => {
    if ('p' in b) return `<p style="margin:0 0 14px;${F};font-size:15px;line-height:1.6">${escapar(b.p).replace(/\n/g, '<br>')}</p>`;
    if ('lista' in b) return `<ul style="margin:0 0 16px;padding-left:20px;${F};font-size:15px;line-height:1.6">${b.lista.map((l) => `<li style="margin:0 0 6px">${escapar(l)}</li>`).join('')}</ul>`;
    if ('datos' in b) return `<table style="width:100%;border-collapse:collapse;margin:0 0 16px;background:#F4F6FA;border-radius:12px">${b.datos.map(([k, v]) =>
      `<tr><td style="padding:9px 14px;${F};font-size:14px;font-weight:700;white-space:nowrap;vertical-align:top">${escapar(k)}</td><td style="padding:9px 14px;${F};font-size:14px">${escapar(v)}</td></tr>`).join('')}</table>`;
    return `<p style="margin:6px 0 20px"><a href="${escapar(b.url)}" style="display:inline-block;background:#F0503C;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-weight:700;font-size:15px;padding:13px 26px;border-radius:999px">${escapar(b.boton)}</a></p>`;
  }).join('');

  const html =
    '<div style="background:#F4F6FA;padding:28px">' +
      '<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #E6EAF2">' +
        '<div style="background:#182548;padding:22px 26px">' +
          '<p style="margin:0;font-family:Arial,sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#F0503C;font-weight:700">La Generación Mejor Preparada</p>' +
          `<h1 style="margin:6px 0 0;font-family:Arial,sans-serif;font-size:21px;color:#ffffff">${escapar(titulo)}</h1>` +
        '</div>' +
        `<div style="padding:26px 26px 10px">${cuerpo}</div>` +
        `<p style="margin:0;padding:16px 26px;font-family:Arial,sans-serif;font-size:12.5px;line-height:1.5;color:#6B7590;background:#F4F6FA">${pie}</p>` +
      '</div>' +
    '</div>';

  const texto = bloques.map((b) =>
    'p' in b ? b.p
    : 'lista' in b ? b.lista.map((l) => '- ' + l).join('\n')
    : 'datos' in b ? b.datos.map(([k, v]) => `${k}: ${v}`).join('\n')
    : `${b.boton}: ${b.url}`).join('\n\n');

  return { html, texto };
}

const PIE = 'Asociación La Generación Mejor Preparada · Murcia · ' +
  '<a href="https://lageneracionmejorpreparada.com" style="color:#6B7590">lageneracionmejorpreparada.com</a>';

function pieConBaja(email: string) {
  const baja = `mailto:${CORREO_LGMP}?subject=${encodeURIComponent('Baja de comunicaciones')}` +
               `&body=${encodeURIComponent('Quiero dejar de recibir comunicaciones: ' + email)}`;
  return PIE + `<br>¿No quieres recibir más correos como este? <a href="${baja}" style="color:#6B7590">Darme de baja</a>.`;
}

type Correo = { to: string; subject: string; html: string; text: string };

async function mandar(correos: Correo[]) {
  if (!RESEND_KEY) throw new Fallo('Falta la clave de Resend (RESEND_API_KEY).', 500);
  if (!correos.length) return 0;
  const lotes: Correo[][] = [];
  for (let i = 0; i < correos.length; i += 100) lotes.push(correos.slice(i, i + 100));
  let enviados = 0;
  for (const lote of lotes) {
    const r = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(lote.map((c) => ({
        from: REMITENTE, to: [c.to], reply_to: CORREO_LGMP,
        subject: c.subject, html: c.html, text: c.text,
      }))),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error('Resend falló:', r.status, t);
      throw new Fallo(enviados
        ? `Se enviaron ${enviados} correos y luego Resend falló (${r.status}). Revisa Resend → Emails.`
        : `Resend no ha podido enviar el correo (${r.status}). Revisa Resend → Emails.`, 502);
    }
    enviados += lote.length;
  }
  return enviados;
}

// -------------------------------------------------------------- Plantillas

function correoPago(s: { nombre: string; email: string; tramo: string | null; token: string }): Correo {
  const cuota = CUOTAS[s.tramo ?? ''] ?? CUOTAS.mayor30;
  const hoy = new Date().toISOString().slice(0, 10);
  const importe = hoy <= FIN_DESCUENTO ? cuota.descuento : cuota.normal;
  const enlace = `${WEB}/completar-alta/?t=${s.token}`;
  const { html, texto } = maquetar('Tu solicitud está aprobada', [
    { p: `Hola, ${nombrePila(s.nombre)}:` },
    { p: 'La Junta Directiva ha aprobado tu solicitud de alta en la Asociación La Generación Mejor Preparada. Te quedan dos pasos:' },
    { p: '1. Completa tus datos. Es un minuto: tu DNI y una casilla.' },
    { boton: 'Completar mi alta', url: enlace },
    { p: '2. Paga la cuota anual por transferencia:' },
    { datos: [
      ['Importe', `${importe} (cuota anual, ${cuota.texto})`],
      ['Titular', TITULAR],
      ['IBAN', IBAN],
      ['Concepto', `Cuota LGMP ${s.nombre}`],
    ] },
    { p: 'En cuanto recibamos el pago te mandamos tu número de socio y la invitación a la comunidad.' },
    { p: 'Si tienes cualquier duda, responde a este correo.\nUn abrazo,\nLa Junta de LGMP' },
  ], PIE);
  return { to: s.email, subject: 'Tu solicitud está aprobada: te quedan dos pasos', html, text: texto };
}

function correoBienvenida(s: { nombre: string; email: string; num_socio: number; renovacion: string }): Correo {
  const num = String(s.num_socio).padStart(3, '0');
  const bloques: Bloque[] = [
    { p: `Hola, ${nombrePila(s.nombre)}:` },
    { p: 'Hemos recibido tu cuota. Ya formas parte de la Asociación La Generación Mejor Preparada.' },
    { datos: [['Nº de socio', num], ['Tu cuota se renueva el', fechaES(s.renovacion)]] },
    { p: 'Esto es lo que tienes a tu alcance desde hoy:' },
    { lista: VENTAJAS },
  ];
  if (WHATSAPP_URL) {
    bloques.push({ p: 'Empieza por aquí: únete al grupo de socios.' });
    bloques.push({ boton: 'Unirme al grupo de WhatsApp', url: WHATSAPP_URL });
  } else {
    bloques.push({ p: 'En los próximos días te mandamos la invitación al grupo de socios en WhatsApp.' });
  }
  bloques.push({ p: 'Gracias por sumarte. Nos vemos pronto.\nLa Junta de LGMP' });
  const { html, texto } = maquetar('Bienvenido a LGMP', bloques, PIE);
  return { to: s.email, subject: `Ya formas parte de LGMP · Socio nº ${num}`, html, text: texto };
}

function correoLibre(nombre: string | null, email: string, asunto: string, cuerpo: string): Correo {
  const texto = cuerpo.replace(/\{nombre\}/g, nombrePila(nombre) || 'hola').replace(/\{iban\}/g, IBAN);
  const bloques: Bloque[] = texto.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => ({ p }));
  const { html, texto: plano } = maquetar(asunto, bloques, pieConBaja(email));
  return { to: email, subject: asunto, html, text: plano };
}

// ----------------------------------------------------------------- Handler

Deno.serve(async (req) => {
  const origen = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(origen) });
  if (req.method !== 'POST') return responder({ ok: false, error: 'Método no permitido.' }, 405, origen);

  const token  = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const apikey = req.headers.get('apikey') ?? '';
  if (!token || !apikey) return responder({ ok: false, error: 'Inicia sesión en el panel.' }, 401, origen);

  try {
    // ¿Es de la junta? Lo decide la base de datos con el usuario que llama.
    const esJunta = await bd('rpc/es_junta', token, apikey, { method: 'POST', body: '{}' });
    if (esJunta !== true) throw new Fallo('Esta cuenta no tiene acceso al panel.', 403);

    const cuerpo = await req.json().catch(() => ({}));
    const accion = String(cuerpo.accion ?? '');

    if (accion === 'aprobar') {
      const filas = await bd('rpc/aprobar_solicitud', token, apikey, {
        method: 'POST', body: JSON.stringify({ p_id: Number(cuerpo.id) }),
      });
      const s = filas?.[0];
      if (!s) throw new Fallo('No se ha encontrado la solicitud.');
      // Honoríficos, corporativos e institucionales: se gestionan a mano.
      if (s.tipo !== 'ordinario') {
        return responder({ ok: true, correo: false,
          mensaje: 'Aprobada. Al no ser socio ordinario, no se ha enviado correo de pago: gestionadlo a mano.' }, 200, origen);
      }
      await mandar([correoPago(s)]);
      return responder({ ok: true, correo: true, mensaje: `Aprobada. Correo de pago enviado a ${s.email}.` }, 200, origen);
    }

    if (accion === 'confirmar-pago') {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(cuerpo.fecha ?? '')) ? cuerpo.fecha
                  : new Date().toISOString().slice(0, 10);
      const filas = await bd('rpc/confirmar_pago', token, apikey, {
        method: 'POST', body: JSON.stringify({ p_id: Number(cuerpo.id), p_fecha: fecha }),
      });
      const s = filas?.[0];
      if (!s) throw new Fallo('No se ha podido dar de alta.');
      let aviso = '';
      try {
        await mandar([correoBienvenida(s)]);
      } catch (e) {
        // El alta ya está hecha: no se deshace por un fallo del correo.
        aviso = ' Ojo: el correo de bienvenida no ha salido (' + (e as Error).message + ').';
      }
      return responder({ ok: true, num_socio: s.num_socio,
        mensaje: `Alta hecha: socio nº ${String(s.num_socio).padStart(3, '0')}.` +
                 (aviso || ` Correo de bienvenida enviado a ${s.email}.`) }, 200, origen);
    }

    if (accion === 'enviar-correo') {
      const tabla = String(cuerpo.tabla ?? '');
      const columnas = TABLAS_CORREO[tabla];
      if (!columnas) throw new Fallo('Desde esta lista no se pueden enviar correos.');
      const ids = (Array.isArray(cuerpo.ids) ? cuerpo.ids : []).map(Number).filter(Number.isFinite);
      if (!ids.length) throw new Fallo('No hay nadie seleccionado.');
      if (ids.length > MAX_DESTINATARIOS) throw new Fallo(`Máximo ${MAX_DESTINATARIOS} personas por envío.`);
      const asunto = String(cuerpo.asunto ?? '').trim().slice(0, 150);
      const texto  = String(cuerpo.cuerpo ?? '').replace(/\r\n/g, '\n').trim().slice(0, 8000);
      if (!asunto) throw new Fallo('Falta el asunto.');
      if (!texto) throw new Fallo('Falta el texto del correo.');

      const filas: { id: number; nombre: string | null; email: string | null }[] =
        await bd(`${tabla}?select=${columnas}&id=in.(${ids.join(',')})`, token, apikey);
      const vistos = new Set<string>();
      const correos = filas
        .filter((f) => f.email && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(f.email))
        .filter((f) => { const k = f.email!.toLowerCase(); if (vistos.has(k)) return false; vistos.add(k); return true; })
        .map((f) => correoLibre(f.nombre, f.email!, asunto, texto));
      const n = await mandar(correos);
      return responder({ ok: true, enviados: n,
        mensaje: `${n} correo${n === 1 ? '' : 's'} enviado${n === 1 ? '' : 's'}.` }, 200, origen);
    }

    throw new Fallo('Acción no reconocida.');
  } catch (e) {
    const estado = e instanceof Fallo ? e.estado : 500;
    if (!(e instanceof Fallo)) console.error(e);
    return responder({ ok: false, error: e instanceof Fallo ? e.message : 'Error inesperado. Mira los logs de la función.' }, estado, origen);
  }
});
