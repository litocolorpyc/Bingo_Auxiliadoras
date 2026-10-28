// Importa tus tablas existentes desde un archivo de texto (un serial por línea o separados por coma).
// Uso: node scripts/importar-tablas.js ruta/al/archivo.txt
const fs = require('node:fs');
const path = require('node:path');
const { abrirBase } = require('../src/db');
const { crearServicios } = require('../src/servicios');
const { crearWhatsApp } = require('../src/whatsapp');

const archivo = process.argv[2];
if (!archivo) {
  console.error('Uso: node scripts/importar-tablas.js ruta/al/archivo.txt');
  process.exit(1);
}

const DATA = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const db = abrirBase(path.join(DATA, 'bingo.db'));
const servicios = crearServicios({ db, whatsapp: crearWhatsApp({}) });
const r = servicios.importarTablas(fs.readFileSync(archivo, 'utf8'));
console.log(`Leídas: ${r.leidas} · Nuevas: ${r.insertadas} · Repetidas: ${r.repetidas}`);
console.log(`Total disponibles: ${servicios.tablasDisponibles()}`);
