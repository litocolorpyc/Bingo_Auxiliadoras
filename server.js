const crypto = require('node:crypto');
const path = require('node:path');
const { abrirBase } = require('./src/db');
const { crearServicios } = require('./src/servicios');
const { crearWhatsApp } = require('./src/whatsapp');
const { crearApp } = require('./src/app');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 3000);
const CODIGO_PAIS = process.env.CODIGO_PAIS || '58';

const db = abrirBase(path.join(DATA, 'bingo.db'));
const whatsapp = crearWhatsApp({
  token: process.env.WHATSAPP_TOKEN,
  phoneId: process.env.WHATSAPP_PHONE_ID,
  plantilla: process.env.WHATSAPP_PLANTILLA,
  codigoPais: CODIGO_PAIS,
});
const servicios = crearServicios({ db, whatsapp, codigoPais: CODIGO_PAIS });

let adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  adminPassword = crypto.randomBytes(9).toString('base64url');
  console.warn(`ADMIN_PASSWORD no está definida. Contraseña temporal para esta sesión: ${adminPassword}`);
}

const app = crearApp({
  servicios,
  uploadsDir: path.join(DATA, 'comprobantes'),
  adminPassword,
  publicDir: path.join(__dirname, 'public'),
});

app.listen(PORT, () => {
  console.log(`Bingo en http://localhost:${PORT}  (administración en /admin.html)`);
  if (!whatsapp.configurado) console.log('WhatsApp no configurado: las tablas se envían con enlace manual.');
});
