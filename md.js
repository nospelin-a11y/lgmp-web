/* =====================================================================
   LGMP · Markdown mínimo

   Lo usan dos sitios y por eso vive aquí: el panel, para la vista previa,
   y el generador de páginas. Una sola implementación, así lo que se ve al
   escribir es exactamente lo que se publica.

   Escapa el HTML ANTES de convertir. El texto que escribe la junta se
   guarda tal cual en la base de datos, así que nada de lo que teclee
   puede acabar ejecutándose en la web.
   ===================================================================== */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapar = t => String(t ?? '').replace(/[&<>"]/g, c => ESCAPES[c]);

/* Enlaces sí, pero solo http(s), mailto y rutas internas: nada de
   javascript: ni data:. */
function urlSegura(u) {
  const limpia = u.trim();
  return /^(https?:\/\/|mailto:|\/)/i.test(limpia) ? limpia : '#';
}

function enLinea(t) {
  return t
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_, txt, url) => `<a href="${urlSegura(url)}"${/^https?:/i.test(url) ? ' target="_blank" rel="noopener"' : ''}>${txt}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

export function aHtml(texto) {
  if (!texto || !String(texto).trim()) return '';
  const lineas = escapar(texto).replace(/\r\n?/g, '\n').split('\n');
  const salida = [];
  let lista = null;      // 'ul' | 'ol' | null
  let parrafo = [];

  const cerrarParrafo = () => {
    if (parrafo.length) {
      salida.push('<p>' + enLinea(parrafo.join(' ')) + '</p>');
      parrafo = [];
    }
  };
  const cerrarLista = () => {
    if (lista) { salida.push(`</${lista}>`); lista = null; }
  };

  for (const cruda of lineas) {
    const l = cruda.trim();

    if (!l) { cerrarParrafo(); cerrarLista(); continue; }

    const enc = l.match(/^(#{2,3})\s+(.*)$/);
    if (enc) {
      cerrarParrafo(); cerrarLista();
      const n = enc[1].length;
      salida.push(`<h${n}>${enLinea(enc[2])}</h${n}>`);
      continue;
    }

    const cita = l.match(/^&gt;\s?(.*)$/);
    if (cita) {
      cerrarParrafo(); cerrarLista();
      salida.push(`<blockquote>${enLinea(cita[1])}</blockquote>`);
      continue;
    }

    const vinieta = l.match(/^[-*]\s+(.*)$/);
    const numerada = l.match(/^\d+[.)]\s+(.*)$/);
    if (vinieta || numerada) {
      cerrarParrafo();
      const tipo = vinieta ? 'ul' : 'ol';
      if (lista !== tipo) { cerrarLista(); salida.push(`<${tipo}>`); lista = tipo; }
      salida.push(`<li>${enLinea((vinieta || numerada)[1])}</li>`);
      continue;
    }

    cerrarLista();
    parrafo.push(l);
  }
  cerrarParrafo();
  cerrarLista();
  return salida.join('\n');
}

/* Primeras palabras en texto plano: sirve para la meta description
   cuando no se ha escrito un resumen. */
export function resumir(texto, max = 155) {
  const plano = String(texto ?? '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*>`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (plano.length <= max) return plano;
  return plano.slice(0, max).replace(/\s+\S*$/, '') + '…';
}
