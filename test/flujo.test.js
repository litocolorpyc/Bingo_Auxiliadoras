const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { desdePglite } = require('../src/db');
const { crearServicios, ErrorApp } = require('../src/servicios');
const { crearWhatsApp } = require('../src/whatsapp');

const ESQUEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'esquema.sql'), 'utf8');

async function nuevo({ whatsapp } = {}) {
  const pg = new PGlite();
  const db = desdePglite(pg);
  await db.exec(ESQUEMA);
  const s = crearServicios({ db, whatsapp: whatsapp || crearWhatsApp({}) });
  await s.actualizarEvento({ nombre: 'Prueba', precioTabla: 10, moneda: 'USD' });
  return s;
}

const ruta = () => `comprobantes/${require('node:crypto').randomBytes(16).toString('hex')}.png`;
const comprobante = () => [{ ruta: ruta(), nombre: 'pago.png', tipo: 'image/png' }];

const datos = (n, extra = {}) => ({
  nombre: 'Ana Pérez', cedula: 'V-1', telefono: '04121234567', correo: 'a@x.com',
  cantidad: n, metodo: 'Pago móvil', referencia: 'REF' + Math.random(), ...extra,
});

async function tablas(s, n) {
  await s.importarTablas(Array.from({ length: n }, (_, i) => `TBL-${String(i).padStart(4, '0')}`).join('\n'));
}

async function comprar(s, n, extra = {}) {
  const c = await s.crearCompra(datos(n, extra), comprobante());
  return c;
}

async function verificarTodo(s, compraId, monto) {
  const d = await s.detalleCompra(compraId);
  return s.verificarPago(d.pagos[0].id, monto ?? d.total);
}

test('no se puede enviar una tabla dos veces', async () => {
  const s = await nuevo();
  await tablas(s, 5);
  const a = await comprar(s, 3);
  const b = await comprar(s, 2);
  await verificarTodo(s, a.id);
  await verificarTodo(s, b.id);
  const ea = await s.enviarTablas(a.id);
  const eb = await s.enviarTablas(b.id);
  const todas = [...ea.tablas, ...eb.tablas];
  assert.equal(new Set(todas).size, 5);
  assert.equal((await s.resumen()).tablas.disponibles, 0);
});

test('envíos simultáneos reciben tablas distintas', async () => {
  const s = await nuevo();
  await tablas(s, 4);
  const a = await comprar(s, 2);
  const b = await comprar(s, 2);
  await verificarTodo(s, a.id);
  await verificarTodo(s, b.id);
  const [ea, eb] = await Promise.all([s.enviarTablas(a.id), s.enviarTablas(b.id)]);
  const todas = [...ea.tablas, ...eb.tablas];
  assert.equal(new Set(todas).size, 4, 'ninguna tabla se repite');
  assert.equal((await s.listarTablas()).filter(t => t.estado === 'vendida').length, 4);
});

test('no se vende más de lo que hay disponible', async () => {
  const s = await nuevo();
  await tablas(s, 4);
  await comprar(s, 3);
  await assert.rejects(comprar(s, 2), err => err instanceof ErrorApp && err.status === 409);
});

test('rechazar compra libera las tablas comprometidas', async () => {
  const s = await nuevo();
  await tablas(s, 2);
  const c = await comprar(s, 2);
  assert.equal(await s.tablasLibresParaVender(), 0);
  await s.rechazarCompra(c.id);
  assert.equal(await s.tablasLibresParaVender(), 2);
});

test('enviar exige pago verificado y compra verificada', async () => {
  const s = await nuevo();
  await tablas(s, 2);
  const c = await comprar(s, 1);
  await assert.rejects(s.enviarTablas(c.id), /verificadas/);
  await verificarTodo(s, c.id);
  const enviada = await s.enviarTablas(c.id);
  assert.equal(enviada.estado, 'enviada');
  await assert.rejects(s.enviarTablas(c.id), /verificadas/);
});

test('saldo y deuda con pagos parciales', async () => {
  const s = await nuevo();
  await tablas(s, 5);
  const c = await comprar(s, 3, { montoPagado: 12 });
  await verificarTodo(s, c.id, 12);
  let d = await s.detalleCompra(c.id);
  assert.equal(d.total, 30);
  assert.equal(d.pagado, 12);
  assert.equal(d.saldo, 18);
  assert.equal((await s.resumen()).dinero.porCobrar, 18);
  await s.registrarPagoManual(c.id, { monto: 18, metodo: 'Efectivo' });
  d = await s.detalleCompra(c.id);
  assert.equal(d.saldo, 0);
  assert.equal(d.estado, 'verificada');
});

test('verificar con monto 0 o pago ya procesado falla', async () => {
  const s = await nuevo();
  await tablas(s, 1);
  const c = await comprar(s, 1);
  const pid = (await s.detalleCompra(c.id)).pagos[0].id;
  await assert.rejects(s.verificarPago(pid, 0), /mayor que 0/);
  await s.verificarPago(pid, 10);
  await assert.rejects(s.verificarPago(pid, 10), /ya fue procesado/);
});

test('no se rechaza una compra con dinero verificado', async () => {
  const s = await nuevo();
  await tablas(s, 1);
  const c = await comprar(s, 1);
  await verificarTodo(s, c.id);
  await assert.rejects(s.rechazarCompra(c.id), /devolución/);
});

test('premio: solo tabla vendida y de compra real', async () => {
  const s = await nuevo();
  await tablas(s, 2);
  const c = await comprar(s, 1);
  await verificarTodo(s, c.id);
  const p = await s.crearPremio({ ronda: 'Línea', premio: 'Cena', monto: 50 });
  await assert.rejects(s.asignarGanador(p.id, 'TBL-0000'), /no está vendida/);
  await assert.rejects(s.asignarGanador(p.id, 'NO-EXISTE'), /no existe/);
  const enviada = await s.enviarTablas(c.id);
  const g = await s.asignarGanador(p.id, enviada.tablas[0]);
  assert.equal(g.ganador.nombre, 'Ana Pérez');
  await s.pagarPremio(p.id);
  assert.equal((await s.resumen()).dinero.premiosPagados, 50);
});

test('balance en caja = cobrado - premios pagados - gastos', async () => {
  const s = await nuevo();
  await tablas(s, 3);
  const c = await comprar(s, 3);
  await verificarTodo(s, c.id, 30);
  await s.crearGasto({ concepto: 'Sala', monto: 8, categoria: 'Logística' });
  assert.equal((await s.resumen()).dinero.balance, 22);
});

test('teléfono venezolano se normaliza y se valida', async () => {
  const s = await nuevo();
  await tablas(s, 1);
  const c = await comprar(s, 1, { telefono: '0412-123 4567' });
  assert.equal((await s.detalleCompra(c.id)).telefono, '584121234567');
  await assert.rejects(comprar(s, 1, { telefono: '12' }), /no es válido/);
});

test('compra exige al menos un comprobante', async () => {
  const s = await nuevo();
  await tablas(s, 1);
  await assert.rejects(s.crearCompra(datos(1), []), /comprobante/);
});

test('el comprobante queda ligado al pago', async () => {
  const s = await nuevo();
  await tablas(s, 1);
  const c = await comprar(s, 1);
  const d = await s.detalleCompra(c.id);
  assert.equal(d.pagos[0].comprobantes.length, 1);
  assert.equal(d.pagos[0].comprobantes[0].nombre, 'pago.png');
});

test('generar tablas no repite seriales y respeta límites', async () => {
  const s = await nuevo();
  assert.equal((await s.generarTablas(120)).creadas, 120);
  assert.equal(await s.tablasDisponibles(), 120);
  await assert.rejects(s.generarTablas(501), /entre 1 y 500/);
  const seriales = (await s.listarTablas()).map(t => t.serial);
  assert.equal(new Set(seriales).size, 120);
});

test('importar ignora repetidos y vacíos', async () => {
  const s = await nuevo();
  const r = await s.importarTablas('BNG-A\nbng-a\n\nBNG-B, BNG-C');
  assert.deepEqual([r.leidas, r.insertadas, r.repetidas], [3, 3, 0]);
  const r2 = await s.importarTablas('BNG-A,BNG-D');
  assert.deepEqual([r2.insertadas, r2.repetidas], [1, 1]);
});

test('reporte de deudas solo incluye saldos positivos', async () => {
  const s = await nuevo();
  await tablas(s, 2);
  await comprar(s, 1);
  const r = await s.reporte('deudas');
  assert.equal(r.filas.length, 1);
  await assert.rejects(s.reporte('nada'), /no existe/);
});

test('si WhatsApp falla la compra queda enviada y se reintenta con las mismas tablas', async () => {
  let intentos = 0;
  const whatsapp = {
    normalizarTelefono: t => String(t).replace(/\D/g, ''),
    enviarTablas: async () => { intentos++; if (intentos === 1) throw new Error('caída'); return { estado: 'enviado' }; },
    enlaceManual: () => 'https://wa.me/x',
  };
  const s = await nuevo({ whatsapp });
  await tablas(s, 1);
  const c = await comprar(s, 1);
  await verificarTodo(s, c.id);
  const e1 = await s.enviarTablas(c.id);
  assert.equal(e1.estado, 'enviada');
  assert.equal(e1.whatsappEstado, 'fallido');
  const e2 = await s.reenviarWhatsapp(c.id);
  assert.equal(e2.whatsappEstado, 'enviado');
  assert.deepEqual(e2.tablas, e1.tablas);
});
