# Bingo Auxiliadoras

Venta, verificación y control de tablas de bingo. Todo corre en **Vercel**: frontend estático, funciones serverless, base de datos Neon y comprobantes en Blob privado.

## Arquitectura

| Parte | Dónde corre | Archivo |
|---|---|---|
| Formulario de compra y panel | Vercel (estático) | `public/` |
| API pública (evento, compra, estado) | Vercel Function | `api/publico/[...ruta].js` |
| API de administración (con sesión) | Vercel Function | `api/admin/[...ruta].js` |
| Base de datos PostgreSQL | Neon (Marketplace de Vercel) | `src/esquema.sql` |
| Comprobantes | Vercel Blob (privado) | `src/storage.js` |

Los comprobantes se suben directo desde el navegador a Vercel Blob con un token emitido por el servidor, así no pasan por la función (que limita las peticiones a 4.5 MB).

## Flujo

1. **Compra:** la persona llena el formulario, sube el comprobante y recibe un código `BNG-XXXXXX`.
2. **Verificación:** el administrador confirma el monto recibido. Los abonos quedan registrados y el saldo queda como deuda.
3. **Enviar Tablas:** asigna tablas libres en una sola operación atómica (`FOR UPDATE SKIP LOCKED`) y envía el mensaje por WhatsApp.
4. **Control:** tablas, pagos, deudas, premios, gastos, reportes CSV y bitácora.

## 1. Base de datos y comprobantes (en Vercel)

1. En el proyecto de Vercel: **Storage → Create Database → Neon (Postgres)**. Acepta el plan gratuito y crea la base `bingo-auxiliadoras`. Vercel añade `DATABASE_URL` al proyecto.
2. **Storage → Create → Blob**. Crea la tienda en modo **Private** y conéctala al proyecto. Vercel añade `BLOB_READ_WRITE_TOKEN`.

## 2. Preparar el proyecto en tu computadora (PowerShell)

```powershell
git clone https://github.com/litocolorpyc/Bingo_Auxiliadoras.git
cd Bingo_Auxiliadoras
npm install
```

Crea las tablas en Neon (solo una vez):

```powershell
$env:DATABASE_URL = "postgresql://usuario:contraseña@ep-xxxx.sa-east-2.aws.neon.tech/neondb?sslmode=require"
npm run migrar
```

Carga tus 400 tablas desde un archivo de texto (un serial por línea):

```powershell
npm run importar-tablas -- .\tablas.txt
```

## 3. Vercel

Opción recomendada: desde la web.

1. En [vercel.com](https://vercel.com), inicia sesión con **litocolorpyc@gmail.com** y pulsa **Add New → Project**.
2. Importa el repositorio `Bingo_Auxiliadoras`. Vercel detecta la configuración de `vercel.json`.
3. En **Environment Variables**, agrega las del archivo `.env.example`:
   - `DATABASE_URL` y `BLOB_READ_WRITE_TOKEN` (ya las crea Neon y Blob)
   - `ADMIN_PASSWORD` (una clave larga)
   - `CODIGO_PAIS` (`58`) y, cuando tengas WhatsApp, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_PLANTILLA`
4. Pulsa **Deploy**. Cada `git push` a `main` redespliega la app.

Opción desde PowerShell:

```powershell
npm install -g vercel
vercel login
vercel link
vercel env pull .env
vercel env add ADMIN_PASSWORD production
vercel env add CODIGO_PAIS production
vercel --prod
```

Cada `vercel env add` pide el valor por teclado.

**Nota sobre el plan:** el plan gratuito de Vercel (Hobby) es para uso no comercial. Una venta de tablas se considera comercial, así que conviene el plan **Pro**.

## Pruebas

```powershell
npm test
```

Cubren las reglas críticas contra PostgreSQL: no vender la misma tabla dos veces, envíos simultáneos sin repetidos, saldos con pagos parciales, premios solo con tablas vendidas y reintento de WhatsApp.

## Notas de operación

- Los comprobantes son privados. El panel los abre a través de una función que comprueba la sesión.
- Si alguien sube un comprobante y no termina la compra, el archivo queda huérfano en Storage. Es inofensivo, y se puede borrar después.
- El login bloquea una IP tras 10 intentos fallidos en 15 minutos.
- Respalda la base desde el panel de Neon durante el evento.
