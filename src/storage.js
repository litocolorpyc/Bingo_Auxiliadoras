const { Readable } = require('node:stream');
const { get, head } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');

const TIPOS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'];
const TAMANO_MAX = 10 * 1024 * 1024;
const RUTA_VALIDA = /^comprobantes\/[A-Za-z0-9._-]+\.(png|jpg|gif|webp|pdf)$/;

// Comprobantes en Vercel Blob privado. El navegador sube directo con un token que emite handleUpload,
// así el archivo no pasa por la función (límite de 4.5 MB por petición).
function crearStorage() {
  return {
    tipoPermitido: tipo => TIPOS.includes(tipo),
    rutaValida: ruta => RUTA_VALIDA.test(String(ruta || '')),

    // body: cuerpo JSON que envía el cliente de upload; request: la petición HTTP.
    generarToken(request, body) {
      return handleUpload({
        request,
        body,
        onBeforeGenerateToken: async pathname => {
          if (!RUTA_VALIDA.test(pathname)) throw new Error('Ruta de comprobante no permitida.');
          return {
            allowedContentTypes: TIPOS,
            maximumSizeInBytes: TAMANO_MAX,
            addRandomSuffix: true,
          };
        },
        onUploadCompleted: async () => {},
      });
    },

    async existe(ruta) {
      try {
        await head(ruta, { access: 'private' });
        return true;
      } catch {
        return false;
      }
    },

    // Devuelve { stream, tipo } para que la función lo entregue al panel, o null si no existe.
    async leer(ruta) {
      try {
        const r = await get(ruta, { access: 'private' });
        if (!r || r.statusCode !== 200) return null;
        const stream = typeof r.stream.pipe === 'function' ? r.stream : Readable.fromWeb(r.stream);
        return { stream, tipo: r.blob.contentType };
      } catch {
        return null;
      }
    },
  };
}

module.exports = { crearStorage, TIPOS };
