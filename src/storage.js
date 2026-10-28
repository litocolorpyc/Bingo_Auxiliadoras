const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

const EXTENSIONES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const RUTA_VALIDA = /^[a-f0-9]{32}\.(png|jpg|gif|webp|pdf)$/;
const LECTURA_SEGUNDOS = 300;

// Los comprobantes se suben directo desde el navegador con una URL firmada.
// Así el archivo no pasa por la función de Vercel (límite de 4.5 MB por petición).
function crearStorage({ url, serviceKey, bucket = 'comprobantes' }) {
  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const b = sb.storage.from(bucket);

  return {
    extensionPara: tipo => EXTENSIONES[tipo] || null,
    rutaValida: ruta => RUTA_VALIDA.test(String(ruta || '')),

    async firmarSubida(tipo) {
      const ext = EXTENSIONES[tipo];
      if (!ext) throw new Error('Tipo de archivo no permitido.');
      const ruta = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
      const { data, error } = await b.createSignedUploadUrl(ruta);
      if (error) throw error;
      return { ruta, url: data.signedUrl };
    },

    async existe(ruta) {
      const { error } = await b.info(ruta);
      return !error;
    },

    async urlLectura(ruta) {
      const { data, error } = await b.createSignedUrl(ruta, LECTURA_SEGUNDOS);
      if (error) throw error;
      return data.signedUrl;
    },
  };
}

module.exports = { crearStorage };
