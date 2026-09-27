// =====================================================================
//  LGMP · Alta de inscritos a eventos en MailerLite
//
//  La usan `enviar-formulario` (al inscribirse) y `recordatorios` (que
//  reintenta cada 10 minutos lo que haya fallado).
//
//  ┌───────────────────────────────────────────────────────────────────┐
//  │ LA REGLA MÁS IMPORTANTE: EL CONSENTIMIENTO                         │
//  │                                                                   │
//  │ · Todo inscrito entra en el grupo DE SU EVENTO. A ese grupo solo  │
//  │   se le puede escribir sobre ESE evento (confirmación, cambios,   │
//  │   recordatorio, encuesta de después). Nada más.                   │
//  │ · Solo si marcó «Quiero recibir novedades» (acepta_comunicaciones)│
//  │   entra TAMBIÉN en `web-asociacion`, que es el grupo para         │
//  │   campañas generales.                                              │
//  │ · Por eso las campañas generales se mandan SIEMPRE al grupo       │
//  │   web-asociacion, NUNCA a «Todos los suscriptores» ni a un grupo  │
//  │   de evento: ahí hay gente que no ha dado permiso para eso.       │
//  │ · Si alguien se dio de baja (o rebotó, o nos marcó como spam) no  │
//  │   se le vuelve a dar de alta NUNCA desde aquí. Se registra y ya.  │
//  │   Resucitar bajas trae quejas de spam y hunde el dominio.         │
//  └───────────────────────────────────────────────────────────────────┘
//
//  Secretos (Supabase → Edge Functions → Secrets):
//    MAILERLITE_API_KEY               la clave de la API de MailerLite
//    MAILERLITE_GRUPO_COMUNICACIONES  opcional · id del grupo web-asociacion
//
//  El grupo de cada evento se elige en el panel (columna
//  `eventos.mailerlite_grupo`, el id numérico del grupo).
// =====================================================================

const API = 'https://connect.mailerlite.com/api';

// Grupo web-asociacion: gente que SÍ ha aceptado recibir comunicaciones.
export const GRUPO_COMUNICACIONES =
  Deno.env.get('MAILERLITE_GRUPO_COMUNICACIONES') ?? '192357069345523366';

// Estados de MailerLite con los que NO se toca a la persona.
const NO_TOCAR = ['unsubscribed', 'bounced', 'junk'];

export type ResultadoMailerLite = {
  estado: 'ok' | 'baja' | 'error';
  detalle: string;
};

export function mailerLiteConfigurado(): boolean {
  return !!Deno.env.get('MAILERLITE_API_KEY');
}

/**
 * Da de alta (o actualiza) a un inscrito. Nunca lanza: devuelve el
 * resultado para guardarlo en la inscripción.
 */
export async function altaEnMailerLite(p: {
  email: string;
  nombre: string | null;
  perfil: string | null;
  grupoEvento: string;
  aceptaComunicaciones: boolean;
}): Promise<ResultadoMailerLite> {
  const clave = Deno.env.get('MAILERLITE_API_KEY');
  if (!clave) return { estado: 'error', detalle: 'Falta el secreto MAILERLITE_API_KEY' };

  const cab = {
    Authorization: `Bearer ${clave}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const email = p.email.trim().toLowerCase();

  try {
    // 1. ¿Ya existe? Si se dio de baja, rebotó o se quejó: fuera, no se toca.
    const r = await fetch(`${API}/subscribers/${encodeURIComponent(email)}`,
      { headers: cab, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const estado = (await r.json())?.data?.status;
      if (NO_TOCAR.includes(estado)) {
        return { estado: 'baja', detalle: `En MailerLite está como «${estado}». No se le da de alta.` };
      }
    } else if (r.status !== 404) {
      return { estado: 'error', detalle: `Consulta HTTP ${r.status}: ${(await r.text()).slice(0, 300)}` };
    }

    // 2. Grupos. El del evento siempre; web-asociacion SOLO con consentimiento
    //    (ver la regla de arriba). Si ya estaba en web-asociacion por otro
    //    formulario, se queda: esto solo añade grupos, no quita.
    const grupos = [p.grupoEvento];
    if (p.aceptaComunicaciones) grupos.push(GRUPO_COMUNICACIONES);

    // 3. Alta o actualización. MailerLite identifica por el correo, así que
    //    no duplica. No se manda `status`: a alguien que ya existe no se le
    //    cambia el estado.
    const [nombre, ...resto] = String(p.nombre ?? '').trim().split(/\s+/);
    const campos: Record<string, string> = {};
    if (nombre) campos.name = nombre;
    if (resto.length) campos.last_name = resto.join(' ');
    if (p.perfil) campos.perfil = p.perfil;

    const a = await fetch(`${API}/subscribers`, {
      method: 'POST', headers: cab, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ email, fields: campos, groups: grupos }),
    });
    if (!a.ok) {
      return { estado: 'error', detalle: `Alta HTTP ${a.status}: ${(await a.text()).slice(0, 300)}` };
    }
    return {
      estado: 'ok',
      detalle: p.aceptaComunicaciones ? 'Grupo del evento + web-asociacion' : 'Solo grupo del evento',
    };
  } catch (e) {
    return { estado: 'error', detalle: `Sin respuesta: ${e instanceof Error ? e.message : e}` };
  }
}
