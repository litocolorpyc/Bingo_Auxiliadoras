const crypto = require('node:crypto');

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_TABLAS_POR_COMPRA = 50;
const MAX_TABLAS_LOTE = 500;
const LOCK_VENTAS = 7001;
const LOCK_TABLAS = 7002;

class ErrorApp extends Error {
  constructor(mensaje, status = 400) {
    super(mensaje);
    this.status = status;
  }
}

const redondear = n => Math.round(Number(n || 0) * 100) / 100;
const num = v => Number(v ?? 0);
const ahora = () => new Date().toISOString();

const enteroPositivo = (v, nombre) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ErrorApp(`${nombre} debe ser un número entero mayor que 0.`);
  return n;
};
const montoPositivo = (v, nombre) => {
  const n = redondear(v);
  if (!(n > 0)) throw new ErrorApp(`${nombre} debe ser mayor que 0.`);
  return n;
};
const texto = (v, nombre, max = 120) => {
  const t = String(v ?? '').trim();
  if (!t) throw new ErrorApp(`Falta ${nombre.toLowerCase()}.`);
  if (t.length > max) throw new ErrorApp(`${nombre} es demasiado largo.`);
  return t;
};

// Consulta de compras con pagado y tablas ya calculados.
const SQL_COMPRAS = `
  SELECT c.*,
    COALESCE((SELECT SUM(p.monto_verificado) FROM pagos p WHERE p.compra_id = c.id AND p.estado = 'verificado'), 0) AS pagado,
    COALESCE((SELECT array_agg(t.serial ORDER BY t.serial) FROM tablas t WHERE t.compra_id = c.id), '{}') AS tablas
  FROM compras c`;

function crearServicios({ db, whatsapp }) {
  const q = (sql, params) => db.query(sql, params);
  const uno = async (sql, params) => (await q(sql, params))[0];

  // Dentro de una transacción se usa el ejecutor "t", no q, para ver los cambios no confirmados.
  const bitacora = (accion, detalle, t = q) =>
    t('INSERT INTO bitacora (fecha, accion, detalle) VALUES ($1, $2, $3)', [ahora(), accion, detalle]);

  // ---------- Evento ----------
  async function evento() {
    const e = await uno('SELECT * FROM evento WHERE id = 1');
    return {
      nombre: e.nombre,
      precioTabla: num(e.precio_tabla),
      moneda: e.moneda,
      fechaSorteo: e.fecha_sorteo,
      cuentasPago: e.cuentas_pago,
      exigirPagoCompleto: Boolean(e.exigir_pago_completo),
    };
  }

  async function actualizarEvento(datos) {
    const actual = await evento();
    const nuevo = {
      nombre: String(datos.nombre ?? actual.nombre).trim().slice(0, 120),
      precioTabla: datos.precioTabla === undefined ? actual.precioTabla : redondear(datos.precioTabla),
      moneda: String(datos.moneda ?? actual.moneda).trim().slice(0, 10),
      fechaSorteo: String(datos.fechaSorteo ?? actual.fechaSorteo).slice(0, 10),
      cuentasPago: String(datos.cuentasPago ?? actual.cuentasPago).slice(0, 2000),
      exigirPagoCompleto: datos.exigirPagoCompleto === undefined ? actual.exigirPagoCompleto : Boolean(datos.exigirPagoCompleto),
    };
    if (!(nuevo.precioTabla >= 0)) throw new ErrorApp('El precio no puede ser negativo.');
    await q(
      'UPDATE evento SET nombre=$1, precio_tabla=$2, moneda=$3, fecha_sorteo=$4, cuentas_pago=$5, exigir_pago_completo=$6 WHERE id = 1',
      [nuevo.nombre, nuevo.precioTabla, nuevo.moneda, nuevo.fechaSorteo, nuevo.cuentasPago, nuevo.exigirPagoCompleto],
    );
    await bitacora('configuración', `Precio ${nuevo.precioTabla} ${nuevo.moneda}`);
    return evento();
  }

  // ---------- Tablas ----------
  async function tablasDisponibles(t = q) {
    return num((await t("SELECT COUNT(*) AS n FROM tablas WHERE estado = 'disponible'"))[0].n);
  }

  // Libres = disponibles menos las ya prometidas a compras abiertas.
  async function tablasLibresParaVender(t = q) {
    const comprometidas = num((await t(
      "SELECT COALESCE(SUM(cantidad), 0) AS n FROM compras WHERE estado IN ('por_verificar','verificada')",
    ))[0].n);
    return (await tablasDisponibles(t)) - comprometidas;
  }

  function serialNuevo() {
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (const b of bytes) s += ALFABETO[b % ALFABETO.length];
    return `BNG-${s.slice(0, 4)}-${s.slice(4)}`;
  }

  async function generarTablas(cantidad) {
    const n = Number(cantidad);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TABLAS_LOTE) {
      throw new ErrorApp(`Indica una cantidad entre 1 y ${MAX_TABLAS_LOTE}.`);
    }
    const creadas = await db.tx(async t => {
      await t('SELECT pg_advisory_xact_lock($1)', [LOCK_TABLAS]);
      let total = 0;
      while (total < n) {
        const filas = await t(
          'INSERT INTO tablas (serial, creada_en) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING serial',
          [serialNuevo(), ahora()],
        );
        total += filas.length;
      }
      return total;
    });
    await bitacora('lote de tablas', `${creadas} tabla(s) nuevas`);
    return { creadas };
  }

  // Acepta seriales uno por línea o separados por coma, punto y coma o tab. Repetidos y vacíos se ignoran.
  async function importarTablas(entrada) {
    const seriales = [...new Set(
      String(entrada || '').split(/[\r\n,;\t]+/).map(s => s.trim().toUpperCase()).filter(Boolean),
    )].map(s => s.slice(0, 40));
    if (!seriales.length) throw new ErrorApp('No hay seriales para importar.');
    const insertadas = await db.tx(async t => {
      await t('SELECT pg_advisory_xact_lock($1)', [LOCK_TABLAS]);
      const filas = await t(
        'INSERT INTO tablas (serial, creada_en) SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING RETURNING serial',
        [seriales, ahora()],
      );
      return filas.length;
    });
    await bitacora('importación de tablas', `${insertadas} nueva(s) de ${seriales.length} leída(s)`);
    return { leidas: seriales.length, insertadas, repetidas: seriales.length - insertadas };
  }

  async function listarTablas() {
    const filas = await q(`SELECT t.serial, t.estado, t.vendida_en, c.codigo AS compra_codigo
      FROM tablas t LEFT JOIN compras c ON c.id = t.compra_id ORDER BY t.serial`);
    return filas.map(t => ({ serial: t.serial, estado: t.estado, vendidaEn: t.vendida_en, compraCodigo: t.compra_codigo }));
  }

  // ---------- Compras ----------
  async function codigoCompra(t = q) {
    for (let intento = 0; intento < 10; intento++) {
      const bytes = crypto.randomBytes(6);
      let s = '';
      for (const b of bytes) s += ALFABETO[b % ALFABETO.length];
      const codigo = `BNG-${s}`;
      if (!(await t('SELECT 1 FROM compras WHERE codigo = $1', [codigo])).length) return codigo;
    }
    throw new Error('No se pudo generar un código de compra.');
  }

  async function comprobantesDePagos(pagoIds) {
    if (!pagoIds.length) return {};
    const filas = await q('SELECT * FROM comprobantes WHERE pago_id = ANY($1::int[]) ORDER BY id', [pagoIds]);
    const porPago = {};
    for (const f of filas) (porPago[f.pago_id] ||= []).push({ id: f.id, nombre: f.nombre, tipo: f.tipo });
    return porPago;
  }

  function compraDTO(c) {
    const pagado = redondear(num(c.pagado));
    const total = num(c.total);
    return {
      id: c.id,
      codigo: c.codigo,
      nombre: c.nombre,
      cedula: c.cedula,
      telefono: c.telefono,
      correo: c.correo,
      cantidad: c.cantidad,
      precioUnitario: num(c.precio_unitario),
      total,
      pagado,
      saldo: redondear(Math.max(0, total - pagado)),
      estado: c.estado,
      whatsappEstado: c.whatsapp_estado,
      whatsappError: c.whatsapp_error,
      creadaEn: c.creada_en,
      verificadaEn: c.verificada_en,
      enviadaEn: c.enviada_en,
      tablas: c.tablas || [],
    };
  }

  function pagoDTO(p, comprobantes) {
    return {
      id: p.id,
      compraId: p.compra_id,
      montoReportado: num(p.monto_reportado),
      montoVerificado: p.monto_verificado == null ? null : num(p.monto_verificado),
      metodo: p.metodo,
      referencia: p.referencia,
      estado: p.estado,
      comprobantes: comprobantes || [],
      creadoEn: p.creado_en,
      verificadoEn: p.verificado_en,
    };
  }

  async function listarCompras({ estado } = {}) {
    const filas = estado
      ? await q(`${SQL_COMPRAS} WHERE c.estado = $1 ORDER BY c.id DESC`, [estado])
      : await q(`${SQL_COMPRAS} ORDER BY c.id DESC`);
    return filas.map(compraDTO);
  }

  async function detalleCompra(id) {
    const c = await uno(`${SQL_COMPRAS} WHERE c.id = $1`, [id]);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    const pagos = await q('SELECT * FROM pagos WHERE compra_id = $1 ORDER BY id', [id]);
    const comp = await comprobantesDePagos(pagos.map(p => p.id));
    return { ...compraDTO(c), pagos: pagos.map(p => pagoDTO(p, comp[p.id])) };
  }

  // comprobantes: [{ ruta, nombre, tipo }] ya subidos a Storage y verificados por la capa HTTP.
  async function crearCompra(datos, comprobantes = []) {
    const e = await evento();
    if (!(e.precioTabla > 0)) throw new ErrorApp('Las compras están cerradas: el precio aún no está configurado.', 409);

    const cantidad = enteroPositivo(datos.cantidad, 'La cantidad');
    if (cantidad > MAX_TABLAS_POR_COMPRA) throw new ErrorApp(`Máximo ${MAX_TABLAS_POR_COMPRA} tablas por compra.`);
    if (!comprobantes.length) throw new ErrorApp('Adjunta al menos un comprobante de pago.');
    const d = {
      nombre: texto(datos.nombre, 'Nombre'),
      cedula: texto(datos.cedula, 'Cédula', 20),
      telefono: normalizarTelefono(datos.telefono),
      correo: texto(datos.correo, 'Correo', 120),
      metodo: texto(datos.metodo, 'Método de pago', 40),
      referencia: texto(datos.referencia, 'Referencia', 60),
    };
    const total = redondear(cantidad * e.precioTabla);
    const montoPagado = datos.montoPagado === undefined || datos.montoPagado === ''
      ? total
      : montoPositivo(datos.montoPagado, 'El monto pagado');

    return db.tx(async t => {
      await t('SELECT pg_advisory_xact_lock($1)', [LOCK_VENTAS]);
      if (cantidad > await tablasLibresParaVender(t)) {
        throw new ErrorApp('No hay suficientes tablas disponibles para esta cantidad. Intenta con menos tablas.', 409);
      }
      const codigo = await codigoCompra(t);
      const [{ id }] = await t(
        `INSERT INTO compras (codigo, nombre, cedula, telefono, correo, cantidad, precio_unitario, total, estado, creada_en)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'por_verificar', $9) RETURNING id`,
        [codigo, d.nombre, d.cedula, d.telefono, d.correo, cantidad, e.precioTabla, total, ahora()],
      );
      const [{ id: pagoId }] = await t(
        `INSERT INTO pagos (compra_id, monto_reportado, metodo, referencia, estado, creado_en)
         VALUES ($1, $2, $3, $4, 'por_verificar', $5) RETURNING id`,
        [id, montoPagado, d.metodo, d.referencia, ahora()],
      );
      for (const c of comprobantes) {
        await t('INSERT INTO comprobantes (pago_id, ruta, nombre, tipo) VALUES ($1, $2, $3, $4)',
          [pagoId, c.ruta, String(c.nombre).slice(0, 120), c.tipo]);
      }
      await bitacora('compra registrada', `${codigo} · ${d.nombre} · ${cantidad} tabla(s)`, t);
      return { id: Number(id), codigo, total };
    });
  }

  function normalizarTelefono(texto) {
    return whatsapp.normalizarTelefono(texto);
  }

  async function estadoPublico(codigo) {
    const c = await uno('SELECT codigo, cantidad, total, estado FROM compras WHERE codigo = $1', [String(codigo || '').trim().toUpperCase()]);
    if (!c) throw new ErrorApp('No encontramos una compra con ese código.', 404);
    return { codigo: c.codigo, cantidad: c.cantidad, total: num(c.total), estado: c.estado };
  }

  async function registrarPagoManual(compraId, datos) {
    const c = await uno('SELECT * FROM compras WHERE id = $1', [compraId]);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    if (c.estado === 'rechazada') throw new ErrorApp('La compra está rechazada.', 409);
    const monto = montoPositivo(datos.monto, 'El monto');
    const metodo = texto(datos.metodo, 'Método de pago', 40);
    const referencia = String(datos.referencia ?? '').trim().slice(0, 60) || 'Manual';
    await db.tx(async t => {
      await t(
        `INSERT INTO pagos (compra_id, monto_reportado, monto_verificado, metodo, referencia, estado, creado_en, verificado_en)
         VALUES ($1, $2, $2, $3, $4, 'verificado', $5, $5)`,
        [compraId, monto, metodo, referencia, ahora()],
      );
      if (c.estado === 'por_verificar') {
        await t("UPDATE compras SET estado = 'verificada', verificada_en = $1 WHERE id = $2", [ahora(), compraId]);
      }
      await bitacora('pago registrado', `${c.codigo}: ${monto} (${metodo})`, t);
    });
    return detalleCompra(compraId);
  }

  async function verificarPago(pagoId, montoVerificado) {
    const p = await uno('SELECT * FROM pagos WHERE id = $1', [pagoId]);
    if (!p) throw new ErrorApp('Pago no encontrado.', 404);
    if (p.estado !== 'por_verificar') throw new ErrorApp('Este pago ya fue procesado.', 409);
    const monto = montoPositivo(montoVerificado, 'El monto verificado');
    const c = await uno('SELECT * FROM compras WHERE id = $1', [p.compra_id]);
    await db.tx(async t => {
      const act = await t(
        "UPDATE pagos SET estado = 'verificado', monto_verificado = $1, verificado_en = $2 WHERE id = $3 AND estado = 'por_verificar' RETURNING id",
        [monto, ahora(), pagoId],
      );
      if (!act.length) throw new ErrorApp('Este pago ya fue procesado.', 409);
      if (c.estado === 'por_verificar') {
        await t("UPDATE compras SET estado = 'verificada', verificada_en = $1 WHERE id = $2", [ahora(), c.id]);
      }
      await bitacora('pago verificado', `${c.codigo}: ${monto} (${p.metodo} ${p.referencia})`, t);
    });
    return detalleCompra(c.id);
  }

  async function rechazarPago(pagoId) {
    const p = await uno('SELECT * FROM pagos WHERE id = $1', [pagoId]);
    if (!p) throw new ErrorApp('Pago no encontrado.', 404);
    if (p.estado !== 'por_verificar') throw new ErrorApp('Este pago ya fue procesado.', 409);
    await q("UPDATE pagos SET estado = 'rechazado', verificado_en = $1 WHERE id = $2", [ahora(), pagoId]);
    const c = await uno('SELECT codigo FROM compras WHERE id = $1', [p.compra_id]);
    await bitacora('pago rechazado', `${c.codigo}: ${p.referencia}`);
    return detalleCompra(p.compra_id);
  }

  async function pagadoDe(compraId, t = q) {
    return redondear(num((await t(
      "SELECT COALESCE(SUM(monto_verificado), 0) AS n FROM pagos WHERE compra_id = $1 AND estado = 'verificado'", [compraId],
    ))[0].n));
  }

  // "Enviar Tablas": asigna tablas libres a la compra sin duplicados y envía el mensaje.
  async function enviarTablas(compraId) {
    const c = await uno('SELECT * FROM compras WHERE id = $1', [compraId]);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    if (c.estado !== 'verificada') throw new ErrorApp('Solo se pueden enviar tablas de compras verificadas.', 409);
    const pagado = await pagadoDe(compraId);
    if (!(pagado > 0)) throw new ErrorApp('La compra no tiene pagos verificados.', 409);
    if ((await evento()).exigirPagoCompleto && pagado < num(c.total)) {
      throw new ErrorApp('Falta pagar el total para enviar las tablas.', 409);
    }

    const seriales = await db.tx(async t => {
      await t('SELECT pg_advisory_xact_lock($1)', [LOCK_VENTAS]);
      // Bloquea la compra y revalida: evita enviar dos veces en envíos simultáneos.
      const [actual] = await t("SELECT estado FROM compras WHERE id = $1 FOR UPDATE", [compraId]);
      if (actual.estado !== 'verificada') throw new ErrorApp('Esta compra ya fue procesada.', 409);
      // SKIP LOCKED: si otra venta tiene una tabla bloqueada, se toma la siguiente libre.
      const asignadas = await t(
        `UPDATE tablas SET estado = 'vendida', compra_id = $1, vendida_en = $2
         WHERE serial IN (
           SELECT serial FROM tablas WHERE estado = 'disponible'
           ORDER BY random() LIMIT $3 FOR UPDATE SKIP LOCKED
         )
         RETURNING serial`,
        [compraId, ahora(), c.cantidad],
      );
      if (asignadas.length < c.cantidad) {
        throw new ErrorApp(`Faltan tablas: hay ${asignadas.length} disponibles y se piden ${c.cantidad}. Agrega más tablas.`, 409);
      }
      await t("UPDATE compras SET estado = 'enviada', enviada_en = $1 WHERE id = $2", [ahora(), compraId]);
      const lista = asignadas.map(r => r.serial).sort();
      await bitacora('tablas asignadas', `${c.codigo}: ${lista.join(', ')}`, t);
      return lista;
    });

    await entregarWhatsApp(c, seriales);
    return detalleCompra(compraId);
  }

  async function reenviarWhatsapp(compraId) {
    const c = await uno('SELECT * FROM compras WHERE id = $1', [compraId]);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    if (c.estado !== 'enviada') throw new ErrorApp('Esta compra aún no tiene tablas enviadas.', 409);
    const seriales = (await q('SELECT serial FROM tablas WHERE compra_id = $1 ORDER BY serial', [compraId])).map(r => r.serial);
    await entregarWhatsApp(c, seriales);
    return detalleCompra(compraId);
  }

  async function entregarWhatsApp(c, seriales) {
    try {
      const r = await whatsapp.enviarTablas({ telefono: c.telefono, nombre: c.nombre, seriales });
      if (r.estado === 'enviado') {
        await q("UPDATE compras SET whatsapp_estado = 'enviado', whatsapp_error = NULL WHERE id = $1", [c.id]);
        await bitacora('tablas enviadas', `${c.codigo} por WhatsApp`);
      } else {
        await q("UPDATE compras SET whatsapp_estado = 'manual', whatsapp_error = NULL WHERE id = $1", [c.id]);
        await bitacora('envío manual pendiente', `${c.codigo}: WhatsApp no configurado`);
      }
    } catch (err) {
      await q("UPDATE compras SET whatsapp_estado = 'fallido', whatsapp_error = $1 WHERE id = $2", [String(err.message).slice(0, 500), c.id]);
      await bitacora('falló envío WhatsApp', `${c.codigo}: ${err.message}`);
    }
  }

  async function enlaceWhatsapp(compraId) {
    const c = await uno('SELECT * FROM compras WHERE id = $1', [compraId]);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    const seriales = (await q('SELECT serial FROM tablas WHERE compra_id = $1 ORDER BY serial', [compraId])).map(r => r.serial);
    if (!seriales.length) throw new ErrorApp('Esta compra aún no tiene tablas asignadas.', 409);
    return whatsapp.enlaceManual(c.telefono, c.nombre, seriales);
  }

  async function marcarEnviadoManual(compraId) {
    const c = await uno('SELECT * FROM compras WHERE id = $1', [compraId]);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    if (c.estado !== 'enviada') throw new ErrorApp('Esta compra aún no tiene tablas asignadas.', 409);
    await q("UPDATE compras SET whatsapp_estado = 'enviado', whatsapp_error = NULL WHERE id = $1", [compraId]);
    await bitacora('envío confirmado a mano', c.codigo);
    return detalleCompra(compraId);
  }

  async function rechazarCompra(compraId) {
    const c = await uno('SELECT * FROM compras WHERE id = $1', [compraId]);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    if (c.estado === 'enviada') throw new ErrorApp('Ya se enviaron las tablas; no se puede rechazar.', 409);
    if (c.estado === 'rechazada') throw new ErrorApp('La compra ya está rechazada.', 409);
    if (await pagadoDe(compraId) > 0) throw new ErrorApp('Tiene pagos verificados. Regístralo como devolución antes de rechazarla.', 409);
    await db.tx(async t => {
      await t("UPDATE pagos SET estado = 'rechazado', verificado_en = $1 WHERE compra_id = $2 AND estado = 'por_verificar'", [ahora(), compraId]);
      await t("UPDATE compras SET estado = 'rechazada' WHERE id = $1", [compraId]);
      await bitacora('compra rechazada', c.codigo, t);
    });
    return detalleCompra(compraId);
  }

  // Comprobante individual para el panel: la ruta se resuelve en la capa de almacenamiento.
  async function comprobanteDe(comprobanteId) {
    const c = await uno('SELECT * FROM comprobantes WHERE id = $1', [comprobanteId]);
    if (!c) throw new ErrorApp('Comprobante no encontrado.', 404);
    return c;
  }

  // ---------- Premios ----------
  function premioDTO(p) {
    return {
      id: p.id,
      ronda: p.ronda,
      premio: p.premio,
      monto: num(p.monto),
      serial: p.serial,
      pagado: Boolean(p.pagado),
      pagadoEn: p.pagado_en,
      ganador: p.compra_id
        ? { compraId: p.compra_id, codigo: p.codigo, nombre: p.nombre, cedula: p.cedula, telefono: p.telefono }
        : null,
    };
  }

  const SQL_PREMIOS = `
    SELECT p.*, c.id AS compra_id, c.codigo, c.nombre, c.cedula, c.telefono
    FROM premios p
    LEFT JOIN tablas t ON t.serial = p.serial
    LEFT JOIN compras c ON c.id = t.compra_id`;

  async function listarPremios() {
    return (await q(`${SQL_PREMIOS} ORDER BY p.id`)).map(premioDTO);
  }

  async function premioPorId(id) {
    const p = await uno(`${SQL_PREMIOS} WHERE p.id = $1`, [id]);
    if (!p) throw new ErrorApp('Premio no encontrado.', 404);
    return premioDTO(p);
  }

  async function crearPremio(datos) {
    const ronda = texto(datos.ronda, 'Nombre de la ronda', 80);
    const premio = texto(datos.premio, 'Premio', 120);
    const monto = redondear(datos.monto || 0);
    if (monto < 0) throw new ErrorApp('El monto del premio no puede ser negativo.');
    const [{ id }] = await q('INSERT INTO premios (ronda, premio, monto, creado_en) VALUES ($1, $2, $3, $4) RETURNING id', [ronda, premio, monto, ahora()]);
    await bitacora('ronda creada', `${ronda}: ${premio}`);
    return premioPorId(id);
  }

  // Solo una tabla vendida puede ser ganadora: así el premio siempre tiene un comprador real.
  async function asignarGanador(premioId, serialRaw) {
    const serial = String(serialRaw ?? '').trim().toUpperCase();
    const p = await uno('SELECT * FROM premios WHERE id = $1', [premioId]);
    if (!p) throw new ErrorApp('Premio no encontrado.', 404);
    const tabla = await uno('SELECT * FROM tablas WHERE serial = $1', [serial]);
    if (!tabla) throw new ErrorApp('Esa tabla no existe.', 404);
    if (tabla.estado !== 'vendida' || !tabla.compra_id) throw new ErrorApp('Esa tabla no está vendida.', 409);
    await q('UPDATE premios SET serial = $1 WHERE id = $2', [serial, premioId]);
    const compra = await uno('SELECT nombre FROM compras WHERE id = $1', [tabla.compra_id]);
    await bitacora('ganador', `${p.ronda}: ${serial} (${compra.nombre})`);
    return premioPorId(premioId);
  }

  async function quitarGanador(premioId) {
    await q('UPDATE premios SET serial = NULL WHERE id = $1 AND pagado = false', [premioId]);
    return premioPorId(premioId);
  }

  async function pagarPremio(premioId) {
    const p = await uno('SELECT * FROM premios WHERE id = $1', [premioId]);
    if (!p) throw new ErrorApp('Premio no encontrado.', 404);
    if (!p.serial) throw new ErrorApp('Primero registra la tabla ganadora.', 409);
    if (p.pagado) throw new ErrorApp('Este premio ya fue pagado.', 409);
    await q('UPDATE premios SET pagado = true, pagado_en = $1 WHERE id = $2', [ahora(), premioId]);
    await bitacora('premio pagado', `${p.ronda}: ${p.monto}`);
    return premioPorId(premioId);
  }

  // ---------- Gastos ----------
  async function listarGastos() {
    return (await q('SELECT * FROM gastos ORDER BY fecha DESC, id DESC')).map(g => ({
      id: g.id, fecha: g.fecha, concepto: g.concepto, categoria: g.categoria, monto: num(g.monto),
    }));
  }

  async function crearGasto(datos) {
    const concepto = texto(datos.concepto, 'Concepto');
    const categoria = texto(datos.categoria || 'Otros', 'Categoría', 40);
    const monto = montoPositivo(datos.monto, 'El monto');
    const fecha = String(datos.fecha || ahora().slice(0, 10)).slice(0, 10);
    await q('INSERT INTO gastos (fecha, concepto, categoria, monto, creado_en) VALUES ($1, $2, $3, $4, $5)', [fecha, concepto, categoria, monto, ahora()]);
    await bitacora('gasto', `${concepto}: ${monto}`);
    return { ok: true };
  }

  async function eliminarGasto(id) {
    const g = await uno('SELECT * FROM gastos WHERE id = $1', [id]);
    if (!g) throw new ErrorApp('Gasto no encontrado.', 404);
    await q('DELETE FROM gastos WHERE id = $1', [id]);
    await bitacora('gasto eliminado', `${g.concepto}: ${g.monto}`);
    return { ok: true };
  }

  // ---------- Resumen y reportes ----------
  async function resumen() {
    const compras = (await q(`${SQL_COMPRAS} WHERE c.estado != 'rechazada'`)).map(compraDTO);
    const suma = async sql => redondear(num((await q(sql))[0].n));
    const cobrado = await suma("SELECT COALESCE(SUM(monto_verificado), 0) AS n FROM pagos WHERE estado = 'verificado'");
    const porVerificar = await suma("SELECT COALESCE(SUM(monto_reportado), 0) AS n FROM pagos WHERE estado = 'por_verificar'");
    const premiosPagados = await suma('SELECT COALESCE(SUM(monto), 0) AS n FROM premios WHERE pagado = true');
    const premiosProgramados = await suma('SELECT COALESCE(SUM(monto), 0) AS n FROM premios');
    const gastos = await suma('SELECT COALESCE(SUM(monto), 0) AS n FROM gastos');
    const porCobrar = redondear(compras.reduce((s, c) => s + c.saldo, 0));
    const porMetodo = (await q(
      "SELECT metodo, SUM(monto_verificado) AS monto FROM pagos WHERE estado = 'verificado' GROUP BY metodo ORDER BY monto DESC",
    )).map(r => ({ metodo: r.metodo, monto: redondear(r.monto) }));

    const disponibles = await tablasDisponibles();
    const vendidas = num((await q("SELECT COUNT(*) AS n FROM tablas WHERE estado = 'vendida'"))[0].n);
    const cantidadEn = async estado => num((await q(
      'SELECT COALESCE(SUM(cantidad), 0) AS n FROM compras WHERE estado = $1', [estado]))[0].n);

    return {
      dinero: {
        cobrado, porVerificar, porCobrar, premiosPagados, premiosProgramados, gastos,
        balance: redondear(cobrado - premiosPagados - gastos),
        porMetodo,
      },
      tablas: {
        total: disponibles + vendidas,
        disponibles,
        vendidas,
        libresParaVender: await tablasLibresParaVender(),
        porEnviar: await cantidadEn('verificada'),
        entregadas: await cantidadEn('enviada'),
      },
      compras: {
        porVerificar: compras.filter(c => c.estado === 'por_verificar').length,
        listasParaEnviar: compras.filter(c => c.estado === 'verificada').length,
        conDeuda: compras.filter(c => c.saldo > 0).length,
      },
      evento: await evento(),
    };
  }

  async function bitacoraLista(limite = 100) {
    return q('SELECT * FROM bitacora ORDER BY id DESC LIMIT $1', [limite]);
  }

  async function reporte(nombre) {
    if (nombre === 'compras') {
      const filas = (await q(`${SQL_COMPRAS} ORDER BY c.id`)).map(compraDTO);
      return {
        encabezados: ['Código', 'Fecha', 'Nombre', 'Cédula', 'Teléfono', 'Correo', 'Tablas', 'Total', 'Pagado', 'Saldo', 'Estado', 'WhatsApp', 'Seriales'],
        filas: filas.map(c => [c.codigo, c.creadaEn.slice(0, 10), c.nombre, c.cedula, c.telefono, c.correo, c.cantidad, c.total, c.pagado, c.saldo, c.estado, c.whatsappEstado, c.tablas.join(' ')]),
      };
    }
    if (nombre === 'deudas') {
      const filas = (await q(`${SQL_COMPRAS} WHERE c.estado != 'rechazada' ORDER BY c.id`)).map(compraDTO).filter(c => c.saldo > 0);
      return {
        encabezados: ['Código', 'Nombre', 'Cédula', 'Teléfono', 'Total', 'Pagado', 'Debe'],
        filas: filas.map(c => [c.codigo, c.nombre, c.cedula, c.telefono, c.total, c.pagado, c.saldo]),
      };
    }
    if (nombre === 'pagos') {
      const filas = await q('SELECT p.*, c.codigo, c.nombre FROM pagos p JOIN compras c ON c.id = p.compra_id ORDER BY p.id');
      return {
        encabezados: ['Fecha', 'Código', 'Nombre', 'Monto reportado', 'Monto verificado', 'Método', 'Referencia', 'Estado'],
        filas: filas.map(p => [p.creado_en.slice(0, 10), p.codigo, p.nombre, num(p.monto_reportado), p.monto_verificado == null ? '' : num(p.monto_verificado), p.metodo, p.referencia, p.estado]),
      };
    }
    if (nombre === 'tablas') {
      const filas = await q(`SELECT t.serial, t.estado, t.vendida_en, c.codigo, c.nombre, c.cedula, c.telefono
        FROM tablas t LEFT JOIN compras c ON c.id = t.compra_id ORDER BY t.serial`);
      return {
        encabezados: ['Serial', 'Estado', 'Vendida en', 'Código compra', 'Nombre', 'Cédula', 'Teléfono'],
        filas: filas.map(t => [t.serial, t.estado, t.vendida_en ?? '', t.codigo ?? '', t.nombre ?? '', t.cedula ?? '', t.telefono ?? '']),
      };
    }
    if (nombre === 'premios') {
      return {
        encabezados: ['Ronda', 'Premio', 'Monto', 'Serial', 'Ganador', 'Cédula', 'Teléfono', 'Pagado'],
        filas: (await listarPremios()).map(p => [p.ronda, p.premio, p.monto, p.serial ?? '', p.ganador?.nombre ?? '', p.ganador?.cedula ?? '', p.ganador?.telefono ?? '', p.pagado ? 'sí' : 'no']),
      };
    }
    if (nombre === 'gastos') {
      return {
        encabezados: ['Fecha', 'Concepto', 'Categoría', 'Monto'],
        filas: (await listarGastos()).map(g => [g.fecha, g.concepto, g.categoria, g.monto]),
      };
    }
    throw new ErrorApp('Reporte no existe.', 404);
  }

  return {
    evento, actualizarEvento,
    tablasDisponibles, tablasLibresParaVender, generarTablas, importarTablas, listarTablas,
    crearCompra, estadoPublico, detalleCompra, listarCompras,
    registrarPagoManual, verificarPago, rechazarPago,
    enviarTablas, reenviarWhatsapp, enlaceWhatsapp, marcarEnviadoManual, rechazarCompra,
    comprobanteDe,
    listarPremios, crearPremio, asignarGanador, quitarGanador, pagarPremio,
    listarGastos, crearGasto, eliminarGasto,
    resumen, bitacoraLista, reporte,
  };
}

module.exports = { crearServicios, ErrorApp, redondear };
