const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let moneda = '';
let vistaActual = 'resumen';
let filtroCompras = 'por_verificar';

const dinero = n => `${moneda ? moneda + ' ' : ''}${Number(n || 0).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fecha = s => s ? String(s).slice(0, 16).replace('T', ' ') : '';

async function api(metodo, url, cuerpo) {
  const res = await fetch('/api' + url, {
    method: metodo,
    headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { mostrarLogin(); throw new Error('Sesión vencida. Vuelve a entrar.'); }
  if (!res.ok) throw new Error(data.error || 'Error inesperado.');
  return data;
}

function msg(texto, malo) {
  $('msg').textContent = texto;
  $('msg').className = 'msg' + (malo ? ' bad' : '');
}

async function accion(fn, ok) {
  try {
    await fn();
    if (ok) msg(ok);
  } catch (err) {
    msg(err.message, true);
  }
}

function mostrarLogin() {
  $('panel').hidden = true;
  $('login').hidden = false;
}

const VISTAS = {
  resumen: { titulo: 'Resumen', render: renderResumen },
  compras: { titulo: 'Compras', render: renderCompras },
  tablas: { titulo: 'Tablas', render: renderTablas },
  premios: { titulo: 'Premios', render: renderPremios },
  gastos: { titulo: 'Gastos', render: renderGastos },
  config: { titulo: 'Configuración', render: renderConfig },
  reportes: { titulo: 'Reportes', render: renderReportes },
  bitacora: { titulo: 'Bitácora', render: renderBitacora },
};

function dibujarTabs() {
  $('tabs').innerHTML = Object.entries(VISTAS).map(([k, v]) =>
    `<button type="button" data-vista="${k}" aria-selected="${k === vistaActual}">${v.titulo}</button>`).join('');
}

async function mostrar(nombre) {
  vistaActual = nombre;
  dibujarTabs();
  msg('');
  try {
    await VISTAS[nombre].render();
  } catch (err) {
    msg(err.message, true);
  }
}

$('tabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-vista]');
  if (b) mostrar(b.dataset.vista);
});

$('form-login').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('POST', '/admin/login', { clave: e.target.clave.value });
    e.target.reset();
    $('login-msg').textContent = '';
    await entrar();
  } catch (err) {
    $('login-msg').textContent = err.message;
  }
});

$('salir').addEventListener('click', async () => {
  await api('POST', '/admin/logout').catch(() => {});
  mostrarLogin();
});

async function entrar() {
  const r = await api('GET', '/admin/resumen');
  moneda = r.evento.moneda;
  $('titulo').textContent = r.evento.nombre || 'Bingo';
  $('login').hidden = true;
  $('panel').hidden = false;
  mostrar(vistaActual);
}

// ---------- Resumen ----------
async function renderResumen() {
  const r = await api('GET', '/admin/resumen');
  const d = r.dinero;
  const t = r.tablas;
  $('vista').innerHTML = `
    <h2>Dinero</h2>
    <div class="stats">
      <div class="card stat"><span class="muted">Cobrado (verificado)</span><strong>${dinero(d.cobrado)}</strong></div>
      <div class="card stat"><span class="muted">Por verificar</span><strong>${dinero(d.porVerificar)}</strong></div>
      <div class="card stat"><span class="muted">Por cobrar (deuda)</span><strong>${dinero(d.porCobrar)}</strong></div>
      <div class="card stat"><span class="muted">Premios pagados</span><strong>${dinero(d.premiosPagados)}</strong></div>
      <div class="card stat"><span class="muted">Gastos</span><strong>${dinero(d.gastos)}</strong></div>
      <div class="card stat"><span class="muted">Balance en caja</span><strong class="${d.balance < 0 ? 'neg' : ''}">${dinero(d.balance)}</strong></div>
    </div>
    <p class="muted">Premios programados: ${dinero(d.premiosProgramados)} · Balance si se cobra todo lo pendiente: ${dinero(d.balance + d.porCobrar)}</p>
    <div class="card"><h2>Cobrado por método</h2>
      ${d.porMetodo.map(m => `<div class="kv"><span>${esc(m.metodo)}</span><strong>${dinero(m.monto)}</strong></div>`).join('') || '<p class="muted">Aún no hay pagos verificados.</p>'}
    </div>
    <h2>Tablas</h2>
    <div class="stats">
      <div class="card stat"><span class="muted">Disponibles</span><strong>${t.disponibles}</strong></div>
      <div class="card stat"><span class="muted">Libres para vender</span><strong>${t.libresParaVender}</strong></div>
      <div class="card stat"><span class="muted">Vendidas</span><strong>${t.vendidas}</strong></div>
      <div class="card stat"><span class="muted">Por enviar</span><strong>${t.porEnviar}</strong></div>
      <div class="card stat"><span class="muted">Entregadas</span><strong>${t.entregadas}</strong></div>
    </div>
    <h2>Pendientes</h2>
    <div class="card">
      <div class="kv"><span>Pagos por verificar</span><strong>${r.compras.porVerificar} compra(s)</strong></div>
      <div class="kv"><span>Listas para enviar tablas</span><strong>${r.compras.listasParaEnviar} compra(s)</strong></div>
      <div class="kv"><span>Compras con deuda</span><strong>${r.compras.conDeuda}</strong></div>
    </div>`;
}

// ---------- Compras ----------
const ESTADOS_COMPRA = [['por_verificar', 'Por verificar'], ['verificada', 'Listas para enviar'], ['enviada', 'Enviadas'], ['rechazada', 'Rechazadas'], ['', 'Todas']];

async function renderCompras() {
  const compras = await api('GET', '/admin/compras' + (filtroCompras ? `?estado=${filtroCompras}` : ''));
  $('vista').innerHTML = `
    <div class="tabs">${ESTADOS_COMPRA.map(([k, t]) =>
      `<button type="button" class="${filtroCompras === k ? '' : 'ghost'}" data-filtro="${k}">${t}</button>`).join('')}</div>
    <div id="lista">${compras.map(tarjetaCompra).join('') || '<p class="muted">No hay compras en esta lista.</p>'}</div>`;
}

function tarjetaCompra(c) {
  const saldo = c.saldo > 0 ? `<span class="neg">Debe ${dinero(c.saldo)}</span>` : '<span>Al día</span>';
  return `
  <article class="card" data-compra="${c.id}">
    <div class="row">
      <strong>${esc(c.nombre)}</strong>
      <span class="pill ${esc(c.estado)}">${esc(c.estado.replace('_', ' '))}</span>
    </div>
    <p class="muted">${esc(c.codigo)} · Cédula ${esc(c.cedula)} · ${esc(c.telefono)} · ${esc(c.correo)}</p>
    <p>${c.cantidad} tabla(s) · Total ${dinero(c.total)} · Pagado ${dinero(c.pagado)} · ${saldo}</p>
    ${c.tablas.length ? `<p class="mono">${c.tablas.map(esc).join(', ')}</p>` : ''}
    ${c.estado === 'enviada' ? `<p class="muted">WhatsApp: <span class="pill ${esc(c.whatsappEstado === 'enviado' ? 'enviada' : c.whatsappEstado)}">${esc(c.whatsappEstado)}</span> ${c.whatsappError ? `<span class="neg">${esc(c.whatsappError)}</span>` : ''}</p>` : ''}
    <div class="actions" data-acciones>
      ${botonesCompra(c)}
    </div>
    <details style="margin-top:12px"><summary class="muted">Pagos y comprobantes</summary>
      <div data-pagos></div>
    </details>
  </article>`;
}

function botonesCompra(c) {
  const b = [];
  if (c.estado === 'verificada') b.push(`<button type="button" data-act="enviar" data-id="${c.id}">Enviar Tablas</button>`);
  if (c.estado === 'enviada') {
    b.push(`<button type="button" class="ghost" data-act="reenviar" data-id="${c.id}">Reintentar WhatsApp</button>`);
    b.push(`<button type="button" class="ghost" data-act="enlace" data-id="${c.id}">Abrir WhatsApp manual</button>`);
    if (c.whatsappEstado !== 'enviado') b.push(`<button type="button" class="ghost" data-act="marcar" data-id="${c.id}">Marcar como enviado</button>`);
  }
  if (c.estado === 'por_verificar' || c.estado === 'verificada') {
    b.push(`<button type="button" class="danger" data-act="rechazar" data-id="${c.id}">Rechazar compra</button>`);
  }
  return b.join('');
}

// Al abrir la tarjeta de pagos, se carga el detalle de la compra.
async function cargarPagos(card) {
  const id = card.dataset.compra;
  const d = await api('GET', `/admin/compras/${id}`);
  const pagosHtml = d.pagos.map(p => `
    <div class="kv" style="flex-direction:column;align-items:flex-start">
      <div class="row" style="width:100%">
        <span>${esc(p.metodo)} · Ref. <span class="mono">${esc(p.referencia)}</span> · ${esc(fecha(p.creadoEn))}</span>
        <span class="pill ${esc(p.estado)}">${esc(p.estado.replace('_', ' '))}</span>
      </div>
      <span class="muted">Reportado ${dinero(p.montoReportado)}${p.montoVerificado != null ? ` · Verificado ${dinero(p.montoVerificado)}` : ''}</span>
      ${p.comprobantes.map(c => `<button type="button" class="ghost" data-act="ver-comprobante" data-id="${c.id}">Ver ${esc(c.nombre)}</button>`).join('')}
      ${p.estado === 'por_verificar' ? `
        <div class="row" style="width:100%;margin-top:6px">
          <label style="flex:1 1 160px">Monto recibido <input type="number" min="0.01" step="0.01" value="${p.montoReportado}" data-monto="${p.id}"></label>
          <div class="actions">
            <button type="button" data-act="verificar-pago" data-id="${p.id}">Verificar pago</button>
            <button type="button" class="danger" data-act="rechazar-pago" data-id="${p.id}">Rechazar</button>
          </div>
        </div>` : ''}
    </div>`).join('') || '<p class="muted">Sin pagos.</p>';

  const manual = d.estado !== 'rechazada' ? `
    <form class="row" data-pago-manual="${d.id}" style="margin-top:10px">
      <label style="flex:1 1 120px">Monto <input name="monto" type="number" min="0.01" step="0.01" required></label>
      <label style="flex:1 1 120px">Método
        <select name="metodo"><option>Efectivo</option><option>Pago móvil</option><option>Transferencia</option><option>Zelle</option></select>
      </label>
      <label style="flex:1 1 120px">Referencia <input name="referencia" maxlength="60"></label>
      <button type="submit" class="ghost">Registrar pago recibido</button>
    </form>` : '';
  card.querySelector('[data-pagos]').innerHTML = pagosHtml + manual;
}

$('vista').addEventListener('click', async e => {
  const f = e.target.closest('button[data-filtro]');
  if (f) { filtroCompras = f.dataset.filtro; return mostrar('compras'); }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  btn.disabled = true;
  try {
    if (act === 'ver-comprobante') {
      window.open(`/api/admin/comprobantes/${id}/archivo`, '_blank', 'noopener');
      return;
    }
    if (act === 'enviar') {
      if (!confirm('¿Asignar tablas y enviarlas por WhatsApp?')) return;
      const r = await api('POST', `/admin/compras/${id}/enviar`);
      if (r.whatsappEstado === 'manual') {
        msg('Tablas asignadas. WhatsApp no está configurado: usa "Abrir WhatsApp manual".');
      } else if (r.whatsappEstado === 'fallido') {
        msg('Tablas asignadas, pero WhatsApp falló: ' + r.whatsappError, true);
      } else {
        msg('Tablas enviadas por WhatsApp.');
      }
      filtroCompras = 'enviada';
      return mostrar('compras');
    }
    if (act === 'reenviar') {
      const r = await api('POST', `/admin/compras/${id}/reenviar`);
      msg(r.whatsappEstado === 'enviado' ? 'Enviado por WhatsApp.' : 'Sigue sin enviarse. Revisa el error o usa el envío manual.', r.whatsappEstado !== 'enviado');
      return mostrar('compras');
    }
    if (act === 'enlace') {
      const { enlace } = await api('GET', `/admin/compras/${id}/enlace-whatsapp`);
      window.open(enlace, '_blank', 'noopener');
      msg('Se abrió WhatsApp. Envía el mensaje y luego usa "Marcar como enviado".');
    }
    if (act === 'marcar') {
      await api('POST', `/admin/compras/${id}/envio-manual`);
      msg('Marcada como enviada.');
      return mostrar('compras');
    }
    if (act === 'rechazar') {
      if (!confirm('¿Rechazar esta compra? Sus tablas quedarán libres para otros compradores.')) return;
      await api('POST', `/admin/compras/${id}/rechazar`);
      msg('Compra rechazada.');
      return mostrar('compras');
    }
    if (act === 'verificar-pago') {
      const monto = Number(document.querySelector(`[data-monto="${id}"]`).value);
      await api('POST', `/admin/pagos/${id}/verificar`, { montoVerificado: monto });
      msg('Pago verificado. Ya puedes usar "Enviar Tablas".');
      filtroCompras = 'verificada';
      return mostrar('compras');
    }
    if (act === 'rechazar-pago') {
      if (!confirm('¿Rechazar este pago?')) return;
      await api('POST', `/admin/pagos/${id}/rechazar`);
      msg('Pago rechazado.');
      return mostrar('compras');
    }
  } catch (err) {
    msg(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

// Carga los pagos al abrir el detalle de la compra.
$('vista').addEventListener('toggle', e => {
  const card = e.target.closest('[data-compra]');
  if (card && e.target.open && !card.dataset.cargado) {
    card.dataset.cargado = '1';
    cargarPagos(card).catch(err => msg(err.message, true));
  }
}, true);

$('vista').addEventListener('submit', async e => {
  const form = e.target.closest('form[data-pago-manual]');
  if (!form) return;
  e.preventDefault();
  try {
    await api('POST', `/admin/compras/${form.dataset.pagoManual}/pagos`, {
      monto: form.monto.value, metodo: form.metodo.value, referencia: form.referencia.value,
    });
    msg('Pago registrado.');
    mostrar('compras');
  } catch (err) {
    msg(err.message, true);
  }
});

// ---------- Tablas ----------
async function renderTablas() {
  const r = await api('GET', '/admin/resumen');
  $('vista').innerHTML = `
    <div class="stats">
      <div class="card stat"><span class="muted">Total</span><strong>${r.tablas.total}</strong></div>
      <div class="card stat"><span class="muted">Disponibles</span><strong>${r.tablas.disponibles}</strong></div>
      <div class="card stat"><span class="muted">Vendidas</span><strong>${r.tablas.vendidas}</strong></div>
    </div>
    <h2>Importar tablas existentes</h2>
    <form id="form-importar" class="card">
      <label>Seriales (uno por línea o separados por coma)
        <textarea name="seriales" rows="6" placeholder="BNG-7K2P-X9WQ&#10;BNG-..."></textarea>
      </label>
      <div class="actions"><button type="submit">Importar</button></div>
    </form>
    <h2>Generar tablas nuevas</h2>
    <form id="form-generar" class="card row">
      <label style="flex:1 1 160px">Cantidad (1 a 500) <input name="cantidad" type="number" min="1" max="500" value="100"></label>
      <button type="submit">Generar</button>
    </form>
    <h2>Listado</h2>
    <div class="card"><div class="chips" id="chips">${(await api('GET', '/admin/tablas')).map(t => `<span class="chip ${t.estado === 'vendida' ? 'vendida' : ''}" title="${esc(t.compraCodigo || '')}">${esc(t.serial)}</span>`).join('')}</div></div>
    `;

  $('form-importar').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await api('POST', '/admin/tablas/importar', { seriales: e.target.seriales.value });
      msg(`Leídas ${r.leidas} · Nuevas ${r.insertadas} · Repetidas ${r.repetidas}`);
      mostrar('tablas');
    } catch (err) { msg(err.message, true); }
  });
  $('form-generar').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await api('POST', '/admin/tablas/generar', { cantidad: Number(e.target.cantidad.value) });
      msg(`Generadas ${r.creadas} tabla(s).`);
      mostrar('tablas');
    } catch (err) { msg(err.message, true); }
  });
}

// ---------- Premios ----------
async function renderPremios() {
  const premios = await api('GET', '/admin/premios');
  $('vista').innerHTML = `
    <h2>Nueva ronda</h2>
    <form id="form-premio" class="card">
      <div class="grid">
        <label>Ronda <input name="ronda" required maxlength="80" placeholder="Línea, Cartón lleno…"></label>
        <label>Premio <input name="premio" required maxlength="120"></label>
        <label>Monto <input name="monto" type="number" min="0" step="0.01" value="0"></label>
      </div>
      <div class="actions"><button type="submit">Crear ronda</button></div>
    </form>
    <h2>Rondas</h2>
    ${premios.map(p => `
      <article class="card">
        <div class="row"><strong>${esc(p.ronda)}</strong>
          <span class="pill ${p.pagado ? 'verificado' : p.serial ? 'por_verificar' : ''}">${p.pagado ? 'pagado' : p.serial ? 'pendiente de pago' : 'sin ganador'}</span></div>
        <p class="muted">${esc(p.premio)} · ${dinero(p.monto)}</p>
        ${p.serial ? `
          <p class="mono">${esc(p.serial)}</p>
          <p>${esc(p.ganador?.nombre ?? '')} · Cédula ${esc(p.ganador?.cedula ?? '')} · ${esc(p.ganador?.telefono ?? '')} ${p.ganador ? `(${esc(p.ganador.codigo)})` : ''}</p>
          <div class="actions">
            ${p.pagado ? '' : `<button type="button" data-premio-pagar="${p.id}">Marcar pagado</button>
            <button type="button" class="ghost" data-premio-quitar="${p.id}">Quitar ganador</button>`}
          </div>` : `
          <form class="row" data-premio-ganador="${p.id}" style="margin-top:8px">
            <label style="flex:1 1 200px">Serial ganador <input name="serial" required placeholder="BNG-XXXX-XXXX"></label>
            <button type="submit">Registrar ganador</button>
          </form>`}
      </article>`).join('') || '<p class="muted">Aún no hay rondas.</p>'}`;

  $('form-premio').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('POST', '/admin/premios', { ronda: e.target.ronda.value, premio: e.target.premio.value, monto: Number(e.target.monto.value) });
      msg('Ronda creada.');
      mostrar('premios');
    } catch (err) { msg(err.message, true); }
  });
  $('vista').querySelectorAll('form[data-premio-ganador]').forEach(f => f.addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('PUT', `/admin/premios/${f.dataset.premioGanador}/ganador`, { serial: f.serial.value });
      msg('Ganador registrado.');
      mostrar('premios');
    } catch (err) { msg(err.message, true); }
  }));
  $('vista').querySelectorAll('[data-premio-pagar]').forEach(b => b.addEventListener('click', () =>
    accion(async () => { await api('POST', `/admin/premios/${b.dataset.premioPagar}/pagar`); mostrar('premios'); }, 'Premio marcado como pagado.')));
  $('vista').querySelectorAll('[data-premio-quitar]').forEach(b => b.addEventListener('click', () =>
    accion(async () => { await api('DELETE', `/admin/premios/${b.dataset.premioQuitar}/ganador`); mostrar('premios'); }, 'Ganador quitado.')));
}

// ---------- Gastos ----------
async function renderGastos() {
  const gastos = await api('GET', '/admin/gastos');
  const total = gastos.reduce((s, g) => s + g.monto, 0);
  $('vista').innerHTML = `
    <h2>Registrar gasto</h2>
    <form id="form-gasto" class="card">
      <div class="grid">
        <label>Concepto <input name="concepto" required maxlength="120"></label>
        <label>Monto <input name="monto" type="number" min="0.01" step="0.01" required></label>
        <label>Categoría
          <select name="categoria"><option>Logística</option><option>Impresión</option><option>Publicidad</option><option>Premios</option><option>Otros</option></select>
        </label>
        <label>Fecha <input name="fecha" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      </div>
      <div class="actions"><button type="submit">Registrar</button></div>
    </form>
    <h2>Gastos (${dinero(total)})</h2>
    <div class="card">
      ${gastos.map(g => `<div class="kv"><span>${esc(g.fecha)} · ${esc(g.concepto)} <span class="muted">(${esc(g.categoria)})</span></span>
        <span><strong>${dinero(g.monto)}</strong> <button type="button" class="danger" data-gasto-borrar="${g.id}">Borrar</button></span></div>`).join('') || '<p class="muted">Sin gastos.</p>'}
    </div>`;

  $('form-gasto').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('POST', '/admin/gastos', { concepto: f.concepto.value, monto: Number(f.monto.value), categoria: f.categoria.value, fecha: f.fecha.value });
      msg('Gasto registrado.');
      mostrar('gastos');
    } catch (err) { msg(err.message, true); }
  });
  $('vista').querySelectorAll('[data-gasto-borrar]').forEach(b => b.addEventListener('click', () => {
    if (!confirm('¿Borrar este gasto?')) return;
    accion(async () => { await api('DELETE', `/admin/gastos/${b.dataset.gastoBorrar}`); mostrar('gastos'); }, 'Gasto borrado.');
  }));
}

// ---------- Configuración ----------
async function renderConfig() {
  const e = (await api('GET', '/admin/resumen')).evento;
  $('vista').innerHTML = `
    <form id="form-config" class="card">
      <div class="grid">
        <label>Nombre del evento <input name="nombre" value="${esc(e.nombre)}" maxlength="120"></label>
        <label>Precio por tabla <input name="precioTabla" type="number" min="0" step="0.01" value="${e.precioTabla}" required></label>
        <label>Moneda (texto) <input name="moneda" value="${esc(e.moneda)}" maxlength="10" placeholder="Bs, USD, $"></label>
        <label>Fecha del sorteo <input name="fechaSorteo" type="date" value="${esc(e.fechaSorteo)}"></label>
        <label class="full">Datos de pago (se muestran al comprador)
          <textarea name="cuentasPago" rows="5">${esc(e.cuentasPago)}</textarea>
        </label>
        <label class="full" style="flex-direction:row;align-items:center;gap:8px">
          <input type="checkbox" name="exigirPagoCompleto" style="width:auto" ${e.exigirPagoCompleto ? 'checked' : ''}>
          Enviar tablas solo cuando la compra esté pagada completa
        </label>
      </div>
      <div class="actions"><button type="submit">Guardar</button></div>
    </form>
    <p class="muted">Con el precio en 0 las compras quedan cerradas.</p>`;

  $('form-config').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api('PUT', '/admin/evento', {
        nombre: f.nombre.value,
        precioTabla: Number(f.precioTabla.value),
        moneda: f.moneda.value,
        fechaSorteo: f.fechaSorteo.value,
        cuentasPago: f.cuentasPago.value,
        exigirPagoCompleto: f.exigirPagoCompleto.checked,
      });
      msg('Configuración guardada.');
      await entrar();
    } catch (err) { msg(err.message, true); }
  });
}

// ---------- Reportes ----------
function renderReportes() {
  const reportes = [
    ['compras', 'Compras con pagado, saldo y seriales'],
    ['pagos', 'Todos los pagos reportados y verificados'],
    ['deudas', 'Quién debe cuánto'],
    ['tablas', 'Cada tabla: disponible o vendida, y a quién'],
    ['premios', 'Rondas, ganadores y pagos'],
    ['gastos', 'Gastos del evento'],
  ];
  $('vista').innerHTML = `<div class="card">${reportes.map(([k, t]) =>
    `<div class="kv"><span>${esc(t)}</span><a class="btn ghost" href="/api/admin/reportes/${k}.csv">Descargar CSV</a></div>`).join('')}</div>
    <p class="muted">Los CSV se abren en Excel. Cada descarga es un corte en el momento que la pides.</p>`;
}

// ---------- Bitácora ----------
async function renderBitacora() {
  const filas = await api('GET', '/admin/bitacora');
  $('vista').innerHTML = `<div class="card">${filas.map(b =>
    `<div class="kv"><span>${esc(fecha(b.fecha))} · ${esc(b.accion)}</span><span class="muted">${esc(b.detalle)}</span></div>`).join('') || '<p class="muted">Sin movimientos.</p>'}</div>`;
}

// Arranque: si la sesión sigue viva, entra directo.
(async () => {
  try {
    await api('GET', '/admin/resumen');
    await entrar();
  } catch {
    mostrarLogin();
  }
})();
