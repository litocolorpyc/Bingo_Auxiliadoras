# Bingo Auxiliadoras

Aplicativo para vender, verificar y controlar tablas de bingo: desde que la persona llena el formulario y sube su comprobante, hasta el envío de tablas por WhatsApp y el control de pagos, deudas, premios y gastos.

## Flujo

1. **Compra.** La persona llena `/` con sus datos, el método y la referencia del pago, y sube el comprobante. Recibe un código de compra (`BNG-XXXXXX`).
2. **Verificación de pago.** En `/admin.html`, el administrador revisa el comprobante, confirma el monto recibido y lo verifica (o rechaza el pago). Los abonos parciales quedan registrados; el saldo queda como deuda.
3. **Enviar Tablas.** Con un pago verificado, el botón asigna tablas libres y las marca como vendidas en la misma transacción, así una tabla nunca se vende dos veces. Luego envía el mensaje por WhatsApp.
4. **Control.** Cada tabla queda ligada a su compra. Se ve quién tiene cuál, cuánto ha depositado, qué debe y qué se entregó.
5. **Premios, gastos y reportes.** Se registra la tabla ganadora (solo tablas vendidas), el pago del premio y los gastos. Los reportes salen en CSV para Excel.

Cada acción importante queda en la bitácora.

## Instalación

Requiere Node.js 22.13 o superior.

```bash
npm install
cp .env.example .env   # y completa ADMIN_PASSWORD
ADMIN_PASSWORD=tu-clave npm start
```

Abre `http://localhost:3000` (compra) y `http://localhost:3000/admin.html` (administración).

## Cargar tus 400 tablas

Pon los seriales en un archivo de texto (uno por línea o separados por coma) y ejecuta:

```bash
npm run importar-tablas -- ruta/al/archivo.txt
```

Los seriales repetidos se ignoran. También puedes pegarlos en el panel, en la sección **Tablas**.

## WhatsApp

- **Sin configurar:** al pulsar "Enviar Tablas" las tablas quedan asignadas y el panel ofrece "Abrir WhatsApp manual". Con ese enlace se abre el chat con el mensaje listo; luego se usa "Marcar como enviado".
- **Con WhatsApp Cloud API (Meta):** define `WHATSAPP_TOKEN` y `WHATSAPP_PHONE_ID`. Para escribir a compradores fuera de la ventana de 24 h, Meta exige una plantilla aprobada: crea una con dos variables (nombre y seriales) y ponla en `WHATSAPP_PLANTILLA`.
- Si el envío automático falla, la compra queda marcada como "fallido" con el error y se puede reintentar sin asignar otras tablas.

## Pruebas

```bash
npm test
```

Cubren las reglas críticas: no vender la misma tabla dos veces, no vender más de lo disponible, saldos con pagos parciales, premios solo con tablas vendidas y reintento de WhatsApp.

## Notas de seguridad y operación

- El panel usa una sola contraseña (`ADMIN_PASSWORD`). Usa una clave larga y bloquea el acceso público al servidor en producción (HTTPS).
- Tras 10 intentos fallidos desde una misma IP, el login se bloquea 15 minutos.
- Los datos viven en `data/bingo.db` (SQLite) y los comprobantes en `data/comprobantes/`. Haz respaldo de `data/` durante el evento.
- Los comprobantes solo se ven desde el panel de administración.
