/* =====================================================================
   LGMP · Acceso a datos (Supabase)

   Único sitio de toda la web donde viven la URL del proyecto y la clave
   anon. Si algún día cambian, se cambian aquí y ya está.

   Las dos son PÚBLICAS por diseño: viajan en el HTML de una web abierta.
   No dan acceso a nada: la clave anon no puede escribir en ninguna tabla
   ni leer datos personales (lo impide Row Level Security). Los envíos
   entran por la Edge Function `enviar-formulario`, que es la única puerta.

   Se carga con <script src="/lgmp-datos.js"></script> antes de usarla.
   ===================================================================== */
(function () {
  'use strict';

  var SUPABASE_URL      = 'PEGA_AQUI_EL_PROJECT_URL';   // https://xxxxxxxx.supabase.co
  var SUPABASE_ANON_KEY = 'PEGA_AQUI_LA_CLAVE_ANON';

  var CORREO = 'hola@lageneracionmejorpreparada.com';
  var SIN_CONFIGURAR = SUPABASE_URL.indexOf('PEGA_AQUI') === 0;

  if (SIN_CONFIGURAR) {
    console.error('[LGMP] Falta configurar SUPABASE_URL y SUPABASE_ANON_KEY en /lgmp-datos.js');
  }

  function cabeceras() {
    return {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
    };
  }

  /**
   * Envía un formulario a la Edge Function.
   *
   * @param {string} tipo   contacto | alta-socio | alta-entidad |
   *                        inscripcion-evento | newsletter
   * @param {object} datos  campos del formulario, ya con los nombres de la tabla
   * @param {string} trampa contenido del honeypot (debe llegar vacío)
   * @returns {Promise} se resuelve si ha ido bien; si no, rechaza con un
   *                    Error cuyo mensaje se puede enseñar tal cual.
   */
  function enviar(tipo, datos, trampa) {
    if (SIN_CONFIGURAR) {
      return Promise.reject(new Error(
        'El formulario no está disponible ahora mismo. Escríbenos a ' + CORREO + ' y te atendemos.'
      ));
    }

    return fetch(SUPABASE_URL + '/functions/v1/enviar-formulario', {
      method: 'POST',
      headers: cabeceras(),
      body: JSON.stringify({ tipo: tipo, datos: datos, trampa: trampa || '' })
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (cuerpo) {
          if (r.ok && cuerpo && cuerpo.ok) return true;
          throw new Error(
            (cuerpo && cuerpo.error) ||
            'No hemos podido enviar el formulario. Escríbenos a ' + CORREO + ' y lo resolvemos.'
          );
        });
      }, function () {
        throw new Error(
          'No hemos podido conectar. Revisa tu conexión o escríbenos a ' + CORREO + '.'
        );
      });
  }

  /**
   * Número de socios activos, desde la función contar_socios() de la base
   * de datos. Si falla, devuelve null y quien llama decide qué enseñar.
   * @returns {Promise<number|null>}
   */
  function contarSocios() {
    if (SIN_CONFIGURAR) return Promise.resolve(null);

    return fetch(SUPABASE_URL + '/rest/v1/rpc/contar_socios', {
      method: 'POST',
      headers: cabeceras(),
      body: '{}'
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (n) { return typeof n === 'number' ? n : null; })
      .catch(function () { return null; });
  }

  window.LGMP = {
    configurado: !SIN_CONFIGURAR,
    correo: CORREO,
    enviar: enviar,
    contarSocios: contarSocios
  };
})();
