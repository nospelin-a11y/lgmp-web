/* =====================================================================
   LGMP · Generador de páginas

   Lee de Supabase los eventos y noticias PUBLICADOS y escribe HTML de
   verdad en disco:

     /eventos/<slug>/index.html
     /noticias/<slug>/index.html
     /actividades/index.html      (listados, entre las marcas LGMP:)
     /sitemap.xml

   Se hace así, y no leyendo la base de datos desde el navegador, para que
   el texto siga estando en el HTML que recibe Google. Es lo que hace que
   estas páginas se indexen.

   Uso:  node scripts/generar.mjs
   ===================================================================== */

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aHtml, resumir } from '../md.js';

const RAIZ  = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE  = 'https://lageneracionmejorpreparada.com';
const URL_SB = process.env.SUPABASE_URL  || 'https://cegicdvznbvbemqoftod.supabase.co';
const CLAVE  = process.env.SUPABASE_ANON || 'sb_publishable_hyev91V4OhpAo79Ox7vqBg_LU_Mfzbh';

const ESC = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' };
const e = t => String(t ?? '').replace(/[&<>"]/g, c => ESC[c]);

const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const MESES_LARGO = ['enero','febrero','marzo','abril','mayo','junio','julio',
                     'agosto','septiembre','octubre','noviembre','diciembre'];

function partes(fecha) {
  const [a, m, d] = String(fecha).split('-').map(Number);
  return { dia: d, mes: MESES[m-1], mesLargo: MESES_LARGO[m-1], anio: a };
}
const fechaLarga = f => { const p = partes(f); return `${p.dia} de ${p.mesLargo} de ${p.anio}`; };

async function traer(tabla, orden) {
  const r = await fetch(`${URL_SB}/rest/v1/${tabla}?select=*&publicado=eq.true&order=${orden}`, {
    headers: { apikey: CLAVE, Authorization: 'Bearer ' + CLAVE }
  });
  if (!r.ok) throw new Error(`${tabla}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

/* ---------------------------------------------------------------------
   Plantilla de una página individual
   --------------------------------------------------------------------- */

function pagina({ tipo, titulo, descripcion, url, kicker, meta, cuerpo, imagen, cta }) {
  const ld = tipo === 'evento'
    ? { '@type':'Event', name:titulo, description:descripcion, startDate:meta.fecha,
        eventStatus:'https://schema.org/EventScheduled',
        eventAttendanceMode:'https://schema.org/OfflineEventAttendanceMode',
        location:{ '@type':'Place', name: meta.lugar || 'Murcia',
                   address:{ '@type':'PostalAddress', addressLocality:'Murcia',
                             addressRegion:'Región de Murcia', addressCountry:'ES' } },
        organizer:{ '@id': BASE + '/#organizacion' }, url }
    : { '@type':'NewsArticle', headline:titulo, description:descripcion,
        datePublished:meta.fecha, inLanguage:'es-ES',
        author:{ '@type': meta.autor ? 'Person' : 'Organization',
                 name: meta.autor || 'Asociación La Generación Mejor Preparada' },
        publisher:{ '@id': BASE + '/#organizacion' },
        mainEntityOfPage: url, ...(imagen ? { image: imagen } : {}) };

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(titulo)} · La Generación Mejor Preparada</title>
<meta name="description" content="${e(descripcion)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Asociacion La Generacion Mejor Preparada">
<meta property="og:locale" content="es_ES">
<meta property="og:title" content="${e(titulo)}">
<meta property="og:description" content="${e(descripcion)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${e(imagen || BASE + '/assets/og.jpg')}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(titulo)}">
<meta name="twitter:description" content="${e(descripcion)}">
<meta name="twitter:image" content="${e(imagen || BASE + '/assets/og.jpg')}">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="apple-touch-icon" href="/assets/favicon.png">
<meta name="theme-color" content="#1E2A4A">
<script type="application/ld+json">${JSON.stringify({ '@context':'https://schema.org', ...ld })}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900&family=Nunito+Sans:ital,wght@0,400;0,600;0,700;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/legal.css">
<style>
  .art{max-width:760px;margin:0 auto;padding:56px 28px 0}
  .art .kicker{font-family:'Nunito',sans-serif;font-weight:800;font-size:13px;letter-spacing:.14em;
               text-transform:uppercase;color:#F0503C;margin:0 0 14px}
  .art h1{font-family:'Nunito',sans-serif;font-weight:900;font-size:clamp(30px,4.6vw,44px);line-height:1.15;margin:0}
  .art .meta{font-size:14.5px;color:rgba(30,42,74,.6);margin:18px 0 0}
  .art .portada{width:100%;border-radius:20px;margin:32px 0 0;display:block}
  .cuerpo{max-width:760px;margin:0 auto;padding:8px 28px 0;font-size:17px;line-height:1.75;color:rgba(30,42,74,.85)}
  .cuerpo h2{font-family:'Nunito',sans-serif;font-weight:900;font-size:24px;color:#1E2A4A;margin:36px 0 12px}
  .cuerpo h3{font-family:'Nunito',sans-serif;font-weight:800;font-size:19px;color:#1E2A4A;margin:28px 0 10px}
  .cuerpo p{margin:0 0 18px}
  .cuerpo ul,.cuerpo ol{margin:0 0 18px;padding-left:24px}
  .cuerpo li{margin-bottom:8px}
  .cuerpo blockquote{margin:0 0 18px;padding:4px 0 4px 18px;border-left:3px solid #F0503C;
                     color:rgba(30,42,74,.75);font-style:italic}
  .cierre{max-width:760px;margin:0 auto;padding:14px 28px 0;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
  .volver{font-family:'Nunito',sans-serif;font-weight:700;font-size:15px}
  .apuntarse{background:#F0503C;color:#ffffff;font-family:'Nunito',sans-serif;font-weight:800;font-size:16px;
             padding:14px 32px;border-radius:999px;box-shadow:0 8px 24px rgba(240,80,60,.4);
             transition:transform .2s;display:inline-block}
  .apuntarse:hover{transform:translateY(-3px);color:#ffffff}
  @media (prefers-reduced-motion: reduce){ .apuntarse:hover{transform:none} }
</style>
</head>
<body>

<header class="cab">
  <div class="cont">
    <a href="/"><img src="/assets/logo-dark.webp" alt="Asociación La Generación Mejor Preparada"></a>
    <a class="volver" href="/actividades/" style="color:rgba(255,255,255,.75)">← Actividades</a>
  </div>
</header>

<main>
  <article>
    <div class="art">
      <p class="kicker">${e(kicker)}</p>
      <h1>${e(titulo)}</h1>
      <p class="meta">${e(meta.linea)}</p>
      ${imagen ? `<img class="portada" src="${e(imagen)}" alt="${e(titulo)}">` : ''}
    </div>
    <div class="cuerpo">${cuerpo || `<p>${e(descripcion)}</p>`}</div>
    <div class="cierre">
      ${cta || ''}
      <a class="volver" href="/actividades/">← Volver a Actividades</a>
    </div>
  </article>
</main>

<footer>
  <div class="cont">
    <span>© ${new Date().getFullYear()} Asociación La Generación Mejor Preparada · Región de Murcia</span>
    <nav>
      <a href="/aviso-legal/">Aviso legal</a>
      <a href="/privacidad/">Política de privacidad</a>
      <a href="/cookies/">Política de cookies</a>
    </nav>
  </div>
</footer>
<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "d88a51df730a44f1a2560b013dcca904"}'></script>
</body>
</html>
`;
}

/* ---------------------------------------------------------------------
   Tarjetas de los listados
   --------------------------------------------------------------------- */

function tarjetaEvento(ev) {
  const p = partes(ev.fecha);
  const detalle = [ev.lugar, ev.hora].filter(Boolean).join(' · ');
  return `
        <a href="/eventos/${e(ev.slug)}/" data-reveal="true" style="background:#ffffff;border:1px solid rgba(30,42,74,.07);border-radius:20px;padding:28px 32px;display:flex;align-items:center;gap:28px;flex-wrap:wrap;transition:transform .25s,box-shadow .25s;color:#1E2A4A" style-hover="transform:translateY(-4px);box-shadow:0 16px 34px rgba(30,42,74,.12);color:#1E2A4A">
          <div style="flex:none;width:84px;height:84px;border-radius:16px;background:#1E2A4A;color:#ffffff;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'Nunito',sans-serif">
            <span style="font-weight:900;font-size:28px;line-height:1">${p.dia}</span>
            <span style="font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.7)">${p.mes}</span>
          </div>
          <div style="flex:1;min-width:240px">
            <h3 style="font-family:'Nunito',sans-serif;font-weight:800;font-size:20px;color:#1E2A4A;margin:0 0 6px">${e(ev.titulo)}</h3>
            <p style="font-size:15px;line-height:1.6;color:rgba(30,42,74,.72);margin:0">${detalle ? e(detalle) + ' · ' : ''}${e(ev.descripcion || '')}</p>
          </div>
          <span style="flex:none;background:#F0503C;color:#ffffff;font-family:'Nunito',sans-serif;font-weight:800;font-size:15px;padding:12px 24px;border-radius:999px;box-shadow:0 6px 18px rgba(240,80,60,.35)">Ver más</span>
        </a>`;
}

function tarjetaNoticia(n) {
  const p = partes(n.fecha);
  return `
          <a href="/noticias/${e(n.slug)}/" data-reveal="true" style="background:#ffffff;border:1px solid rgba(30,42,74,.07);border-radius:20px;padding:28px;display:flex;flex-direction:column;gap:10px;transition:transform .25s,box-shadow .25s;color:#1E2A4A" style-hover="transform:translateY(-6px);box-shadow:0 18px 40px rgba(30,42,74,.14);color:#1E2A4A">
            <span style="font-family:'Nunito',sans-serif;font-weight:700;font-size:12.5px;letter-spacing:.1em;text-transform:uppercase;color:#F0503C">${p.dia} ${p.mes} ${p.anio}${n.categoria ? ' · ' + e(n.categoria) : ''}</span>
            <h3 style="font-family:'Nunito',sans-serif;font-weight:800;font-size:19px;line-height:1.3;color:#1E2A4A;margin:0">${e(n.titulo)}</h3>
            <p style="font-size:15px;line-height:1.6;color:rgba(30,42,74,.72);margin:0">${e(n.resumen || resumir(n.cuerpo, 120))}</p>
            <span style="font-family:'Nunito',sans-serif;font-weight:800;font-size:14.5px;color:#F0503C;margin-top:4px">Leer más →</span>
          </a>`;
}

function seccionNoticias(noticias) {
  if (!noticias.length) return '';
  return `
  <section class="lg-sec" id="noticias" style="background:#ffffff;padding:96px 0">
    <div class="lg-cont" style="max-width:1400px;margin:0 auto;padding:0 48px">
      <div data-reveal="true" style="text-align:left;margin-bottom:48px">
        <h2 style="font-family:'Nunito',sans-serif;font-weight:900;font-size:clamp(28px,3.4vw,42px);line-height:1.12;color:#1E2A4A;margin:0">Noticias</h2>
      </div>
      <div class="lg-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">${noticias.map(tarjetaNoticia).join('')}
      </div>
    </div>
  </section>
`;
}

/* ---------------------------------------------------------------------
   Utilidades de escritura
   --------------------------------------------------------------------- */

function entreMarcas(html, marca, contenido) {
  const ini = `<!--LGMP:${marca}:INICIO-->`, fin = `<!--LGMP:${marca}:FIN-->`;
  const a = html.indexOf(ini), b = html.indexOf(fin);
  if (a < 0 || b < 0) throw new Error(`Faltan las marcas ${marca} en actividades/index.html`);
  return html.slice(0, a + ini.length) + contenido + html.slice(b);
}

async function limpiarCarpeta(carpeta, slugsVivos) {
  const ruta = join(RAIZ, carpeta);
  if (!existsSync(ruta)) return [];
  const borrados = [];
  for (const d of await readdir(ruta, { withFileTypes: true })) {
    if (d.isDirectory() && !slugsVivos.has(d.name)) {
      await rm(join(ruta, d.name), { recursive: true, force: true });
      borrados.push(`${carpeta}/${d.name}`);
    }
  }
  return borrados;
}

/* --------------------------------------------------------------------- */

async function main() {
  const eventos  = await traer('eventos',  'fecha.desc');
  const noticias = await traer('noticias', 'fecha.desc');
  console.log(`Publicados: ${eventos.length} eventos, ${noticias.length} noticias`);

  const escritas = [];

  for (const ev of eventos) {
    if (!ev.slug) { console.warn(`  evento ${ev.id} sin slug, se salta`); continue; }
    const url = `${BASE}/eventos/${ev.slug}/`;
    const desc = ev.descripcion || resumir(ev.cuerpo) || ev.titulo;
    const detalle = [fechaLarga(ev.fecha), ev.hora, ev.lugar].filter(Boolean).join(' · ');
    const cta = ev.url_inscripcion
      ? `<a class="apuntarse" href="${e(ev.url_inscripcion)}">Apúntate</a>` : '';
    await mkdir(join(RAIZ, 'eventos', ev.slug), { recursive: true });
    await writeFile(join(RAIZ, 'eventos', ev.slug, 'index.html'),
      pagina({ tipo:'evento', titulo:ev.titulo, descripcion:desc, url, kicker:'Evento',
               meta:{ linea:detalle, fecha:ev.fecha, lugar:ev.lugar },
               cuerpo:aHtml(ev.cuerpo), cta }));
    escritas.push(`/eventos/${ev.slug}/`);
  }

  for (const n of noticias) {
    if (!n.slug) { console.warn(`  noticia ${n.id} sin slug, se salta`); continue; }
    const url = `${BASE}/noticias/${n.slug}/`;
    const desc = n.resumen || resumir(n.cuerpo) || n.titulo;
    const linea = [fechaLarga(n.fecha), n.categoria, n.autor].filter(Boolean).join(' · ');
    const cta = n.url
      ? `<a class="apuntarse" href="${e(n.url)}" target="_blank" rel="noopener">Leer la noticia original</a>` : '';
    await mkdir(join(RAIZ, 'noticias', n.slug), { recursive: true });
    await writeFile(join(RAIZ, 'noticias', n.slug, 'index.html'),
      pagina({ tipo:'noticia', titulo:n.titulo, descripcion:desc, url,
               kicker: n.categoria || 'Noticia',
               meta:{ linea, fecha:n.fecha, autor:n.autor },
               cuerpo:aHtml(n.cuerpo), imagen:n.imagen_url, cta }));
    escritas.push(`/noticias/${n.slug}/`);
  }

  // Fuera las páginas de lo que se haya despublicado o borrado
  const borradas = [
    ...await limpiarCarpeta('eventos',  new Set(eventos.map(x => x.slug))),
    ...await limpiarCarpeta('noticias', new Set(noticias.map(x => x.slug)))
  ];

  // Listados de /actividades/
  const act = join(RAIZ, 'actividades', 'index.html');
  let html = await readFile(act, 'utf8');
  html = entreMarcas(html, 'EVENTOS',
    eventos.length ? eventos.map(tarjetaEvento).join('') + '\n      '
                   : '\n        <p style="font-size:16px;color:rgba(30,42,74,.7);margin:0">Estamos preparando las próximas actividades. Te las contamos en cuanto haya fecha.</p>\n      ');
  html = entreMarcas(html, 'NOTICIAS', seccionNoticias(noticias));
  await writeFile(act, html);

  // Sitemap
  const FIJAS = ['/', '/actividades/', '/socios/', '/podcast/', '/hazte-socio/', '/contacto/',
                 '/presentacion/', '/alta-socio/', '/alta-entidad/', '/aviso-legal/',
                 '/privacidad/', '/cookies/'];
  const PRIORIDAD = { '/':'1.0', '/hazte-socio/':'0.9', '/presentacion/':'0.9',
                      '/actividades/':'0.8', '/podcast/':'0.8', '/socios/':'0.7', '/contacto/':'0.7' };
  const hoy = new Date().toISOString().slice(0, 10);
  const url = r => `  <url>\n    <loc>${BASE}${r}</loc>\n    <lastmod>${hoy}</lastmod>\n    <priority>${PRIORIDAD[r] || (r.startsWith('/noticias/') || r.startsWith('/eventos/') ? '0.6' : '0.4')}</priority>\n  </url>`;
  await writeFile(join(RAIZ, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + FIJAS.concat(escritas).map(url).join('\n') + '\n</urlset>\n');

  console.log(`Páginas escritas: ${escritas.length}`);
  escritas.forEach(r => console.log('  +', r));
  borradas.forEach(r => console.log('  -', r, '(ya no está publicado)'));
  console.log(`Sitemap: ${FIJAS.length + escritas.length} URLs`);
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
