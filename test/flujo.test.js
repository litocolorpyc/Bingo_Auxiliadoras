const test = require('node:test');
const assert = require('node:assert/strict');
const { abrirBase } = require('../src/db');
const { crearServicios, ErrorApp } = require('../src/servicios');
const { crearWhatsApp } = require('../src/whatsapp');

function nuevo({ whatsapp } = {}) {
  const db = abrirBase(':memory:');
  const s = crearServicios({ db, whatsapp: whatsapp || crearWhatsApp({}) });
  s.actualizarEvento({ nombre: 'Prueba', precioTabla: 10, moneda: 'USD' });
  return s;
}

const datos = (n, extra = {}) => ({
  nombre: 'Ana Pérez', cedula: 'V-1', telefono: '04121234567', correo: 'a@x.com',
  cantidad: n, metodo: 'Pago móvil', referencia: 'REF' + Math.random(), ...extra,
});

function tablasParaVender(s, n) {
  s.importarTablas(Array.from({ length: n }, (_, i) => `TBL-${String(i).padStart(4, '0')}`).join('\n'));
}

test('no se puede enviar una tabla dos veces', async () => {
  const s = nuevo();
  tablasParaVender(s, 5);
  const a = s.crearCompra(datos(3));
  const b = s.crearCompra(datos(2));
  s.verificarPago(s.detalleCompra(a.id).pagos[0].id, 30);
  s.verificarPago(s.detalleCompra(b.id).pagos[0].id, 20);
  const ea = await s.enviarTablas(a.id);
  const eb = await s.enviarTablas(b.id);
  const todas = [...ea.tablas, ...eb.tablas];
  assert.equal(new Set(todas).size, 5, 'los 5 seriales son distintos');
  assert.equal(s.resumen().tablas.disponibles, 0);
});

test('no se vende más de lo que hay disponible', () => {
  const s = nuevo();
  tablasParaVender(s, 4);
  s.crearCompra(datos(3));
  assert.throws(() => s.crearCompra(datos(2)), err => err instanceof ErrorApp && err.status === 409);
});

test('rechazar compra libera las tablas comprometidas', () => {
  const s = nuevo();
  tablasParaVender(s, 2);
  const c = s.crearCompra(datos(2));
  assert.equal(s.resumen().tablas.libresParaVender, 0);
  s.rechazarCompra(c.id);
  assert.equal(s.resumen().tablas.libresParaVender, 2);
});

test('enviar exige pago verificado y compra verificada', async () => {
  const s = nuevo();
  tablasParaVender(s, 2);
  const c = s.crearCompra(datos(1));
  await assert.rejects(s.enviarTablas(c.id), /verificadas/);
  s.verificarPago(s.detalleCompra(c.id).pagos[0].id, 10);
  const enviada = await s.enviarTablas(c.id);
  assert.equal(enviada.estado, 'enviada');
  await assert.rejects(s.enviarTablas(c.id), /verificadas/, 'no se envía dos veces');
});

test('saldo y deuda: pagos parciales', () => {
  const s = nuevo();
  tablasParaVender(s, 5);
  const c = s.crearCompra(datos(3, { montoPagado: 12 }));
  s.verificarPago(s.detalleCompra(c.id).pagos[0].id, 12);
  let d = s.detalleCompra(c.id);
  assert.equal(d.total, 30);
  assert.equal(d.pagado, 12);
  assert.equal(d.saldo, 18);
  assert.equal(s.resumen().dinero.porCobrar, 18);
  s.registrarPagoManual(c.id, { monto: 18, metodo: 'Efectivo' });
  d = s.detalleCompra(c.id);
  assert.equal(d.saldo, 0);
  assert.equal(d.estado, 'verificada');
});

test('verificar con monto 0 o pago ya procesado falla', () => {
  const s = nuevo();
  tablasParaVender(s, 1);
  const c = s.crearCompra(datos(1));
  const pid = s.detalleCompra(c.id).pagos[0].id;
  assert.throws(() => s.verificarPago(pid, 0), /mayor que 0/);
  s.verificarPago(pid, 10);
  assert.throws(() => s.verificarPago(pid, 10), /ya fue procesado/);
});

test('no se rechaza una compra con dinero verificado', () => {
  const s = nuevo();
  tablasParaVender(s, 1);
  const c = s.crearCompra(datos(1));
  s.verificarPago(s.detalleCompra(c.id).pagos[0].id, 10);
  assert.throws(() => s.rechazarCompra(c.id), /devolución/);
});

test('premio: solo se puede asignar una tabla vendida y de compra real', async () => {
  const s = nuevo();
  tablasParaVender(s, 2);
  const c = s.crearCompra(datos(1));
  s.verificarPago(s.detalleCompra(c.id).pagos[0].id, 10);
  const p = s.crearPremio({ ronda: 'Línea', premio: 'Cena', monto: 50 });
  assert.throws(() => s.asignarGanador(p.id, 'TBL-0000'), /no está vendida/);
  assert.throws(() => s.asignarGanador(p.id, 'NO-EXISTE'), /no existe/);
  const enviada = await s.enviarTablas(c.id);
  const g = s.asignarGanador(p.id, enviada.tablas[0]);
  assert.equal(g.ganador.nombre, 'Ana Pérez');
  assert.throws(() => s.pagarPremio(p.id + 99), /no encontrado/);
  s.pagarPremio(p.id);
  assert.equal(s.resumen().dinero.premiosPagados, 50);
});

test('balance en caja = cobrado - premios pagados - gastos', () => {
  const s = nuevo();
  tablasParaVender(s, 3);
  const c = s.crearCompra(datos(3));
  s.verificarPago(s.detalleCompra(c.id).pagos[0].id, 30);
  s.crearGasto({ concepto: 'Sala', monto: 8, categoria: 'Logística' });
  assert.equal(s.resumen().dinero.balance, 22);
});

test('teléfono venezolano se normaliza y se valida', () => {
  const s = nuevo();
  tablasParaVender(s, 1);
  const c = s.crearCompra(datos(1, { telefono: '0412-123 4567' }));
  assert.equal(s.detalleCompra(c.id).telefono, '584121234567');
  assert.throws(() => s.crearCompra(datos(1, { telefono: '12' })), /no es válido/);
});

test('generar tablas no repite seriales y respeta límites', () => {
  const s = nuevo();
  assert.equal(s.generarTablas(120).creadas, 120);
  assert.equal(s.tablasDisponibles(), 120);
  assert.throws(() => s.generarTablas(501), /entre 1 y 500/);
  const seriales = s.listarTablas().map(t => t.serial);
  assert.equal(new Set(seriales).size, 120);
});

test('reporte de deudas solo incluye saldos positivos', () => {
  const s = nuevo();
  tablasParaVender(s, 2);
  s.crearCompra(datos(1));
  const r = s.reporte('deudas');
  assert.equal(r.filas.length, 1);
  assert.throws(() => s.reporte('nada'), /no existe/);
});

test('si WhatsApp falla la compra queda enviada y se puede reintentar', async () => {
  let intentos = 0;
  const whatsapp = {
    normalizarTelefono: t => String(t).replace(/\D/g, ''),
    enviarTablas: async () => { intentos++; if (intentos === 1) throw new Error('caída'); return { estado: 'enviado' }; },
    enlaceManual: () => 'https://wa.me/x',
  };
  const s = nuevo({ whatsapp });
  tablasParaVender(s, 1);
  const c = s.crearCompra(datos(1));
  s.verificarPago(s.detalleCompra(c.id).pagos[0].id, 10);
  const e1 = await s.enviarTablas(c.id);
  assert.equal(e1.estado, 'enviada');
  assert.equal(e1.whatsappEstado, 'fallido');
  const e2 = await s.reenviarWhatsapp(c.id);
  assert.equal(e2.whatsappEstado, 'enviado');
  assert.deepEqual(e2.tablas, e1.tablas, 'mismas tablas al reintentar');
});
