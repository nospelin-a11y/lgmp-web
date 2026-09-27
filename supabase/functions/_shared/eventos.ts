// =====================================================================
//  LGMP · Utilidades de eventos compartidas por las Edge Functions
//  `enviar-formulario` (correo de confirmación) y `recordatorios`.
//
//  Horas: en la tabla `eventos` la hora es texto libre ("19:00" o
//  "19:00 a 20:00") y siempre es hora de España. Aquí se convierte a un
//  instante real teniendo en cuenta el horario de verano.
// =====================================================================

export const WEB = 'https://lageneracionmejorpreparada.com';
export const CORREO_LGMP = 'hola@lageneracionmejorpreparada.com';

export type Evento = {
  id: number;
  titulo: string;
  fecha: string;              // AAAA-MM-DD
  hora: string | null;
  lugar: string | null;
  modalidad: string;          // presencial | online
  slug: string | null;
  publicado?: boolean;
  recordatorios?: boolean;
  enlace_reunion?: string | null;
};

const DIAS  = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
               'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function escapar(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Minutos que Madrid va por delante de UTC en ese instante (60 o 120). */
function desfaseMadrid(d: Date): number {
  const z = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', timeZoneName: 'longOffset' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const m = z.match(/([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/** "AAAA-MM-DD" + "HH:MM" en hora de España → instante real. */
function instante(fecha: string, hhmm: string): Date {
  const aprox = new Date(`${fecha}T${hhmm.padStart(5, '0')}:00Z`);
  return new Date(aprox.getTime() - desfaseMadrid(aprox) * 60000);
}

/** Inicio y fin del evento. Sin hora de fin, dura una hora. Sin hora, null. */
export function inicioFin(ev: Evento): { inicio: Date; fin: Date } | null {
  const h = String(ev.hora ?? '').match(/\d{1,2}:\d{2}/g) ?? [];
  if (!h.length) return null;
  const inicio = instante(ev.fecha, h[0]!);
  const fin = h[1] ? instante(ev.fecha, h[1]) : new Date(inicio.getTime() + 3600000);
  return { inicio, fin };
}

/** "jueves 12 de noviembre" */
export function fechaTexto(fecha: string): string {
  const d = new Date(fecha + 'T12:00:00Z');
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
}

/** "19:00 a 20:00 (hora de España)" o null */
export function horaTexto(ev: Evento): string | null {
  const h = String(ev.hora ?? '').match(/\d{1,2}:\d{2}/g) ?? [];
  if (!h.length) return null;
  return (h[1] ? `${h[0]} a ${h[1]}` : h[0]) + ' (hora de España)';
}

export function esOnline(ev: Evento): boolean {
  return ev.modalidad === 'online';
}

export function dondeTexto(ev: Evento): string {
  return ev.lugar || (esOnline(ev) ? 'Online' : 'Murcia');
}

export function urlEvento(ev: Evento): string {
  return ev.slug ? `${WEB}/eventos/${ev.slug}/` : `${WEB}/actividades/`;
}

/** El .ics lo escribe el generador junto a la página del evento. */
export function urlIcs(ev: Evento): string | null {
  return ev.slug ? `${WEB}/eventos/${ev.slug}/evento.ics` : null;
}

const aUtc = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Enlace de la videollamada, si el evento es online y está puesto. */
export function enlaceReunion(ev: Evento): string | null {
  return esOnline(ev) && /^https:\/\//.test(ev.enlace_reunion ?? '') ? ev.enlace_reunion! : null;
}

export function urlGoogleCalendar(ev: Evento): string {
  const t = inicioFin(ev);
  let fechas: string;
  if (t) {
    fechas = `${aUtc(t.inicio)}/${aUtc(t.fin)}`;
  } else {                                   // sin hora: evento de día completo
    const d = new Date(ev.fecha + 'T12:00:00Z');
    const sig = new Date(d.getTime() + 86400000).toISOString().slice(0, 10);
    fechas = `${ev.fecha.replace(/-/g, '')}/${sig.replace(/-/g, '')}`;
  }
  // El enlace de la videollamada solo va en los correos (nunca en la web):
  // así queda guardado en el calendario de quien se inscribe.
  const enlace = enlaceReunion(ev);
  const detalles = (enlace ? `Enlace para entrar: ${enlace}\n\n` : '') + urlEvento(ev);
  const p = new URLSearchParams({
    text: ev.titulo, details: detalles, location: enlace ?? dondeTexto(ev), ctz: 'Europe/Madrid',
  });
  // `dates` va sin codificar: Google espera la barra tal cual.
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&dates=${fechas}&${p}`;
}

// ------------------------------------------------------------- Correo

export function boton(texto: string, url: string, secundario = false): string {
  const estilo = secundario
    ? 'background:#ffffff;color:#1E2A4A;border:2px solid #1E2A4A'
    : 'background:#F0503C;color:#ffffff;border:2px solid #F0503C';
  return `<a href="${escapar(url)}" style="${estilo};display:inline-block;margin:0 8px 10px 0;` +
    'padding:11px 22px;border-radius:999px;font-family:Arial,sans-serif;font-size:14.5px;' +
    `font-weight:700;text-decoration:none">${escapar(texto)}</a>`;
}

export function parrafo(t: string): string {
  return '<p style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:15.5px;line-height:1.6;color:#1E2A4A">' +
    `${escapar(t).replace(/\n/g, '<br>')}</p>`;
}

/** Ficha gris con los datos del evento. */
export function fichaEvento(ev: Evento, extra: [string, string][] = []): string {
  const filas: [string, string][] = [
    ['Cuándo', `${fechaTexto(ev.fecha)}${horaTexto(ev) ? ', ' + horaTexto(ev) : ''}`],
    ['Dónde', dondeTexto(ev)],
    ...extra,
  ];
  return '<table role="presentation" style="width:100%;border-collapse:collapse;background:#F4F6FA;border-radius:14px;margin:4px 0 20px">' +
    filas.map(([k, v]) => '<tr>' +
      `<td style="padding:10px 16px;font-family:Arial,sans-serif;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#F0503C;font-weight:700;white-space:nowrap;vertical-align:top;width:1%">${escapar(k)}</td>` +
      `<td style="padding:10px 16px 10px 0;font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1E2A4A;font-weight:700">${escapar(v)}</td>` +
      '</tr>').join('') +
    '</table>';
}

/** Marco común: cabecera marino con el logo, cuerpo blanco y pie gris. */
export function plantilla(titulo: string, cuerpoHtml: string, pie: string): string {
  return '<div style="background:#F4F6FA;padding:28px 12px">' +
    '<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #E6EAF2">' +
      '<div style="background:#182548;padding:22px 26px">' +
        `<img src="${WEB}/assets/logo-correo.png" width="180" height="45" alt="La Generación Mejor Preparada" style="display:block;border:0">` +
        `<h1 style="margin:18px 0 0;font-family:Arial,sans-serif;font-size:22px;line-height:1.3;color:#ffffff">${escapar(titulo)}</h1>` +
      '</div>' +
      `<div style="padding:26px 26px 14px">${cuerpoHtml}</div>` +
      '<p style="margin:0;padding:16px 26px;font-family:Arial,sans-serif;font-size:12.5px;line-height:1.5;color:#6B7590;background:#F4F6FA">' +
        `Asociación La Generación Mejor Preparada · Murcia · <a href="${WEB}" style="color:#6B7590">lageneracionmejorpreparada.com</a><br>${escapar(pie)}` +
      '</p>' +
    '</div>' +
  '</div>';
}

// ------------------------------------------------ Correos a los inscritos

export type Correo = { asunto: string; html: string; texto: string };

const FIRMA = 'Nos vemos,\nLa Junta de LGMP';

/** Correo que recibe quien se acaba de inscribir. */
export function correoConfirmacion(ev: Evento, nombre: string): Correo {
  const online = esOnline(ev);
  const google = urlGoogleCalendar(ev);
  const ics = urlIcs(ev);
  const enlace = enlaceReunion(ev);
  const plataforma = /meet\.google\./.test(enlace ?? '') ? 'Google Meet' : 'la videollamada';
  const aviso = online
    ? (enlace ? 'Este es el enlace para entrar. Te lo recordamos el día antes y una hora antes de empezar.'
              : 'El enlace para entrar te lo mandamos por correo antes del webinar.')
    : ev.recordatorios ? 'El día antes te mandamos un recordatorio.' : null;
  const dudas = online
    ? '¿Alguna duda? Responde a este correo.'
    : 'Si al final no puedes venir, responde a este correo y liberamos tu sitio.';

  const html = plantilla('Inscripción confirmada',
    parrafo(`Hola, ${nombre}:`) +
    parrafo(`Ya estás en la lista de «${ev.titulo}».`) +
    fichaEvento(ev) +
    (aviso ? parrafo(aviso) : '') +
    (enlace
      ? '<div style="margin:4px 0 8px">' + boton(`Entrar en ${plataforma}`, enlace) + '</div>' +
        `<p style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:13px;color:#6B7590;word-break:break-all">${escapar(enlace)}</p>`
      : '') +
    '<p style="margin:6px 0 8px;font-family:Arial,sans-serif;font-size:14px;color:rgba(30,42,74,.75)">Guárdalo en tu calendario:</p>' +
    '<div style="margin:0 0 12px">' + boton('Google Calendar', google) +
      (ics ? boton('Outlook o Apple (.ics)', ics, true) : '') + '</div>' +
    parrafo(dudas) + parrafo(FIRMA),
    'Recibes este correo porque te has inscrito en un evento desde nuestra web.');

  const texto = [
    `Hola, ${nombre}:`,
    `Ya estás en la lista de «${ev.titulo}».`,
    `Cuándo: ${fechaTexto(ev.fecha)}${horaTexto(ev) ? ', ' + horaTexto(ev) : ''}\nDónde: ${dondeTexto(ev)}`,
    ...(aviso ? [aviso + (enlace ? `\n${enlace}` : '')] : []),
    `Añadir a Google Calendar: ${google}` + (ics ? `\nArchivo para Outlook o Apple: ${ics}` : ''),
    dudas, FIRMA,
  ].join('\n\n');

  return { asunto: `Inscripción confirmada: ${ev.titulo}`, html, texto };
}

/** Recordatorio del día antes ('dia') o de una hora antes ('hora'). */
export function correoRecordatorio(ev: Evento, nombre: string, cual: 'dia' | 'hora'): Correo {
  const online = esOnline(ev);
  const hora = (String(ev.hora ?? '').match(/\d{1,2}:\d{2}/) ?? [''])[0];
  const enlace = enlaceReunion(ev);
  const plataforma = /meet\.google\./.test(enlace ?? '') ? 'Google Meet' : 'la videollamada';

  const titulo = cual === 'dia' ? 'Es mañana' : 'Empezamos en una hora';
  const asunto = cual === 'dia'
    ? `Mañana${hora ? ' a las ' + hora : ''}: ${ev.titulo}`
    : `A las ${hora}: ${ev.titulo}`;
  const intro = cual === 'dia'
    ? `Mañana${hora ? ' a las ' + hora : ''} empieza «${ev.titulo}».`
    : `A las ${hora} empieza «${ev.titulo}».`;

  const acceso = online
    ? (enlace
        ? (cual === 'dia'
            ? 'Aquí tienes otra vez el enlace para entrar. Una hora antes te lo volvemos a mandar.'
            : 'Entra con este enlace. Si puedes, conéctate cinco minutos antes para comprobar el audio.')
        : 'El enlace para entrar te lo mandamos en un correo aparte.')
    : `Te esperamos en ${dondeTexto(ev)}.`;

  const html = plantilla(titulo,
    parrafo(`Hola, ${nombre}:`) +
    parrafo(intro) +
    fichaEvento(ev) +
    parrafo(acceso) +
    (enlace
      ? '<div style="margin:4px 0 8px">' + boton(`Entrar en ${plataforma}`, enlace) + '</div>' +
        `<p style="margin:0 0 18px;font-family:Arial,sans-serif;font-size:13px;color:#6B7590;word-break:break-all">${escapar(enlace)}</p>`
      : '') +
    parrafo('Si ya no puedes, no pasa nada: responde a este correo y nos lo dices.') +
    parrafo(FIRMA),
    'Recibes este correo porque te inscribiste en este evento desde nuestra web.');

  const texto = [
    `Hola, ${nombre}:`, intro,
    `Cuándo: ${fechaTexto(ev.fecha)}${horaTexto(ev) ? ', ' + horaTexto(ev) : ''}\nDónde: ${dondeTexto(ev)}`,
    acceso + (enlace ? `\n${enlace}` : ''),
    'Si ya no puedes, no pasa nada: responde a este correo y nos lo dices.',
    FIRMA,
  ].join('\n\n');

  return { asunto, html, texto };
}
