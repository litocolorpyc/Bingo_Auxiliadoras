const { Pool, types } = require('pg');

// int8 (COUNT) y numeric (dinero) llegan como número, no como texto.
types.setTypeParser(20, v => Number(v));
types.setTypeParser(1700, v => Number(v));

// Interfaz común: query(sql, params), exec(sql), tx(fn), cerrar().
// fn dentro de tx recibe un ejecutor que usa la misma transacción.

function desdePool(connectionString) {
  // Neon y otros Postgres administrados exigen SSL.
  const pool = new Pool({ connectionString, max: 5, ssl: { rejectUnauthorized: false } });
  return {
    query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    exec: async sql => { await pool.query(sql); },
    tx: async fn => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn((sql, params = []) => c.query(sql, params).then(x => x.rows));
        await c.query('COMMIT');
        return r;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
    cerrar: () => pool.end(),
  };
}

// Mismo contrato sobre PGlite (Postgres en memoria), usado en las pruebas.
function desdePglite(pg) {
  return {
    query: async (sql, params = []) => (await pg.query(sql, params)).rows,
    exec: async sql => { await pg.exec(sql); },
    tx: fn => pg.transaction(tx => fn((sql, params = []) => tx.query(sql, params).then(x => x.rows))),
    cerrar: () => pg.close(),
  };
}

module.exports = { desdePool, desdePglite };
