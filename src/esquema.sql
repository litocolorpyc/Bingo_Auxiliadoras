CREATE TABLE IF NOT EXISTS evento (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  nombre TEXT NOT NULL DEFAULT 'Bingo',
  precio_tabla NUMERIC(12,2) NOT NULL DEFAULT 0,
  moneda TEXT NOT NULL DEFAULT '',
  fecha_sorteo TEXT NOT NULL DEFAULT '',
  cuentas_pago TEXT NOT NULL DEFAULT '',
  exigir_pago_completo BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO evento (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS compras (
  id SERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  cedula TEXT NOT NULL,
  telefono TEXT NOT NULL,
  correo TEXT NOT NULL,
  cantidad INTEGER NOT NULL CHECK (cantidad BETWEEN 1 AND 50),
  precio_unitario NUMERIC(12,2) NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('por_verificar','verificada','enviada','rechazada')),
  whatsapp_estado TEXT NOT NULL DEFAULT 'no_enviado'
    CHECK (whatsapp_estado IN ('no_enviado','enviado','fallido','manual')),
  whatsapp_error TEXT,
  creada_en TEXT NOT NULL,
  verificada_en TEXT,
  enviada_en TEXT
);

CREATE TABLE IF NOT EXISTS pagos (
  id SERIAL PRIMARY KEY,
  compra_id INTEGER NOT NULL REFERENCES compras(id),
  monto_reportado NUMERIC(12,2) NOT NULL,
  monto_verificado NUMERIC(12,2),
  metodo TEXT NOT NULL,
  referencia TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('por_verificar','verificado','rechazado')),
  creado_en TEXT NOT NULL,
  verificado_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_pagos_compra ON pagos(compra_id);

CREATE TABLE IF NOT EXISTS comprobantes (
  id SERIAL PRIMARY KEY,
  pago_id INTEGER NOT NULL REFERENCES pagos(id),
  ruta TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comprobantes_pago ON comprobantes(pago_id);

-- La clave primaria impide seriales repetidos. La venta toma tablas con FOR UPDATE SKIP LOCKED.
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
  id SERIAL PRIMARY KEY,
  ronda TEXT NOT NULL,
  premio TEXT NOT NULL,
  monto NUMERIC(12,2) NOT NULL DEFAULT 0,
  serial TEXT REFERENCES tablas(serial),
  pagado BOOLEAN NOT NULL DEFAULT false,
  pagado_en TEXT,
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gastos (
  id SERIAL PRIMARY KEY,
  fecha TEXT NOT NULL,
  concepto TEXT NOT NULL,
  categoria TEXT NOT NULL,
  monto NUMERIC(12,2) NOT NULL CHECK (monto > 0),
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bitacora (
  id SERIAL PRIMARY KEY,
  fecha TEXT NOT NULL,
  accion TEXT NOT NULL,
  detalle TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_intentos (
  ip TEXT NOT NULL,
  fecha TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_intentos(ip, fecha);
