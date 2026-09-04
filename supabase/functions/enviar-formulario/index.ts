// =====================================================================
//  LGMP · Edge Function `enviar-formulario`
//
//  Única puerta de entrada de los formularios de la web. Valida en
//  servidor, inserta con la service_role (se salta RLS) y avisa a la
//  junta por Resend. La clave anon del navegador NO escribe en la base
//  de datos: por eso todo pasa por aquí.
//
//  Variables de entorno (Supabase → Edge Functions → Secrets):
//    SUPABASE_URL     automática
//    CLAVE_SECRETA    la clave secreta del proyecto (sb_secret_…). Se usa esta
//                     si está puesta; si no, la SUPABASE_SERVICE_ROLE_KEY que
//                     inyecta Supabase. Ponerla evita sorpresas en proyectos
//                     con el formato nuevo de claves, donde las antiguas
//                     pueden estar desactivadas.
//    RESEND_API_KEY   secreta, la de Resend con permiso de solo envío
//    AVISOS_PARA      opcional · destinatarios separados por comas
//    REMITENTE        opcional · "Nombre <correo@dominio>" verificado en Resend
//    LIMITE_POR_HORA  opcional · envíos por IP y hora (por defecto 5)
// =====================================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE = Deno.env.get('CLAVE_SECRETA') ??
                     Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Claves públicas admitidas. Ojo: esto NO es seguridad. La clave pública viaja
// en el HTML de una web abierta, así que cualquiera la tiene; solo sirve para
// filtrar el ruido de fondo de internet. Lo que de verdad protege es el
// honeypot, el límite por IP y que la escritura pase siempre por aquí.
const CLAVES_PUBLICAS = [
  Deno.env.get('CLAVE_PUBLICA'),
  Deno.env.get('SUPABASE_PUBLISHABLE_KEY'),
  Deno.env.get('SUPABASE_ANON_KEY'),
].filter((c): c is string => !!c);

const RESEND_KEY   = Deno.env.get('RESEND_API_KEY') ?? '';
const AVISOS_PARA  = (Deno.env.get('AVISOS_PARA') ?? 'hola@lageneracionmejorpreparada.com')
                       .split(',').map((s) => s.trim()).filter(Boolean);
const REMITENTE    = Deno.env.get('REMITENTE') ?? 'Web LGMP <web@lageneracionmejorpreparada.com>';
const LIMITE_HORA  = Number(Deno.env.get('LIMITE_POR_HORA') ?? '5');

const ORIGENES_OK = [
  'https://lageneracionmejorpreparada.com',
  'https://www.lageneracionmejorpreparada.com',
];

const CORREO_LGMP = 'hola@lageneracionmejorpreparada.com';

// ---------------------------------------------------------------- CORS
function cabecerasCors(origen: string | null) {
  const permitido = origen && ORIGENES_OK.includes(origen) ? origen : ORIGENES_OK[0];
  return {
    'Access-Control-Allow-Origin': permitido,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function responder(cuerpo: unknown, estado: number, origen: string | null) {
  return new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { ...cabecerasCors(origen), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ------------------------------------------------------------ Utilidades

/** Recorta, normaliza espacios y limita longitud. Devuelve null si queda vacío. */
function txt(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return s.length ? s : null;
}

/** Igual que txt() pero conserva los saltos de línea (campos de texto largo). */
function parrafo(v: unknown, max = 4000): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, max);
  return s.length ? s : null;
}

function bool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'Sí' || v === 'si' || v === 'on' || v === 1;
}

function emailValido(v: string | null): v is string {
  return !!v && v.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v);
}

function telefonoValido(v: string | null): v is string {
  return !!v && v.replace(/\D/g, '').length >= 9;
}

function opcion(v: unknown, permitidas: string[]): string | null {
  const s = txt(v, 60);
  return s && permitidas.includes(s) ? s : null;
}

function escapar(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function claveAdmitida(clave: string): boolean {
  if (!clave) return false;
  if (CLAVES_PUBLICAS.includes(clave)) return true;
  // Formato nuevo de claves: la publishable es pública y cambia al rotarla,
  // así que no se compara contra una lista fija.
  return /^sb_publishable_[A-Za-z0-9_-]+$/.test(clave);
}

class ErrorValidacion extends Error {}

function exigir(cond: unknown, mensaje: string): asserts cond {
  if (!cond) throw new ErrorValidacion(mensaje);
}

// --------------------------------------------------------- Base de datos

async function insertar(tabla: string, fila: Record<string, unknown>, params = '') {
  const upsert = params.includes('on_conflict');
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${tabla}${params}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      Prefer: upsert ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
    },
    body: JSON.stringify(fila),
  });
  if (!r.ok) throw new Error(`Insert en ${tabla} falló (${r.status}): ${await r.text()}`);
}

/**
 * Límite por IP. La IP no se guarda: se almacena un hash con sal diaria,
 * suficiente para contar y sin valor identificativo pasadas 24 h.
 * Si la tabla `envios_log` todavía no existe, no limita y sigue adelante.
 */
async function limiteSuperado(ip: string, tipo: string): Promise<boolean> {
  if (!ip || LIMITE_HORA <= 0) return false;

  const dia = new Date().toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}·${dia}·lgmp`));
  const hash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const desde = new Date(Date.now() - 3600000).toISOString();

  try {
    const url = `${SUPABASE_URL}/rest/v1/envios_log?select=id&ip_hash=eq.${hash}` +
                `&creado_en=gte.${desde}&limit=${LIMITE_HORA + 1}`;
    const r = await fetch(url, {
      headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` },
    });
    if (!r.ok) return false;                    // tabla ausente u otro error: no bloqueamos
    const filas = await r.json();
    if (Array.isArray(filas) && filas.length >= LIMITE_HORA) return true;
    await insertar('envios_log', { ip_hash: hash, tipo });
  } catch (e) {
    console.error('Antispam no disponible:', e);  // nunca debe tumbar un envío legítimo
  }
  return false;
}

// ------------------------------------------------------------- Correo

async function avisar(asunto: string, resumen: [string, string][], responderA?: string | null) {
  if (!RESEND_KEY) { console.warn('RESEND_API_KEY sin configurar: no se envía el aviso.'); return; }

  const filas = resumen.map(([k, v]) =>
    '<tr>' +
    `<td style="padding:8px 14px;border-bottom:1px solid #E6EAF2;font-family:Arial,sans-serif;font-size:14px;color:#1E2A4A;font-weight:700;white-space:nowrap;vertical-align:top">${escapar(k)}</td>` +
    `<td style="padding:8px 14px;border-bottom:1px solid #E6EAF2;font-family:Arial,sans-serif;font-size:14px;color:#1E2A4A">${escapar(v).replace(/\n/g, '<br>')}</td>` +
    '</tr>').join('');

  const html =
    '<div style="background:#F4F6FA;padding:28px">' +
      '<div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #E6EAF2">' +
        '<div style="background:#182548;padding:20px 24px">' +
          '<p style="margin:0;font-family:Arial,sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#F0503C;font-weight:700">La Generación Mejor Preparada</p>' +
          `<h1 style="margin:6px 0 0;font-family:Arial,sans-serif;font-size:19px;color:#ffffff">${escapar(asunto)}</h1>` +
        '</div>' +
        `<table style="width:100%;border-collapse:collapse">${filas}</table>` +
        '<p style="margin:0;padding:16px 24px;font-family:Arial,sans-serif;font-size:12.5px;color:#6B7590;background:#F4F6FA">' +
          'Enviado desde un formulario de lageneracionmejorpreparada.com. La solicitud queda guardada en la base de datos de la Asociación.' +
        '</p>' +
      '</div>' +
    '</div>';

  const texto = resumen.map(([k, v]) => `${k}: ${v}`).join('\n');

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: REMITENTE,
      to: AVISOS_PARA,
      subject: asunto,
      html,
      text: texto,
      ...(responderA ? { reply_to: responderA } : {}),
    }),
  });
  if (!r.ok) console.error('Resend falló:', r.status, await r.text());
}

// ------------------------------------------------- Definición de formularios

type Preparado = {
  tabla: string;
  params?: string;
  fila: Record<string, unknown>;
  asunto: string;
  resumen: [string, string][];
  responderA?: string | null;
};

const TRAMOS: Record<string, string> = {
  menor30: 'Menor de 30 años · 7,50 € al año',
  mayor30: '30 años o más · 15 € al año',
};

const COLABORACIONES = [
  'mentorías', 'ofertas de empleo', 'prácticas', 'patrocinio',
  'cesión de espacio', 'ponencias', 'podcast', 'otras',
];

function preparar(tipo: string, d: Record<string, unknown>): Preparado {
  const si = (b: boolean) => (b ? 'Sí' : 'No');

  if (tipo === 'contacto') {
    const nombre = txt(d.nombre, 120);
    const apellido = txt(d.apellido, 120);
    const email = txt(d.email, 254);
    const telefono = txt(d.telefono, 40);
    const mensaje = parrafo(d.mensaje);
    const comunicaciones = bool(d.acepta_comunicaciones);
    exigir(nombre, 'Escribe tu nombre.');
    exigir(emailValido(email), 'Escribe un correo electrónico válido.');
    exigir(telefonoValido(telefono), 'Escribe un teléfono válido.');
    exigir(mensaje, 'Escribe tu mensaje.');
    return {
      tabla: 'contactos',
      fila: { nombre, apellido, email, telefono, mensaje, acepta_comunicaciones: comunicaciones },
      asunto: `Nuevo mensaje de contacto · ${nombre}`,
      responderA: email,
      resumen: [
        ['Nombre', [nombre, apellido].filter(Boolean).join(' ')],
        ['Email', email],
        ['Teléfono', telefono],
        ['Mensaje', mensaje],
        ['Acepta comunicaciones', si(comunicaciones)],
      ],
    };
  }

  if (tipo === 'inscripcion-evento') {
    const nombre = txt(d.nombre, 120);
    const email = txt(d.email, 254);
    const telefono = txt(d.telefono, 40);
    const perfil = txt(d.perfil, 80);
    const sector = txt(d.sector, 120);
    const anio = txt(d.anio_graduacion, 10);
    const como = txt(d.como_conocio, 80);
    const comentario = parrafo(d.comentario, 2000);
    const comunicaciones = bool(d.acepta_comunicaciones);
    exigir(nombre, 'Escribe tu nombre y apellidos.');
    exigir(emailValido(email), 'Escribe un correo electrónico válido.');
    exigir(telefonoValido(telefono), 'Escribe un teléfono válido.');
    exigir(perfil, 'Dinos con qué te identificas.');
    const evento = txt(d.evento, 160) ?? 'Presentación oficial · 1 de octubre de 2026';
    return {
      tabla: 'inscripciones_evento',
      fila: {
        evento, nombre, email, telefono, perfil, sector,
        anio_graduacion: anio, como_conocio: como, comentario,
        acepta_comunicaciones: comunicaciones,
      },
      asunto: `Nueva inscripción al evento · ${nombre}`,
      responderA: email,
      resumen: [
        ['Evento', evento],
        ['Nombre', nombre],
        ['Email', email],
        ['Teléfono', telefono],
        ['Perfil', perfil],
        ['Estudios o sector', sector ?? '—'],
        ['Año de graduación', anio ?? '—'],
        ['Cómo se enteró', como ?? '—'],
        ['Comentario', comentario ?? '—'],
        ['Acepta comunicaciones', si(comunicaciones)],
      ],
    };
  }

  if (tipo === 'alta-socio') {
    const nombre = txt(d.nombre, 120);
    const email = txt(d.email, 254);
    const telefono = txt(d.telefono, 40);
    const municipio = txt(d.municipio, 80);
    const tramo = opcion(d.tramo, ['menor30', 'mayor30']);
    const situacion = txt(d.situacion, 80);
    const sector = txt(d.sector, 120);
    const linkedin = txt(d.linkedin, 300);
    const como = txt(d.como_conocio, 80);
    const expectativas = parrafo(d.expectativas, 2000);
    const comunicaciones = bool(d.acepta_comunicaciones);
    exigir(nombre, 'Escribe tu nombre y apellidos.');
    exigir(emailValido(email), 'Escribe un correo electrónico válido.');
    exigir(telefonoValido(telefono), 'Escribe un teléfono válido.');
    exigir(municipio, 'Dinos de qué municipio eres.');
    exigir(tramo, 'Selecciona tu tramo de edad.');
    exigir(situacion, 'Selecciona tu situación actual.');
    return {
      tabla: 'altas_socio',
      fila: {
        nombre, email, telefono, municipio, tramo, situacion, sector, linkedin,
        como_conocio: como, expectativas, acepta_comunicaciones: comunicaciones,
      },
      asunto: `Nueva solicitud de alta · ${nombre}`,
      responderA: email,
      resumen: [
        ['Nombre', nombre],
        ['Email', email],
        ['Teléfono', telefono],
        ['Municipio', municipio],
        ['Cuota', TRAMOS[tramo]],
        ['Situación', situacion],
        ['Estudios o sector', sector ?? '—'],
        ['LinkedIn', linkedin ?? '—'],
        ['Cómo nos conoció', como ?? '—'],
        ['Qué espera', expectativas ?? '—'],
        ['Acepta comunicaciones', si(comunicaciones)],
      ],
    };
  }

  if (tipo === 'alta-entidad') {
    const entidad = txt(d.entidad, 160);
    const cif = txt(d.cif, 20);
    const municipio = txt(d.municipio, 80);
    const sector = txt(d.sector, 120);
    const web = txt(d.web, 300);
    const contacto = txt(d.contacto_nombre, 120);
    const cargo = txt(d.contacto_cargo, 120);
    const email = txt(d.email, 254);
    const telefono = txt(d.telefono, 40);
    const mensaje = parrafo(d.mensaje, 2000);
    const origen = opcion(d.origen, ['corporativo', 'institucional', 'colaboradora']);
    const comunicaciones = bool(d.acepta_comunicaciones);
    const colaboracion = Array.isArray(d.colaboracion)
      ? d.colaboracion.map((c) => txt(c, 40)).filter((c): c is string => !!c && COLABORACIONES.includes(c))
      : [];
    exigir(entidad, 'Escribe el nombre de la entidad.');
    exigir(cif, 'Escribe el CIF de la entidad.');
    exigir(contacto, 'Escribe el nombre de la persona de contacto.');
    exigir(cargo, 'Indica el cargo de la persona de contacto.');
    exigir(emailValido(email), 'Escribe un correo electrónico válido.');
    exigir(telefonoValido(telefono), 'Escribe un teléfono válido.');
    return {
      tabla: 'altas_entidad',
      fila: {
        entidad, cif, municipio, sector, web,
        contacto_nombre: contacto, contacto_cargo: cargo, email, telefono,
        colaboracion, mensaje, origen, acepta_comunicaciones: comunicaciones,
      },
      asunto: `Nueva entidad interesada · ${entidad}`,
      responderA: email,
      resumen: [
        ['Entidad', entidad],
        ['CIF', cif],
        ['Municipio', municipio ?? '—'],
        ['Sector', sector ?? '—'],
        ['Web', web ?? '—'],
        ['Persona de contacto', `${contacto} (${cargo})`],
        ['Email', email],
        ['Teléfono', telefono],
        ['Cómo quieren colaborar', colaboracion.length ? colaboracion.join(', ') : '—'],
        ['Mensaje', mensaje ?? '—'],
        ['Origen', origen ?? 'No indicado'],
        ['Acepta comunicaciones', si(comunicaciones)],
      ],
    };
  }

  if (tipo === 'newsletter') {
    const nombre = txt(d.nombre, 120);
    const email = txt(d.email, 254);
    exigir(emailValido(email), 'Escribe un correo electrónico válido.');
    exigir(bool(d.acepta_comunicaciones), 'Debes aceptar recibir comunicaciones.');
    return {
      tabla: 'newsletter',
      params: '?on_conflict=email',
      fila: { nombre, email, baja_en: null },
      asunto: `Nueva alta en la newsletter · ${nombre ?? email}`,
      responderA: email,
      resumen: [['Nombre', nombre ?? '—'], ['Email', email]],
    };
  }

  throw new ErrorValidacion('Formulario no reconocido.');
}

// ------------------------------------------------------------- Handler

Deno.serve(async (req) => {
  const origen = req.headers.get('origin');

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cabecerasCors(origen) });
  if (req.method !== 'POST') return responder({ ok: false, error: 'Método no permitido.' }, 405, origen);

  const clave = req.headers.get('apikey') ??
                (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!claveAdmitida(clave)) {
    return responder({ ok: false, error: 'Petición no autorizada.' }, 401, origen);
  }

  let cuerpo: Record<string, unknown>;
  try {
    cuerpo = await req.json();
  } catch (_) {
    return responder({ ok: false, error: 'Petición mal formada.' }, 400, origen);
  }

  // Honeypot: los navegadores dejan el campo vacío; los bots lo rellenan.
  // Se responde ok para que el bot no aprenda que ha sido detectado.
  if (txt(cuerpo.trampa, 100)) return responder({ ok: true }, 200, origen);

  const tipo = txt(cuerpo.tipo, 40) ?? '';
  const datos = (cuerpo.datos ?? {}) as Record<string, unknown>;

  let preparado: Preparado;
  try {
    preparado = preparar(tipo, datos);
  } catch (e) {
    if (e instanceof ErrorValidacion) return responder({ ok: false, error: e.message }, 400, origen);
    throw e;
  }

  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
  if (await limiteSuperado(ip, tipo)) {
    return responder({
      ok: false,
      error: `Has enviado varios formularios seguidos. Espera un rato o escríbenos a ${CORREO_LGMP}.`,
    }, 429, origen);
  }

  try {
    await insertar(preparado.tabla, preparado.fila, preparado.params ?? '');
  } catch (e) {
    console.error('Error al guardar:', e);
    return responder({
      ok: false,
      error: `No hemos podido guardar tu solicitud. Escríbenos a ${CORREO_LGMP} y lo resolvemos.`,
    }, 500, origen);
  }

  // El aviso es best-effort: el dato ya está a salvo aunque Resend falle.
  try {
    await avisar(preparado.asunto, preparado.resumen, preparado.responderA);
  } catch (e) {
    console.error('Error al avisar por correo:', e);
  }

  return responder({ ok: true }, 200, origen);
});
