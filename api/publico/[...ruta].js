const { obtenerContexto } = require('../../src/contexto');
const { enrutar, responderError } = require('../../src/http');
const { ErrorApp } = require('../../src/servicios');

// Rutas públicas: evento, subida de comprobantes, compra y consulta de estado.
module.exports = async (req, res) => {
  try {
    const { servicios, storage } = obtenerContexto();
    const rutas = [
      {
        metodo: 'GET', patron: /^\/evento$/,
        handler: async (_p, _req, res) => {
          const e = await servicios.evento();
          res.status(200).json({
            nombre: e.nombre, precioTabla: e.precioTabla, moneda: e.moneda,
            fechaSorteo: e.fechaSorteo, cuentasPago: e.cuentasPago, abierto: e.precioTabla > 0,
          });
        },
      },
      {
        // Devuelve una URL firmada para subir el archivo con PUT desde el navegador.
        metodo: 'POST', patron: /^\/comprobantes\/firmar$/,
        handler: async (_p, req, res) => {
          if (!storage.extensionPara(req.body?.tipo)) throw new ErrorApp('Solo se admiten imágenes o PDF como comprobante.');
          res.status(200).json(await storage.firmarSubida(req.body.tipo));
        },
      },
      {
        metodo: 'POST', patron: /^\/compras$/,
        handler: async (_p, req, res) => {
          const cuerpo = req.body || {};
          const comprobantes = Array.isArray(cuerpo.comprobantes) ? cuerpo.comprobantes.slice(0, 3) : [];
          for (const c of comprobantes) {
            if (!storage.rutaValida(c.ruta) || !(await storage.existe(c.ruta))) {
              throw new ErrorApp('Uno de los comprobantes no se subió correctamente. Vuelve a intentarlo.');
            }
            if (!storage.extensionPara(c.tipo)) throw new ErrorApp('Tipo de comprobante no permitido.');
          }
          const r = await servicios.crearCompra(cuerpo, comprobantes);
          res.status(201).json(r);
        },
      },
      {
        metodo: 'GET', patron: /^\/compras\/([A-Za-z0-9-]+)$/,
        handler: async ([codigo], _req, res) => res.status(200).json(await servicios.estadoPublico(codigo)),
      },
    ];
    await enrutar(rutas, req, res);
  } catch (err) {
    responderError(res, err);
  }
};
