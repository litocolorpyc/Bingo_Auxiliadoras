// Importa tus tablas existentes desde un archivo de texto (un serial por línea o separados por coma).
// Uso: npm run importar-tablas -- ruta/al/archivo.txt   (requiere DATABASE_URL)
const fs = require('node:fs');
const { desdePool } = require('../src/db');
const { crearServicios } = require('../src/servicios');
const { crearWhatsApp } = require('../src/whatsapp');

async function main() {
  const archivo = process.argv[2];
  if (!archivo) throw new Error('Uso: npm run importar-tablas -- ruta/al/archivo.txt');
  if (!process.env.DATABASE_URL) throw new Error('Define DATABASE_URL antes de importar.');
  const db = desdePool(process.env.DATABASE_URL);
  try {
    const servicios = crearServicios({ db, whatsapp: crearWhatsApp({}) });
    const r = await servicios.importarTablas(fs.readFileSync(archivo, 'utf8'));
    console.log(`Leídas: ${r.leidas} · Nuevas: ${r.insertadas} · Repetidas: ${r.repetidas}`);
    console.log(`Total disponibles: ${await servicios.tablasDisponibles()}`);
  } finally {
    await db.cerrar();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
