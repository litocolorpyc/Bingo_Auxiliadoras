const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS evento (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nombre TEXT NOT NULL DEFAULT 'Bingo',
  precio_tabla REAL NOT NULL DEFAULT 0,
  moneda TEXT NOT NULL DEFAULT '',
  fecha_sorteo TEXT NOT NULL DEFAULT '',
  cuentas_pago TEXT NOT NULL DEFAULT '',
  exigir_pago_completo INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO evento (id) VALUES (1);

CREATE TABLE IF NOT EXISTS compras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  cedula TEXT NOT NULL,
  telefono TEXT NOT NULL,
  correo TEXT NOT NULL,
  cantidad INTEGER NOT NULL CHECK (cantidad BETWEEN 1 AND 50),
  precio_unitario REAL NOT NULL,
  total REAL NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('por_verificar','verificada','enviada','rechazada')),
  whatsapp_estado TEXT NOT NULL DEFAULT 'no_enviado'
    CHECK (whatsapp_estado IN ('no_enviado','enviado','fallido','manual')),
  whatsapp_error TEXT,
  creada_en TEXT NOT NULL,
  verificada_en TEXT,
  enviada_en TEXT
);

CREATE TABLE IF NOT EXISTS pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compra_id INTEGER NOT NULL REFERENCES compras(id),
  monto_reportado REAL NOT NULL,
  monto_verificado REAL,
  metodo TEXT NOT NULL,
  referencia TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('por_verificar','verificado','rechazado')),
  comprobante_archivo TEXT,
  comprobante_nombre TEXT,
  comprobante_tipo TEXT,
  creado_en TEXT NOT NULL,
  verificado_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_pagos_compra ON pagos(compra_id);

-- La clave primaria impide que un serial exista dos veces.
-- La venta solo cambia tablas que siguen en 'disponible', dentro de una transacción.
CREATE TABLE IF NOT EXISTS tablas (
  serial TEXT PRIMARY KEY,
  estado TEXT NOT NULL DEFAULT 'disponible' CHECK (estado IN ('disponible','vendida')),
  compra_id INTEGER REFERENCES compras(id),
  vendida_en TEXT,
  creada_en TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tablas_estado ON tablas(estado);
CREATE INDEX IF NOT EXISTS idx_tablas_compra ON tablas(compra_id);

CREATE TABLE IF NOT EXISTS premios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ronda TEXT NOT NULL,
  premio TEXT NOT NULL,
  monto REAL NOT NULL DEFAULT 0,
  serial TEXT REFERENCES tablas(serial),
  pagado INTEGER NOT NULL DEFAULT 0,
  pagado_en TEXT,
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gastos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  concepto TEXT NOT NULL,
  categoria TEXT NOT NULL,
  monto REAL NOT NULL CHECK (monto > 0),
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bitacora (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  accion TEXT NOT NULL,
  detalle TEXT NOT NULL
);
`;

function abrirBase(archivo) {
  if (archivo !== ':memory:') fs.mkdirSync(path.dirname(archivo), { recursive: true });
  const db = new DatabaseSync(archivo);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(ESQUEMA);
  return db;
}

module.exports = { abrirBase };
