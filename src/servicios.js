const crypto = require('node:crypto');

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_TABLAS_POR_COMPRA = 50;
const MAX_TABLAS_LOTE = 500;

class ErrorApp extends Error {
  constructor(mensaje, status = 400) {
    super(mensaje);
    this.status = status;
  }
}

const redondear = n => Math.round(Number(n || 0) * 100) / 100;
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

function crearServicios({ db, whatsapp, codigoPais = '58' }) {
  const ahora = () => new Date().toISOString();
  const q = (sql, ...params) => db.prepare(sql).all(...params);
  const uno = (sql, ...params) => db.prepare(sql).get(...params);
  const ejecutar = (sql, ...params) => db.prepare(sql).run(...params);

  // Ejecuta fn dentro de una transacción con escritura bloqueada (evita carreras entre ventas).
  function transaccion(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function bitacora(accion, detalle) {
    ejecutar('INSERT INTO bitacora (fecha, accion, detalle) VALUES (?, ?, ?)', ahora(), accion, detalle);
  }

  // ---------- Evento ----------
  function evento() {
    const e = uno('SELECT * FROM evento WHERE id = 1');
    return {
      nombre: e.nombre,
      precioTabla: e.precio_tabla,
      moneda: e.moneda,
      fechaSorteo: e.fecha_sorteo,
      cuentasPago: e.cuentas_pago,
      exigirPagoCompleto: Boolean(e.exigir_pago_completo),
    };
  }

  function actualizarEvento(datos) {
    const actual = evento();
    const nuevo = {
      nombre: String(datos.nombre ?? actual.nombre).trim().slice(0, 120),
      precioTabla: datos.precioTabla === undefined ? actual.precioTabla : redondear(datos.precioTabla),
      moneda: String(datos.moneda ?? actual.moneda).trim().slice(0, 10),
      fechaSorteo: String(datos.fechaSorteo ?? actual.fechaSorteo).slice(0, 10),
      cuentasPago: String(datos.cuentasPago ?? actual.cuentasPago).slice(0, 2000),
      exigirPagoCompleto: datos.exigirPagoCompleto === undefined ? actual.exigirPagoCompleto : Boolean(datos.exigirPagoCompleto),
    };
    if (!(nuevo.precioTabla >= 0)) throw new ErrorApp('El precio no puede ser negativo.');
    ejecutar(
      `UPDATE evento SET nombre=?, precio_tabla=?, moneda=?, fecha_sorteo=?, cuentas_pago=?, exigir_pago_completo=? WHERE id=1`,
      nuevo.nombre, nuevo.precioTabla, nuevo.moneda, nuevo.fechaSorteo, nuevo.cuentasPago, nuevo.exigirPagoCompleto ? 1 : 0,
    );
    bitacora('configuración', `Precio ${nuevo.precioTabla} ${nuevo.moneda}`);
    return evento();
  }

  // ---------- Tablas ----------
  function tablasDisponibles() {
    return uno("SELECT COUNT(*) AS n FROM tablas WHERE estado = 'disponible'").n;
  }

  // Tablas libres que aún no están prometidas a una compra abierta.
  function tablasLibresParaVender() {
    const comprometidas = uno(
      "SELECT COALESCE(SUM(cantidad), 0) AS n FROM compras WHERE estado IN ('por_verificar','verificada')",
    ).n;
    return tablasDisponibles() - comprometidas;
  }

  function serialNuevo() {
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (const b of bytes) s += ALFABETO[b % ALFABETO.length];
    return `BNG-${s.slice(0, 4)}-${s.slice(4)}`;
  }

  function generarTablas(cantidad) {
    const n = Number(cantidad);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TABLAS_LOTE) {
      throw new ErrorApp(`Indica una cantidad entre 1 y ${MAX_TABLAS_LOTE}.`);
    }
    const insertar = db.prepare('INSERT OR IGNORE INTO tablas (serial, creada_en) VALUES (?, ?)');
    const creadas = transaccion(() => {
      let total = 0;
      while (total < n) {
        if (insertar.run(serialNuevo(), ahora()).changes === 1) total++;
      }
      return total;
    });
    bitacora('lote de tablas', `${creadas} tabla(s) nuevas`);
    return { creadas };
  }

  // Importa seriales existentes (uno por línea o separados por coma). Repetidos o vacíos se ignoran.
  function importarTablas(entrada) {
    const seriales = [...new Set(
      String(entrada || '')
        .split(/[\r\n,;\t]+/)
        .map(s => s.trim().toUpperCase())
        .filter(Boolean),
    )];
    if (!seriales.length) throw new ErrorApp('No hay seriales para importar.');
    const insertar = db.prepare('INSERT OR IGNORE INTO tablas (serial, creada_en) VALUES (?, ?)');
    const insertadas = transaccion(() => {
      let n = 0;
      for (const s of seriales) if (insertar.run(s.slice(0, 40), ahora()).changes === 1) n++;
      return n;
    });
    bitacora('importación de tablas', `${insertadas} nueva(s) de ${seriales.length} leída(s)`);
    return { leidas: seriales.length, insertadas, repetidas: seriales.length - insertadas };
  }

  function listarTablas() {
    return q(`SELECT t.serial, t.estado, t.vendida_en, c.codigo AS compraCodigo
      FROM tablas t LEFT JOIN compras c ON c.id = t.compra_id ORDER BY t.serial`).map(t => ({
      serial: t.serial, estado: t.estado, vendidaEn: t.vendida_en, compraCodigo: t.compraCodigo,
    }));
  }

  // ---------- Compras ----------
  function codigoCompra() {
    for (let intento = 0; intento < 10; intento++) {
      const bytes = crypto.randomBytes(6);
      let s = '';
      for (const b of bytes) s += ALFABETO[b % ALFABETO.length];
      const codigo = `BNG-${s}`;
      if (!uno('SELECT 1 FROM compras WHERE codigo = ?', codigo)) return codigo;
    }
    throw new Error('No se pudo generar un código de compra.');
  }

  function resumenCompra(c) {
    const pagado = redondear(uno(
      "SELECT COALESCE(SUM(monto_verificado), 0) AS n FROM pagos WHERE compra_id = ? AND estado = 'verificado'", c.id,
    ).n);
    return {
      id: c.id,
      codigo: c.codigo,
      nombre: c.nombre,
      cedula: c.cedula,
      telefono: c.telefono,
      correo: c.correo,
      cantidad: c.cantidad,
      precioUnitario: c.precio_unitario,
      total: c.total,
      pagado,
      saldo: redondear(Math.max(0, c.total - pagado)),
      estado: c.estado,
      whatsappEstado: c.whatsapp_estado,
      whatsappError: c.whatsapp_error,
      creadaEn: c.creada_en,
      verificadaEn: c.verificada_en,
      enviadaEn: c.enviada_en,
      tablas: q('SELECT serial FROM tablas WHERE compra_id = ? ORDER BY serial', c.id).map(r => r.serial),
    };
  }

  function detalleCompra(id) {
    const c = uno('SELECT * FROM compras WHERE id = ?', id);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    const pagos = q('SELECT * FROM pagos WHERE compra_id = ? ORDER BY id', id).map(pagoDTO);
    return { ...resumenCompra(c), pagos };
  }

  function pagoDTO(p) {
    return {
      id: p.id,
      compraId: p.compra_id,
      montoReportado: p.monto_reportado,
      montoVerificado: p.monto_verificado,
      metodo: p.metodo,
      referencia: p.referencia,
      estado: p.estado,
      tieneComprobante: Boolean(p.comprobante_archivo),
      comprobanteNombre: p.comprobante_nombre,
      comprobanteTipo: p.comprobante_tipo,
      creadoEn: p.creado_en,
      verificadoEn: p.verificado_en,
    };
  }

  // Registra la compra y su primer pago (con comprobante). Todo ocurre en una transacción.
  function crearCompra(datos, comprobantes = []) {
    const e = evento();
    if (!(e.precioTabla > 0)) throw new ErrorApp('Las compras están cerradas: el precio aún no está configurado.', 409);

    const cantidad = enteroPositivo(datos.cantidad, 'La cantidad');
    if (cantidad > MAX_TABLAS_POR_COMPRA) throw new ErrorApp(`Máximo ${MAX_TABLAS_POR_COMPRA} tablas por compra.`);
    const datosCompra = {
      nombre: texto(datos.nombre, 'Nombre'),
      cedula: texto(datos.cedula, 'Cédula', 20),
      telefono: whatsapp.normalizarTelefono(datos.telefono),
      correo: texto(datos.correo, 'Correo', 120),
      metodo: texto(datos.metodo, 'Método de pago', 40),
      referencia: texto(datos.referencia, 'Referencia', 60),
    };
    const total = redondear(cantidad * e.precioTabla);
    const montoPagado = datos.montoPagado === undefined || datos.montoPagado === ''
      ? total
      : montoPositivo(datos.montoPagado, 'El monto pagado');

    return transaccion(() => {
      if (cantidad > tablasLibresParaVender()) {
        throw new ErrorApp('No hay suficientes tablas disponibles para esta cantidad. Intenta con menos tablas.', 409);
      }
      const codigo = codigoCompra();
      const { lastInsertRowid: id } = ejecutar(
        `INSERT INTO compras (codigo, nombre, cedula, telefono, correo, cantidad, precio_unitario, total, estado, creada_en)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'por_verificar', ?)`,
        codigo, datosCompra.nombre, datosCompra.cedula, datosCompra.telefono, datosCompra.correo,
        cantidad, e.precioTabla, total, ahora(),
      );
      const comprobante = comprobantes[0];
      ejecutar(
        `INSERT INTO pagos (compra_id, monto_reportado, metodo, referencia, estado, comprobante_archivo, comprobante_nombre, comprobante_tipo, creado_en)
         VALUES (?, ?, ?, ?, 'por_verificar', ?, ?, ?, ?)`,
        id, montoPagado, datosCompra.metodo, datosCompra.referencia,
        comprobante?.archivo ?? null, comprobante?.nombre ?? null, comprobante?.tipo ?? null, ahora(),
      );
      bitacora('compra registrada', `${codigo} · ${datosCompra.nombre} · ${cantidad} tabla(s)`);
      return { id: Number(id), codigo, total };
    });
  }

  // Estado público: sólo lo que el comprador necesita saber.
  function estadoPublico(codigo) {
    const c = uno('SELECT codigo, nombre, cantidad, total, estado FROM compras WHERE codigo = ?', String(codigo || '').trim().toUpperCase());
    if (!c) throw new ErrorApp('No encontramos una compra con ese código.', 404);
    return { codigo: c.codigo, cantidad: c.cantidad, total: c.total, estado: c.estado };
  }

  // Pago que el administrador agrega directamente (efectivo, pago recibido en el evento, abono).
  function registrarPagoManual(compraId, datos) {
    const c = uno('SELECT * FROM compras WHERE id = ?', compraId);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    if (c.estado === 'rechazada') throw new ErrorApp('La compra está rechazada.', 409);
    const monto = montoPositivo(datos.monto, 'El monto');
    const metodo = texto(datos.metodo, 'Método de pago', 40);
    const referencia = String(datos.referencia ?? '').trim().slice(0, 60) || 'Manual';
    transaccion(() => {
      ejecutar(
        `INSERT INTO pagos (compra_id, monto_reportado, monto_verificado, metodo, referencia, estado, creado_en, verificado_en)
         VALUES (?, ?, ?, ?, ?, 'verificado', ?, ?)`,
        compraId, monto, monto, metodo, referencia, ahora(), ahora(),
      );
      if (c.estado === 'por_verificar') {
        ejecutar("UPDATE compras SET estado = 'verificada', verificada_en = ? WHERE id = ?", ahora(), compraId);
      }
    });
    bitacora('pago registrado', `${c.codigo}: ${monto} (${metodo})`);
    return detalleCompra(compraId);
  }

  // El administrador confirma el monto real recibido. Si es 0, el pago se rechaza.
  function verificarPago(pagoId, montoVerificado) {
    const p = uno('SELECT * FROM pagos WHERE id = ?', pagoId);
    if (!p) throw new ErrorApp('Pago no encontrado.', 404);
    if (p.estado !== 'por_verificar') throw new ErrorApp('Este pago ya fue procesado.', 409);
    const monto = montoPositivo(montoVerificado, 'El monto verificado');
    const c = uno('SELECT * FROM compras WHERE id = ?', p.compra_id);
    transaccion(() => {
      ejecutar("UPDATE pagos SET estado = 'verificado', monto_verificado = ?, verificado_en = ? WHERE id = ?", monto, ahora(), pagoId);
      if (c.estado === 'por_verificar') {
        ejecutar("UPDATE compras SET estado = 'verificada', verificada_en = ? WHERE id = ?", ahora(), c.id);
      }
    });
    bitacora('pago verificado', `${c.codigo}: ${monto} (${p.metodo} ${p.referencia})`);
    return detalleCompra(c.id);
  }

  function rechazarPago(pagoId) {
    const p = uno('SELECT * FROM pagos WHERE id = ?', pagoId);
    if (!p) throw new ErrorApp('Pago no encontrado.', 404);
    if (p.estado !== 'por_verificar') throw new ErrorApp('Este pago ya fue procesado.', 409);
    ejecutar("UPDATE pagos SET estado = 'rechazado', verificado_en = ? WHERE id = ?", ahora(), pagoId);
    const c = uno('SELECT codigo FROM compras WHERE id = ?', p.compra_id);
    bitacora('pago rechazado', `${c.codigo}: ${p.referencia}`);
    return detalleCompra(p.compra_id);
  }

  function pagadoDe(compraId) {
    return redondear(uno(
      "SELECT COALESCE(SUM(monto_verificado), 0) AS n FROM pagos WHERE compra_id = ? AND estado = 'verificado'", compraId,
    ).n);
  }

  // "Enviar Tablas": asigna tablas libres a la compra (sin duplicados) y manda el mensaje.
  async function enviarTablas(compraId) {
    const c = uno('SELECT * FROM compras WHERE id = ?', compraId);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    if (c.estado !== 'verificada') throw new ErrorApp('Solo se pueden enviar tablas de compras verificadas.', 409);

    const pagado = pagadoDe(compraId);
    if (!(pagado > 0)) throw new ErrorApp('La compra no tiene pagos verificados.', 409);
    if (evento().exigirPagoCompleto && pagado < c.total) {
      throw new ErrorApp('Falta pagar el total para enviar las tablas.', 409);
    }

    const seriales = transaccion(() => {
      const libres = q("SELECT serial FROM tablas WHERE estado = 'disponible' ORDER BY RANDOM() LIMIT ?", c.cantidad)
        .map(r => r.serial);
      if (libres.length < c.cantidad) {
        throw new ErrorApp(`Faltan tablas: hay ${libres.length} disponibles y se piden ${c.cantidad}. Agrega más tablas.`, 409);
      }
      const marcar = db.prepare("UPDATE tablas SET estado = 'vendida', compra_id = ?, vendida_en = ? WHERE serial = ? AND estado = 'disponible'");
      for (const serial of libres) {
        // Si alguien ya la vendió, la comprobación de changes frena la asignación completa.
        if (marcar.run(compraId, ahora(), serial).changes !== 1) {
          throw new ErrorApp('Una tabla cambió de estado mientras se asignaba. Intenta de nuevo.', 409);
        }
      }
      ejecutar("UPDATE compras SET estado = 'enviada', enviada_en = ? WHERE id = ?", ahora(), compraId);
      return libres;
    });

    bitacora('tablas asignadas', `${c.codigo}: ${seriales.join(', ')}`);
    await entregarWhatsApp(c, seriales);
    return detalleCompra(compraId);
  }

  // Reintenta el WhatsApp de una compra ya enviada, con las mismas tablas.
  async function reenviarWhatsapp(compraId) {
    const c = uno('SELECT * FROM compras WHERE id = ?', compraId);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    if (c.estado !== 'enviada') throw new ErrorApp('Esta compra aún no tiene tablas enviadas.', 409);
    const seriales = q('SELECT serial FROM tablas WHERE compra_id = ? ORDER BY serial', compraId).map(r => r.serial);
    await entregarWhatsApp(c, seriales);
    return detalleCompra(compraId);
  }

  async function entregarWhatsApp(c, seriales) {
    try {
      const r = await whatsapp.enviarTablas({ telefono: c.telefono, nombre: c.nombre, seriales });
      if (r.estado === 'enviado') {
        ejecutar("UPDATE compras SET whatsapp_estado = 'enviado', whatsapp_error = NULL WHERE id = ?", c.id);
        bitacora('tablas enviadas', `${c.codigo} por WhatsApp`);
      } else {
        ejecutar("UPDATE compras SET whatsapp_estado = 'manual', whatsapp_error = NULL WHERE id = ?", c.id);
        bitacora('envío manual pendiente', `${c.codigo}: WhatsApp no configurado`);
      }
    } catch (err) {
      ejecutar("UPDATE compras SET whatsapp_estado = 'fallido', whatsapp_error = ? WHERE id = ?", String(err.message).slice(0, 500), c.id);
      bitacora('falló envío WhatsApp', `${c.codigo}: ${err.message}`);
    }
  }

  // Enlace manual para cuando el envío automático no está disponible.
  function enlaceWhatsapp(compraId) {
    const c = uno('SELECT * FROM compras WHERE id = ?', compraId);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    const seriales = q('SELECT serial FROM tablas WHERE compra_id = ? ORDER BY serial', compraId).map(r => r.serial);
    if (!seriales.length) throw new ErrorApp('Esta compra aún no tiene tablas asignadas.', 409);
    return whatsapp.enlaceManual(c.telefono, c.nombre, seriales);
  }

  function marcarEnviadoManual(compraId) {
    const c = uno('SELECT * FROM compras WHERE id = ?', compraId);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    if (c.estado !== 'enviada') throw new ErrorApp('Esta compra aún no tiene tablas asignadas.', 409);
    ejecutar("UPDATE compras SET whatsapp_estado = 'enviado', whatsapp_error = NULL WHERE id = ?", compraId);
    bitacora('envío confirmado a mano', c.codigo);
    return detalleCompra(compraId);
  }

  function rechazarCompra(compraId) {
    const c = uno('SELECT * FROM compras WHERE id = ?', compraId);
    if (!c) throw new ErrorApp('Compra no encontrada.', 404);
    if (c.estado === 'enviada') throw new ErrorApp('Ya se enviaron las tablas; no se puede rechazar.', 409);
    if (c.estado === 'rechazada') throw new ErrorApp('La compra ya está rechazada.', 409);
    if (pagadoDe(compraId) > 0) throw new ErrorApp('Tiene pagos verificados. Regístralo como devolución antes de rechazarla.', 409);
    transaccion(() => {
      ejecutar("UPDATE pagos SET estado = 'rechazado', verificado_en = ? WHERE compra_id = ? AND estado = 'por_verificar'", ahora(), compraId);
      ejecutar("UPDATE compras SET estado = 'rechazada' WHERE id = ?", compraId);
    });
    bitacora('compra rechazada', c.codigo);
    return detalleCompra(compraId);
  }

  function listarCompras({ estado } = {}) {
    const filas = estado
      ? q('SELECT * FROM compras WHERE estado = ? ORDER BY id DESC', estado)
      : q('SELECT * FROM compras ORDER BY id DESC');
    return filas.map(resumenCompra);
  }

  // ---------- Premios ----------
  function premioDTO(p) {
    const tabla = p.serial ? uno('SELECT compra_id FROM tablas WHERE serial = ?', p.serial) : null;
    const compra = tabla?.compra_id ? uno('SELECT * FROM compras WHERE id = ?', tabla.compra_id) : null;
    return {
      id: p.id,
      ronda: p.ronda,
      premio: p.premio,
      monto: p.monto,
      serial: p.serial,
      pagado: Boolean(p.pagado),
      pagadoEn: p.pagado_en,
      ganador: compra ? { compraId: compra.id, codigo: compra.codigo, nombre: compra.nombre, cedula: compra.cedula, telefono: compra.telefono } : null,
    };
  }

  function listarPremios() {
    return q('SELECT * FROM premios ORDER BY id').map(premioDTO);
  }

  function crearPremio(datos) {
    const ronda = texto(datos.ronda, 'Nombre de la ronda', 80);
    const premio = texto(datos.premio, 'Premio', 120);
    const monto = redondear(datos.monto || 0);
    if (monto < 0) throw new ErrorApp('El monto del premio no puede ser negativo.');
    const { lastInsertRowid } = ejecutar('INSERT INTO premios (ronda, premio, monto, creado_en) VALUES (?, ?, ?, ?)', ronda, premio, monto, ahora());
    bitacora('ronda creada', `${ronda}: ${premio}`);
    return premioDTO(uno('SELECT * FROM premios WHERE id = ?', lastInsertRowid));
  }

  // Solo se puede marcar ganadora una tabla vendida. Así un premio siempre tiene un comprador real.
  function asignarGanador(premioId, serialRaw) {
    const serial = String(serialRaw ?? '').trim().toUpperCase();
    const p = uno('SELECT * FROM premios WHERE id = ?', premioId);
    if (!p) throw new ErrorApp('Premio no encontrado.', 404);
    const tabla = uno('SELECT * FROM tablas WHERE serial = ?', serial);
    if (!tabla) throw new ErrorApp('Esa tabla no existe.', 404);
    if (tabla.estado !== 'vendida' || !tabla.compra_id) throw new ErrorApp('Esa tabla no está vendida.', 409);
    ejecutar('UPDATE premios SET serial = ? WHERE id = ?', serial, premioId);
    const compra = uno('SELECT codigo, nombre FROM compras WHERE id = ?', tabla.compra_id);
    bitacora('ganador', `${p.ronda}: ${serial} (${compra.nombre})`);
    return premioDTO(uno('SELECT * FROM premios WHERE id = ?', premioId));
  }

  function quitarGanador(premioId) {
    ejecutar('UPDATE premios SET serial = NULL WHERE id = ? AND pagado = 0', premioId);
    return premioDTO(uno('SELECT * FROM premios WHERE id = ?', premioId));
  }

  function pagarPremio(premioId) {
    const p = uno('SELECT * FROM premios WHERE id = ?', premioId);
    if (!p) throw new ErrorApp('Premio no encontrado.', 404);
    if (!p.serial) throw new ErrorApp('Primero registra la tabla ganadora.', 409);
    if (p.pagado) throw new ErrorApp('Este premio ya fue pagado.', 409);
    ejecutar('UPDATE premios SET pagado = 1, pagado_en = ? WHERE id = ?', ahora(), premioId);
    bitacora('premio pagado', `${p.ronda}: ${p.monto}`);
    return premioDTO(uno('SELECT * FROM premios WHERE id = ?', premioId));
  }

  // ---------- Gastos ----------
  function listarGastos() {
    return q('SELECT * FROM gastos ORDER BY fecha DESC, id DESC').map(g => ({
      id: g.id, fecha: g.fecha, concepto: g.concepto, categoria: g.categoria, monto: g.monto,
    }));
  }

  function crearGasto(datos) {
    const concepto = texto(datos.concepto, 'Concepto');
    const categoria = texto(datos.categoria || 'Otros', 'Categoría', 40);
    const monto = montoPositivo(datos.monto, 'El monto');
    const fecha = String(datos.fecha || ahora().slice(0, 10)).slice(0, 10);
    ejecutar('INSERT INTO gastos (fecha, concepto, categoria, monto, creado_en) VALUES (?, ?, ?, ?, ?)', fecha, concepto, categoria, monto, ahora());
    bitacora('gasto', `${concepto}: ${monto}`);
    return { ok: true };
  }

  function eliminarGasto(id) {
    const g = uno('SELECT * FROM gastos WHERE id = ?', id);
    if (!g) throw new ErrorApp('Gasto no encontrado.', 404);
    ejecutar('DELETE FROM gastos WHERE id = ?', id);
    bitacora('gasto eliminado', `${g.concepto}: ${g.monto}`);
    return { ok: true };
  }

  function pagoConComprobante(pagoId) {
    const p = uno('SELECT * FROM pagos WHERE id = ?', pagoId);
    if (!p || !p.comprobante_archivo) throw new ErrorApp('Comprobante no encontrado.', 404);
    return p;
  }

  // ---------- Resumen y reportes ----------
  function resumen() {
    const compras = q("SELECT * FROM compras WHERE estado != 'rechazada'").map(resumenCompra);
    const cobrado = redondear(uno("SELECT COALESCE(SUM(monto_verificado), 0) AS n FROM pagos WHERE estado = 'verificado'").n);
    const porVerificar = redondear(uno("SELECT COALESCE(SUM(monto_reportado), 0) AS n FROM pagos WHERE estado = 'por_verificar'").n);
    const premiosPagados = redondear(uno('SELECT COALESCE(SUM(monto), 0) AS n FROM premios WHERE pagado = 1').n);
    const premiosProgramados = redondear(uno('SELECT COALESCE(SUM(monto), 0) AS n FROM premios').n);
    const gastos = redondear(uno('SELECT COALESCE(SUM(monto), 0) AS n FROM gastos').n);
    const porCobrar = redondear(compras.reduce((s, c) => s + c.saldo, 0));
    const porEnviar = compras.filter(c => c.estado === 'verificada');

    const porMetodo = q(
      "SELECT metodo, SUM(monto_verificado) AS monto FROM pagos WHERE estado = 'verificado' GROUP BY metodo ORDER BY monto DESC",
    ).map(r => ({ metodo: r.metodo, monto: redondear(r.monto) }));

    const t = uno(`SELECT
      SUM(CASE WHEN estado = 'disponible' THEN 1 ELSE 0 END) AS disponibles,
      SUM(CASE WHEN estado = 'vendida' THEN 1 ELSE 0 END) AS vendidas
      FROM tablas`);
    const entregadas = uno("SELECT COALESCE(SUM(cantidad), 0) AS n FROM compras WHERE estado = 'enviada'").n;
    const pendientesEnvio = uno("SELECT COALESCE(SUM(cantidad), 0) AS n FROM compras WHERE estado = 'verificada'").n;
    const porVerificarCompras = uno("SELECT COUNT(*) AS n FROM compras WHERE estado = 'por_verificar'").n;
    const tablasVendidas = uno("SELECT COALESCE(SUM(cantidad), 0) AS n FROM compras WHERE estado IN ('verificada','enviada')").n;

    return {
      dinero: {
        cobrado,
        porVerificar,
        porCobrar,
        premiosPagados,
        premiosProgramados,
        gastos,
        balance: redondear(cobrado - premiosPagados - gastos),
        porMetodo,
      },
      tablas: {
        total: (t.disponibles || 0) + (t.vendidas || 0),
        disponibles: t.disponibles || 0,
        vendidas: t.vendidas || 0,
        libresParaVender: tablasLibresParaVender(),
        porEnviar: pendientesEnvio,
        entregadas,
        tablasVendidas,
      },
      compras: {
        porVerificar: porVerificarCompras,
        listasParaEnviar: porEnviar.length,
        conDeuda: compras.filter(c => c.saldo > 0).length,
      },
      evento: evento(),
    };
  }

  function bitacoraLista(limite = 100) {
    return q('SELECT * FROM bitacora ORDER BY id DESC LIMIT ?', limite);
  }

  // Filas para exportar. Cada reporte devuelve { encabezados, filas }.
  function reporte(nombre) {
    if (nombre === 'compras') {
      const filas = q('SELECT * FROM compras ORDER BY id').map(resumenCompra);
      return {
        encabezados: ['Código', 'Fecha', 'Nombre', 'Cédula', 'Teléfono', 'Correo', 'Tablas', 'Total', 'Pagado', 'Saldo', 'Estado', 'WhatsApp', 'Seriales'],
        filas: filas.map(c => [c.codigo, c.creadaEn.slice(0, 10), c.nombre, c.cedula, c.telefono, c.correo, c.cantidad, c.total, c.pagado, c.saldo, c.estado, c.whatsappEstado, c.tablas.join(' ')]),
      };
    }
    if (nombre === 'deudas') {
      const filas = q("SELECT * FROM compras WHERE estado != 'rechazada' ORDER BY id").map(resumenCompra).filter(c => c.saldo > 0);
      return {
        encabezados: ['Código', 'Nombre', 'Cédula', 'Teléfono', 'Total', 'Pagado', 'Debe'],
        filas: filas.map(c => [c.codigo, c.nombre, c.cedula, c.telefono, c.total, c.pagado, c.saldo]),
      };
    }
    if (nombre === 'pagos') {
      const filas = q('SELECT p.*, c.codigo, c.nombre FROM pagos p JOIN compras c ON c.id = p.compra_id ORDER BY p.id');
      return {
        encabezados: ['Fecha', 'Código', 'Nombre', 'Monto reportado', 'Monto verificado', 'Método', 'Referencia', 'Estado'],
        filas: filas.map(p => [p.creado_en.slice(0, 10), p.codigo, p.nombre, p.monto_reportado, p.monto_verificado ?? '', p.metodo, p.referencia, p.estado]),
      };
    }
    if (nombre === 'tablas') {
      const filas = q(`SELECT t.serial, t.estado, t.vendida_en, c.codigo, c.nombre, c.cedula, c.telefono
        FROM tablas t LEFT JOIN compras c ON c.id = t.compra_id ORDER BY t.serial`);
      return {
        encabezados: ['Serial', 'Estado', 'Vendida en', 'Código compra', 'Nombre', 'Cédula', 'Teléfono'],
        filas: filas.map(t => [t.serial, t.estado, t.vendida_en ?? '', t.codigo ?? '', t.nombre ?? '', t.cedula ?? '', t.telefono ?? '']),
      };
    }
    if (nombre === 'premios') {
      return {
        encabezados: ['Ronda', 'Premio', 'Monto', 'Serial', 'Ganador', 'Cédula', 'Teléfono', 'Pagado'],
        filas: listarPremios().map(p => [p.ronda, p.premio, p.monto, p.serial ?? '', p.ganador?.nombre ?? '', p.ganador?.cedula ?? '', p.ganador?.telefono ?? '', p.pagado ? 'sí' : 'no']),
      };
    }
    if (nombre === 'gastos') {
      return {
        encabezados: ['Fecha', 'Concepto', 'Categoría', 'Monto'],
        filas: listarGastos().map(g => [g.fecha, g.concepto, g.categoria, g.monto]),
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
    listarPremios, crearPremio, asignarGanador, quitarGanador, pagarPremio,
    listarGastos, crearGasto, eliminarGasto,
    pagoConComprobante,
    resumen, bitacoraLista, reporte,
  };
}

module.exports = { crearServicios, ErrorApp, redondear };
