const { ErrorApp } = require('./servicios');

// Vercel entrega el segmento de la URL en req.query.ruta (catch-all [...ruta].js).
function rutaDe(req) {
  const partes = req.query?.ruta ?? [];
  return '/' + (Array.isArray(partes) ? partes : [partes]).join('/');
}

async function enrutar(rutas, req, res) {
  const ruta = rutaDe(req);
  for (const r of rutas) {
    if (r.metodo !== req.method) continue;
    const m = ruta.match(r.patron);
    if (m) return r.handler(m.slice(1), req, res);
  }
  res.status(404).json({ error: 'No encontrado.' });
}

function responderError(res, err) {
  if (err instanceof ErrorApp) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Error interno. Revisa los logs de Vercel.' });
}

module.exports = { enrutar, responderError };
