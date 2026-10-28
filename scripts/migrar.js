// Crea las tablas en la base de datos (Neon). Se ejecuta una vez (y cada vez que cambie src/esquema.sql).
// Uso: npm run migrar   (requiere DATABASE_URL)
const fs = require('node:fs');
const path = require('node:path');
const { desdePool } = require('../src/db');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Define DATABASE_URL antes de migrar.');
  const db = desdePool(process.env.DATABASE_URL);
  try {
    await db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'esquema.sql'), 'utf8'));
    console.log('Esquema listo.');
  } finally {
    await db.cerrar();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
