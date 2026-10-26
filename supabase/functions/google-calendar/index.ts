// =====================================================================
//  LGMP · Edge Function `google-calendar`
//
//  Conecta la cuenta de Google dueña de los eventos (una sola vez) y sirve
//  para buscar el id de un evento de su calendario.
//
//    GET  ?clave=<RECORDATORIOS_CLAVE>   lleva a la pantalla de permiso de Google
//    GET  ?code=…&state=…                vuelta de Google: guarda el permiso
//    POST {"accion":"buscar","texto":"webinar","desde":"2026-11-01"}
//         con la cabecera x-clave         lista eventos de ese calendario
//
//  Solo acepta la cuenta GOOGLE_CUENTA: si alguien autoriza con otra, no
//  se guarda nada. El permiso (refresh token) va a la tabla `integraciones`,
//  nunca al chat, al repositorio ni a CONTEXTO-LGMP.md.
//
//  En Google Cloud, la "URI de redireccionamiento autorizada" del cliente
//  OAuth tiene que ser exactamente la dirección de esta función:
//    https://cegicdvznbvbemqoftod.supabase.co/functions/v1/google-calendar
// =====================================================================

import { CLIENT_ID, CLIENT_SECRET, CUENTA, calendar, guardarPermiso } from '../_shared/google-calendar.ts';

const CLAVE = Deno.env.get('RECORDATORIOS_CLAVE') ?? '';
const VUELTA = `${Deno.env.get('SUPABASE_URL')}/functions/v1/google-calendar`;
const PERMISOS = 'openid email https://www.googleapis.com/auth/calendar.events';

function pagina(titulo: string, texto: string, estado = 200) {
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title></head>
<body style="margin:0;background:#F4F6FA;font-family:Arial,sans-serif;color:#1E2A4A">
<div style="max-width:520px;margin:60px auto;background:#fff;border-radius:18px;padding:32px;border:1px solid #E6EAF2">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#F0503C;font-weight:700">La Generación Mejor Preparada</p>
<h1 style="margin:0 0 14px;font-size:22px">${titulo}</h1><p style="margin:0;font-size:16px;line-height:1.6">${texto}</p></div></body></html>`;
  return new Response(html, { status: estado, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

const json = (c: unknown, s = 200) =>
  new Response(JSON.stringify(c), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

// "state" firmado: así nadie puede colar la vuelta de Google sin haber
// empezado desde el enlace con la clave. Caduca a los 15 minutos.
async function firma(t: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(CLAVE),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(t));
  return Array.from(new Uint8Array(s)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!CLAVE || !CLIENT_ID || !CLIENT_SECRET) {
    return pagina('Falta configurar', 'Faltan los secretos GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en Supabase.', 500);
  }

  if (req.method === 'GET') {
    // 1. Ida: a la pantalla de permiso de Google
    if (url.searchParams.get('clave')) {
      if (url.searchParams.get('clave') !== CLAVE) return pagina('Enlace no válido', 'La clave no es correcta.', 401);
      const t = String(Date.now());
      const p = new URLSearchParams({
        client_id: CLIENT_ID, redirect_uri: VUELTA, response_type: 'code', scope: PERMISOS,
        access_type: 'offline', prompt: 'consent', login_hint: CUENTA, state: `${t}.${await firma(t)}`,
      });
      return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`, 302);
    }

    // 2. Vuelta de Google
    const code = url.searchParams.get('code');
    const [t, f] = String(url.searchParams.get('state') ?? '').split('.');
    if (url.searchParams.get('error')) return pagina('Permiso no concedido', 'No se ha conectado nada. Puedes volver a intentarlo.', 400);
    if (!code || !t || f !== await firma(t) || Date.now() - Number(t) > 15 * 60000) {
      return pagina('Enlace caducado', 'Vuelve a empezar desde el enlace que te pasó Claude.', 400);
    }
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
                                  redirect_uri: VUELTA, grant_type: 'authorization_code' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) {
      console.error('Intercambio de código:', r.status, JSON.stringify(j).slice(0, 300));
      return pagina('No se ha podido conectar', 'Google no ha devuelto el permiso. Vuelve a intentarlo desde el enlace.', 400);
    }
    // El id_token viene directamente de Google por HTTPS: basta con leerlo.
    const datos = JSON.parse(atob(String(j.id_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const cuenta = String(datos.email ?? '').toLowerCase();
    if (cuenta !== CUENTA) {
      return pagina('Cuenta equivocada', `Has entrado con ${cuenta}. Hay que hacerlo con ${CUENTA}, la dueña de los eventos.`, 403);
    }
    await guardarPermiso(j.refresh_token, cuenta);
    return pagina('¡Conectado!', `La web ya puede añadir a los inscritos como invitados en el calendario de ${cuenta}. Ya puedes cerrar esta pestaña.`);
  }

  // 3. Buscar eventos (para saber el id que va en el panel)
  if (req.method === 'POST') {
    if (req.headers.get('x-clave') !== CLAVE) return json({ ok: false, error: 'No autorizado' }, 401);
    const c = await req.json().catch(() => ({}));
    if (c.accion !== 'buscar') return json({ ok: false, error: 'Acción desconocida' }, 400);
    const p = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '20',
      timeMin: new Date(c.desde ?? Date.now()).toISOString(), ...(c.texto ? { q: String(c.texto) } : {}) });
    const r = await calendar(`?${p}`);
    if (!r.ok) return json({ ok: false, error: `HTTP ${r.status}: ${await r.text()}` }, 502);
    const evs = (await r.json()).items ?? [];
    return json({ ok: true, eventos: evs.map((e: Record<string, any>) => ({
      id: e.id, titulo: e.summary, inicio: e.start?.dateTime ?? e.start?.date,
      meet: e.hangoutLink ?? null, invitados: (e.attendees ?? []).length,
      ocultos: e.guestsCanSeeOtherGuests === false })) });
  }

  return json({ ok: false }, 405);
});
