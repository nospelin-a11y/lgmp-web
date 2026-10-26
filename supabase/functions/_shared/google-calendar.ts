// =====================================================================
//  LGMP · Inscritos a eventos → invitados de Google Calendar
//
//  La usan `enviar-formulario` (al inscribirse), `recordatorios` (que
//  reintenta los fallos cada 10 minutos) y `google-calendar` (que conecta
//  la cuenta de Google).
//
//  Por qué así: la cuenta dueña del evento es una cuenta personal de Gmail
//  (no Google Workspace). En esas cuentas una "cuenta de servicio" no puede
//  invitar a nadie, así que se usa el permiso de la propia cuenta: se
//  autoriza una vez (función `google-calendar`) y se guarda el refresh
//  token en la tabla `integraciones`, que solo puede leer la clave secreta.
//
//  PRIVACIDAD: en cada cambio se fuerza guestsCanSeeOtherGuests = false.
//  Sin eso, cada inscrito vería el correo de todos los demás.
//
//  Secretos (Supabase → Edge Functions → Secrets):
//    GOOGLE_CLIENT_ID      id del cliente OAuth (Google Cloud → Credenciales)
//    GOOGLE_CLIENT_SECRET  secreto de ese cliente
//    GOOGLE_CUENTA         opcional · cuenta que se puede conectar
//    GOOGLE_AVISAR         opcional · 'all' (por defecto) o 'none': si Google
//                          manda él la invitación por correo al añadir a alguien
// =====================================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SECRETA = Deno.env.get('CLAVE_SECRETA') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export const CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
export const CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
export const CUENTA = (Deno.env.get('GOOGLE_CUENTA') ?? 'juanfranciscolopezharo@gmail.com').toLowerCase();
const AVISAR = Deno.env.get('GOOGLE_AVISAR') === 'none' ? 'none' : 'all';

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export type ResultadoGoogle = { estado: 'ok' | 'error'; detalle: string };

async function db(ruta: string, init: RequestInit = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${ruta}`, {
    ...init,
    headers: { apikey: SECRETA, Authorization: `Bearer ${SECRETA}`, 'Content-Type': 'application/json',
               ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`${ruta} (${r.status}): ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

/** Guarda el permiso de la cuenta de Google (solo la llama google-calendar). */
export async function guardarPermiso(refreshToken: string, cuenta: string) {
  await db('integraciones?on_conflict=nombre', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ nombre: 'google_refresh_token', valor: refreshToken, cuenta,
                           actualizado_en: new Date().toISOString() }),
  });
}

let cache: { token: string; caduca: number } | null = null;

/** Token de acceso válido, o null si la cuenta no está conectada. */
export async function tokenAcceso(): Promise<string | null> {
  if (cache && cache.caduca > Date.now() + 60000) return cache.token;
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  const filas = await db('integraciones?select=valor&nombre=eq.google_refresh_token');
  const refresh = Array.isArray(filas) && filas[0]?.valor;
  if (!refresh) return null;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
                                refresh_token: refresh, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Google no renueva el permiso (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  cache = { token: j.access_token, caduca: Date.now() + (j.expires_in ?? 3000) * 1000 };
  return cache.token;
}

export async function googleConectado(): Promise<boolean> {
  try { return !!(await tokenAcceso()); } catch { return false; }
}

/** Llamada a la API de Calendar con el token de la cuenta conectada. */
export async function calendar(ruta: string, init: RequestInit = {}) {
  const t = await tokenAcceso();
  if (!t) throw new Error('La cuenta de Google no está conectada');
  return fetch(`${API}${ruta}`, {
    ...init, signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

/**
 * Añade a la persona como invitada del evento. Nunca lanza.
 * Si ya estaba, no hace nada. Usa la etiqueta de versión del evento (etag)
 * para que dos inscripciones a la vez no se pisen.
 */
export async function invitar(eventoGoogle: string, email: string): Promise<ResultadoGoogle> {
  const correo = email.trim().toLowerCase();
  try {
    for (let intento = 0; intento < 3; intento++) {
      const g = await calendar(`/${encodeURIComponent(eventoGoogle)}`);
      if (!g.ok) return { estado: 'error', detalle: `Leer el evento HTTP ${g.status}: ${(await g.text()).slice(0, 200)}` };
      const ev = await g.json();
      const invitados: { email: string }[] = ev.attendees ?? [];
      if (invitados.some((a) => a.email?.toLowerCase() === correo)) {
        return { estado: 'ok', detalle: 'Ya estaba invitado' };
      }
      const p = await calendar(`/${encodeURIComponent(eventoGoogle)}?sendUpdates=${AVISAR}`, {
        method: 'PATCH',
        headers: { 'If-Match': ev.etag },
        body: JSON.stringify({
          attendees: [...invitados, { email: correo }],
          guestsCanSeeOtherGuests: false,      // nadie ve los correos de los demás
          guestsCanInviteOthers: false,
        }),
      });
      if (p.status === 412) continue;          // otro lo cambió a la vez: se vuelve a leer
      if (!p.ok) return { estado: 'error', detalle: `Invitar HTTP ${p.status}: ${(await p.text()).slice(0, 200)}` };
      return { estado: 'ok', detalle: AVISAR === 'all' ? 'Invitado (Google le manda la invitación)' : 'Invitado sin correo de Google' };
    }
    return { estado: 'error', detalle: 'El evento cambiaba a la vez; se reintenta' };
  } catch (e) {
    return { estado: 'error', detalle: e instanceof Error ? e.message : String(e) };
  }
}
