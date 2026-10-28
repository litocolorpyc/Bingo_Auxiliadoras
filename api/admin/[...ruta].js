const { obtenerContexto } = require('../../src/contexto');
const { enrutar, responderError } = require('../../src/http');
const { ErrorApp } = require('../../src/servicios');
const sesion = require('../../src/sesion');

const MAX_INTENTOS = 10;
const VENTANA_MS = 15 * 60 * 1000;

// Protege las rutas de administración con cookie firmada y limita intentos de contraseña por IP.
module.exports = async (req, res) => {
  try {
    const { servicios, storage, db, env } = obtenerContexto();
    const secreto = sesion.secretoDe(env);

    const requerirSesion = () => {
      if (!sesion.tokenValido(sesion.cookieDe(req), secreto)) throw new ErrorApp('Inicia sesión como administración.', 401);
    };
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'desconocida').split(',')[0].trim();
    const id = ([v]) => Number(v);
    const admin = fn => async (params, req, res) => { requerirSesion(); return fn(params, req, res); };

    const rutas = [
      {
        metodo: 'POST', patron: /^\/login$/,
        handler: async (_p, req, res) => {
          const desde = new Date(Date.now() - VENTANA_MS).toISOString();
          const [{ n }] = await db.query('SELECT COUNT(*)::int AS n FROM login_intentos WHERE ip = $1 AND fecha > $2', [ip, desde]);
          if (n >= MAX_INTENTOS) throw new ErrorApp('Demasiados intentos. Espera 15 minutos.', 429);
          if (!sesion.claveCorrecta(req.body?.clave, env.ADMIN_PASSWORD)) {
            await db.query('INSERT INTO login_intentos (ip, fecha) VALUES ($1, $2)', [ip, new Date().toISOString()]);
            throw new ErrorApp('Contraseña incorrecta.', 401);
          }
          const token = sesion.crearToken(secreto);
          res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${sesion.DURACION_MS / 1000}`);
          res.status(200).json({ ok: true });
        },
      },
      {
        metodo: 'POST', patron: /^\/logout$/,
        handler: async (_p, req, res) => {
          res.setHeader('Set-Cookie', 'sid=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
          res.status(200).json({ ok: true });
        },
      },
      { metodo: 'GET', patron: /^\/resumen$/, handler: admin(async (_p, _req, res) => res.json(await servicios.resumen())) },
      { metodo: 'GET', patron: /^\/bitacora$/, handler: admin(async (_p, _req, res) => res.json(await servicios.bitacoraLista())) },

      { metodo: 'GET', patron: /^\/compras$/, handler: admin(async (_p, req, res) => res.json(await servicios.listarCompras({ estado: req.query.estado }))) },
      { metodo: 'GET', patron: /^\/compras\/(\d+)$/, handler: admin(async (p, req, res) => res.json(await servicios.detalleCompra(id(p)))) },
      { metodo: 'POST', patron: /^\/compras\/(\d+)\/pagos$/, handler: admin(async (p, req, res) => res.json(await servicios.registrarPagoManual(id(p), req.body || {}))) },
      { metodo: 'POST', patron: /^\/compras\/(\d+)\/enviar$/, handler: admin(async (p, req, res) => res.json(await servicios.enviarTablas(id(p)))) },
      { metodo: 'POST', patron: /^\/compras\/(\d+)\/reenviar$/, handler: admin(async (p, req, res) => res.json(await servicios.reenviarWhatsapp(id(p)))) },
      { metodo: 'GET', patron: /^\/compras\/(\d+)\/enlace-whatsapp$/, handler: admin(async (p, req, res) => res.json({ enlace: await servicios.enlaceWhatsapp(id(p)) })) },
      { metodo: 'POST', patron: /^\/compras\/(\d+)\/envio-manual$/, handler: admin(async (p, req, res) => res.json(await servicios.marcarEnviadoManual(id(p)))) },
      { metodo: 'POST', patron: /^\/compras\/(\d+)\/rechazar$/, handler: admin(async (p, req, res) => res.json(await servicios.rechazarCompra(id(p)))) },

      { metodo: 'POST', patron: /^\/pagos\/(\d+)\/verificar$/, handler: admin(async (p, req, res) => res.json(await servicios.verificarPago(id(p), req.body?.montoVerificado))) },
      { metodo: 'POST', patron: /^\/pagos\/(\d+)\/rechazar$/, handler: admin(async (p, req, res) => res.json(await servicios.rechazarPago(id(p)))) },

      {
        // Entrega el archivo privado al panel (la cookie de sesión autoriza la descarga).
        metodo: 'GET', patron: /^\/comprobantes\/(\d+)\/archivo$/,
        handler: admin(async (p, req, res) => {
          const c = await servicios.comprobanteDe(id(p));
          const archivo = await storage.leer(c.ruta);
          if (!archivo) throw new ErrorApp('El archivo ya no está disponible.', 404);
          res.setHeader('Content-Type', archivo.tipo || c.tipo);
          res.setHeader('Content-Disposition', 'inline');
          archivo.stream.pipe(res);
        }),
      },

      { metodo: 'PUT', patron: /^\/evento$/, handler: admin(async (_p, req, res) => res.json(await servicios.actualizarEvento(req.body || {}))) },
      { metodo: 'POST', patron: /^\/tablas\/generar$/, handler: admin(async (_p, req, res) => res.json(await servicios.generarTablas(req.body?.cantidad))) },
      { metodo: 'POST', patron: /^\/tablas\/importar$/, handler: admin(async (_p, req, res) => res.json(await servicios.importarTablas(req.body?.seriales))) },
      { metodo: 'GET', patron: /^\/tablas$/, handler: admin(async (_p, _req, res) => res.json(await servicios.listarTablas())) },

      { metodo: 'GET', patron: /^\/premios$/, handler: admin(async (_p, _req, res) => res.json(await servicios.listarPremios())) },
      { metodo: 'POST', patron: /^\/premios$/, handler: admin(async (_p, req, res) => res.status(201).json(await servicios.crearPremio(req.body || {}))) },
      { metodo: 'PUT', patron: /^\/premios\/(\d+)\/ganador$/, handler: admin(async (p, req, res) => res.json(await servicios.asignarGanador(id(p), req.body?.serial))) },
      { metodo: 'DELETE', patron: /^\/premios\/(\d+)\/ganador$/, handler: admin(async (p, req, res) => res.json(await servicios.quitarGanador(id(p)))) },
      { metodo: 'POST', patron: /^\/premios\/(\d+)\/pagar$/, handler: admin(async (p, req, res) => res.json(await servicios.pagarPremio(id(p)))) },

      { metodo: 'GET', patron: /^\/gastos$/, handler: admin(async (_p, _req, res) => res.json(await servicios.listarGastos())) },
      { metodo: 'POST', patron: /^\/gastos$/, handler: admin(async (_p, req, res) => res.status(201).json(await servicios.crearGasto(req.body || {}))) },
      { metodo: 'DELETE', patron: /^\/gastos\/(\d+)$/, handler: admin(async (p, req, res) => res.json(await servicios.eliminarGasto(id(p)))) },

      {
        metodo: 'GET', patron: /^\/reportes\/([a-z]+)\.csv$/,
        handler: admin(async ([nombre], _req, res) => {
          const { encabezados, filas } = await servicios.reporte(nombre);
          const celda = v => {
            let s = v == null ? '' : String(v);
            if (/^[=+\-@]/.test(s)) s = "'" + s;
            return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          };
          const csv = '﻿' + [encabezados, ...filas].map(f => f.map(celda).join(',')).join('\r\n');
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${nombre}-${new Date().toISOString().slice(0, 10)}.csv"`);
          res.status(200).send(csv);
        }),
      },
    ];
    await enrutar(rutas, req, res);
  } catch (err) {
    responderError(res, err);
  }
};
