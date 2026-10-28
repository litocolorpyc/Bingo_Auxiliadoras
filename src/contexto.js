const { desdePool } = require('./db');
const { crearServicios } = require('./servicios');
const { crearWhatsApp } = require('./whatsapp');
const { crearStorage } = require('./storage');

// Vercel reutiliza la instancia entre peticiones cercanas: se crea una sola vez por función.
let ctx;

function obtenerContexto(env = process.env) {
  if (ctx) return ctx;
  if (!env.DATABASE_URL) throw new Error('Falta DATABASE_URL en las variables de entorno.');
  const db = desdePool(env.DATABASE_URL);
  const whatsapp = crearWhatsApp({
    token: env.WHATSAPP_TOKEN,
    phoneId: env.WHATSAPP_PHONE_ID,
    plantilla: env.WHATSAPP_PLANTILLA,
    codigoPais: env.CODIGO_PAIS || '58',
  });
  const storage = crearStorage({
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: env.SUPABASE_BUCKET || 'comprobantes',
  });
  const servicios = crearServicios({ db, whatsapp });
  ctx = { db, whatsapp, storage, servicios, env };
  return ctx;
}

module.exports = { obtenerContexto };
