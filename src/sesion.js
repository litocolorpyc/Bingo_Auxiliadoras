const crypto = require('node:crypto');

// Sesión sin estado en servidor: cookie "expiración.firma". Vercel no comparte memoria entre funciones.
const DURACION_MS = 12 * 60 * 60 * 1000;

function secretoDe(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (!env.ADMIN_PASSWORD) throw new Error('Falta ADMIN_PASSWORD en las variables de entorno.');
  return crypto.createHash('sha256').update('bingo-sesion:' + env.ADMIN_PASSWORD).digest('hex');
}

const firmar = (exp, secreto) => crypto.createHmac('sha256', secreto).update(String(exp)).digest('hex');

function crearToken(secreto) {
  const exp = Date.now() + DURACION_MS;
  return `${exp}.${firmar(exp, secreto)}`;
}

function tokenValido(token, secreto) {
  const [exp, firma] = String(token || '').split('.');
  if (!exp || !firma || Number(exp) < Date.now()) return false;
  const esperada = firmar(exp, secreto);
  return firma.length === esperada.length && crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
}

function cookieDe(req) {
  return (req.headers.cookie || '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
}

function claveCorrecta(intento, clave) {
  // Comparar hashes evita diferencias de longitud y tiempos filtrados.
  const h = s => crypto.createHash('sha256').update(String(s ?? '')).digest();
  return crypto.timingSafeEqual(h(intento), h(clave));
}

module.exports = { secretoDe, crearToken, tokenValido, cookieDe, claveCorrecta, DURACION_MS };
