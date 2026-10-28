# Bingo Auxiliadoras

Venta, verificación y control de tablas de bingo. Frontend estático y funciones serverless en **Vercel**; base de datos y comprobantes en **Supabase**.

## Arquitectura

| Parte | Dónde corre | Archivo |
|---|---|---|
| Formulario de compra y panel | Vercel (estático) | `public/` |
| API pública (evento, compra, estado) | Vercel Function | `api/publico/[...ruta].js` |
| API de administración (con sesión) | Vercel Function | `api/admin/[...ruta].js` |
| Base de datos PostgreSQL | Supabase | `src/esquema.sql` |
| Comprobantes | Supabase Storage (privado) | bucket `comprobantes` |

Los comprobantes se suben directo desde el navegador a Supabase con una URL firmada, así no pasan por Vercel (que limita las peticiones a 4.5 MB).

## Flujo

1. **Compra:** la persona llena el formulario, sube el comprobante y recibe un código `BNG-XXXXXX`.
2. **Verificación:** el administrador confirma el monto recibido. Los abonos quedan registrados y el saldo queda como deuda.
3. **Enviar Tablas:** asigna tablas libres en una sola operación atómica (`FOR UPDATE SKIP LOCKED`) y envía el mensaje por WhatsApp.
4. **Control:** tablas, pagos, deudas, premios, gastos, reportes CSV y bitácora.

## 1. Supabase

1. Crea el proyecto `bingo-auxiliadoras` en región `South America (São Paulo)`. Guarda la contraseña de la base.
2. **Project Settings → Database → Connection string → Transaction pooler** (puerto 6543). Esa es tu `DATABASE_URL`.
3. **Project Settings → API:** copia la **Project URL** y la **service_role key**.
4. **Storage → New bucket:** nombre `comprobantes`, **Public desactivado**. En la configuración del bucket, limita el tamaño a **10 MB** y los tipos a `image/png, image/jpeg, image/gif, image/webp, application/pdf`.

## 2. Preparar el proyecto en tu computadora (PowerShell)

```powershell
git clone https://github.com/litocolorpyc/Bingo_Auxiliadoras.git
cd Bingo_Auxiliadoras
npm install
```

Crea las tablas en Supabase (solo una vez):

```powershell
$env:DATABASE_URL = "postgresql://postgres.xxxx:TU-CONTRASEÑA@aws-0-sa-east-1.pooler.supabase.com:6543/postgres"
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
   - `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_BUCKET` (`comprobantes`)
   - `ADMIN_PASSWORD` (una clave larga)
   - `CODIGO_PAIS` (`58`) y, cuando tengas WhatsApp, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_PLANTILLA`
4. Pulsa **Deploy**. Cada `git push` a `main` redespliega la app.

Opción desde PowerShell:

```powershell
npm install -g vercel
vercel login
vercel link
vercel env add DATABASE_URL production
vercel env add SUPABASE_URL production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add SUPABASE_BUCKET production
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

- Los comprobantes son privados. El panel genera un enlace temporal (5 minutos) cada vez que lo abres.
- Si alguien sube un comprobante y no termina la compra, el archivo queda huérfano en Storage. Es inofensivo, y se puede borrar después.
- El login bloquea una IP tras 10 intentos fallidos en 15 minutos.
- Respalda la base desde Supabase (**Database → Backups**) durante el evento.
