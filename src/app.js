const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { ErrorApp } = require('./servicios');

const TIPOS_PERMITIDOS = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
};
const MAX_BYTES = 10 * 1024 * 1024;
const SESION_MS = 12 * 60 * 60 * 1000;

function crearApp({ servicios, uploadsDir, adminPassword, publicDir }) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(publicDir));

  const subida = multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + '.' + (TIPOS_PERMITIDOS[file.mimetype] || 'bin')),
    }),
    limits: { fileSize: MAX_BYTES, files: 3 },
    fileFilter: (_req, file, cb) => {
      if (!TIPOS_PERMITIDOS[file.mimetype]) return cb(new ErrorApp('Solo se admiten imágenes o PDF como comprobante.'));
      cb(null, true);
    },
  });

  function borrarArchivos(files = []) {
    for (const f of files) fs.rm(f.path, { force: true }, () => {});
  }

  // ---------- Sesión de administración ----------
  const sesiones = new Map();

  function sesionValida(token) {
    const exp = sesiones.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      sesiones.delete(token);
      return false;
    }
    return true;
  }

  function requerirAdmin(req, _res, next) {
    const token = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]+)/)?.[1];
    if (!token || !sesionValida(token)) return next(new ErrorApp('Inicia sesión como administración.', 401));
    next();
  }

  function claveCorrecta(intento) {
    const a = Buffer.from(String(intento ?? ''));
    const b = Buffer.from(adminPassword);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Limita intentos de contraseña por IP para frenar adivinación.
  const intentos = new Map();
  function limitarLogin(req, _res, next) {
    const ip = req.ip;
    const r = intentos.get(ip) || { n: 0, desde: Date.now() };
    if (Date.now() - r.desde > 15 * 60 * 1000) { r.n = 0; r.desde = Date.now(); }
    if (r.n >= 10) return next(new ErrorApp('Demasiados intentos. Espera 15 minutos.', 429));
    intentos.set(ip, r);
    req.intentos = r;
    next();
  }

  // ---------- Públicas ----------
  app.get('/api/evento', (_req, res) => {
    const e = servicios.evento();
    res.json({ nombre: e.nombre, precioTabla: e.precioTabla, moneda: e.moneda, fechaSorteo: e.fechaSorteo, cuentasPago: e.cuentasPago, abierto: e.precioTabla > 0 });
  });

  app.post('/api/compras', subida.array('comprobantes', 3), (req, res, next) => {
    const archivos = req.files || [];
    try {
      const comprobantes = archivos.map(f => ({ archivo: f.filename, nombre: f.originalname.slice(0, 120), tipo: f.mimetype }));
      const r = servicios.crearCompra(req.body, comprobantes);
      res.status(201).json(r);
    } catch (err) {
      borrarArchivos(archivos);
      next(err);
    }
  });

  app.get('/api/compras/:codigo/estado', (req, res, next) => {
    try { res.json(servicios.estadoPublico(req.params.codigo)); } catch (err) { next(err); }
  });

  // ---------- Administración ----------
  app.post('/api/admin/login', limitarLogin, (req, res, next) => {
    if (!claveCorrecta(req.body?.clave)) {
      req.intentos.n++;
      return next(new ErrorApp('Contraseña incorrecta.', 401));
    }
    req.intentos.n = 0;
    const token = crypto.randomBytes(32).toString('hex');
    sesiones.set(token, Date.now() + SESION_MS);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESION_MS / 1000}`);
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    const token = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]+)/)?.[1];
    if (token) sesiones.delete(token);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  const admin = express.Router();
  admin.use(requerirAdmin);

  admin.get('/resumen', (_req, res) => res.json(servicios.resumen()));
  admin.get('/bitacora', (_req, res) => res.json(servicios.bitacoraLista()));

  admin.get('/compras', (req, res) => res.json(servicios.listarCompras({ estado: req.query.estado })));
  admin.get('/compras/:id', (req, res, next) => {
    try { res.json(servicios.detalleCompra(Number(req.params.id))); } catch (err) { next(err); }
  });
  admin.post('/compras/:id/pagos', (req, res, next) => {
    try { res.json(servicios.registrarPagoManual(Number(req.params.id), req.body)); } catch (err) { next(err); }
  });
  admin.post('/compras/:id/enviar', async (req, res, next) => {
    try { res.json(await servicios.enviarTablas(Number(req.params.id))); } catch (err) { next(err); }
  });
  admin.post('/compras/:id/reenviar', async (req, res, next) => {
    try { res.json(await servicios.reenviarWhatsapp(Number(req.params.id))); } catch (err) { next(err); }
  });
  admin.get('/compras/:id/enlace-whatsapp', (req, res, next) => {
    try { res.json({ enlace: servicios.enlaceWhatsapp(Number(req.params.id)) }); } catch (err) { next(err); }
  });
  admin.post('/compras/:id/envio-manual', (req, res, next) => {
    try { res.json(servicios.marcarEnviadoManual(Number(req.params.id))); } catch (err) { next(err); }
  });
  admin.post('/compras/:id/rechazar', (req, res, next) => {
    try { res.json(servicios.rechazarCompra(Number(req.params.id))); } catch (err) { next(err); }
  });

  admin.post('/pagos/:id/verificar', (req, res, next) => {
    try {
      const compra = servicios.verificarPago(Number(req.params.id), req.body?.montoVerificado);
      res.json(compra);
    } catch (err) { next(err); }
  });
  admin.post('/pagos/:id/rechazar', (req, res, next) => {
    try { res.json(servicios.rechazarPago(Number(req.params.id))); } catch (err) { next(err); }
  });
  admin.get('/pagos/:id/comprobante', (req, res, next) => {
    try {
      const pago = servicios.pagoConComprobante(Number(req.params.id));
      const ruta = path.join(uploadsDir, path.basename(pago.comprobante_archivo));
      res.type(pago.comprobante_tipo);
      res.setHeader('Content-Disposition', `inline; filename="${pago.comprobante_nombre.replace(/[^\w.\- ]/g, '_')}"`);
      res.sendFile(ruta, err => { if (err && !res.headersSent) next(new ErrorApp('Comprobante no encontrado.', 404)); });
    } catch (err) { next(err); }
  });

  admin.put('/evento', (req, res, next) => {
    try { res.json(servicios.actualizarEvento(req.body)); } catch (err) { next(err); }
  });
  admin.post('/tablas/generar', (req, res, next) => {
    try { res.json(servicios.generarTablas(req.body?.cantidad)); } catch (err) { next(err); }
  });
  admin.post('/tablas/importar', (req, res, next) => {
    try { res.json(servicios.importarTablas(req.body?.seriales)); } catch (err) { next(err); }
  });

  admin.get('/tablas', (_req, res) => res.json(servicios.listarTablas()));

  admin.get('/premios', (_req, res) => res.json(servicios.listarPremios()));
  admin.post('/premios', (req, res, next) => {
    try { res.status(201).json(servicios.crearPremio(req.body)); } catch (err) { next(err); }
  });
  admin.put('/premios/:id/ganador', (req, res, next) => {
    try { res.json(servicios.asignarGanador(Number(req.params.id), req.body?.serial)); } catch (err) { next(err); }
  });
  admin.delete('/premios/:id/ganador', (req, res, next) => {
    try { res.json(servicios.quitarGanador(Number(req.params.id))); } catch (err) { next(err); }
  });
  admin.post('/premios/:id/pagar', (req, res, next) => {
    try { res.json(servicios.pagarPremio(Number(req.params.id))); } catch (err) { next(err); }
  });

  admin.get('/gastos', (_req, res) => res.json(servicios.listarGastos()));
  admin.post('/gastos', (req, res, next) => {
    try { res.status(201).json(servicios.crearGasto(req.body)); } catch (err) { next(err); }
  });
  admin.delete('/gastos/:id', (req, res, next) => {
    try { res.json(servicios.eliminarGasto(Number(req.params.id))); } catch (err) { next(err); }
  });

  admin.get('/reportes/:nombre', (req, res, next) => {
    try {
      const nombre = req.params.nombre.replace(/\.csv$/, '');
      const { encabezados, filas } = servicios.reporte(nombre);
      const celda = v => {
        let s = v == null ? '' : String(v);
        if (/^[=+\-@]/.test(s)) s = "'" + s;
        return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = '﻿' + [encabezados, ...filas].map(f => f.map(celda).join(',')).join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nombre}-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (err) { next(err); }
  });

  app.use('/api/admin', admin);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado.' }));

  // Manejo de errores: multer y validaciones devuelven mensaje claro; lo demás se registra.
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      const mensaje = err.code === 'LIMIT_FILE_SIZE' ? 'Cada comprobante debe pesar menos de 10 MB.' : 'Demasiados archivos o campo inesperado.';
      return res.status(400).json({ error: mensaje });
    }
    if (err instanceof ErrorApp) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos inválidos.' });
    console.error(err);
    res.status(500).json({ error: 'Error interno. Revisa la bitácora del servidor.' });
  });

  return app;
}

module.exports = { crearApp };
