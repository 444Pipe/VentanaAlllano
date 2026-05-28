# Ecocabañas Ventana al Llano — Sitio + Sistema de Reservas

Sitio web del eco-hotel con un sistema completo de reservas de hospedaje y panel de administración.

## ¿Qué incluye?

- **Sitio público** (`index.html`): landing del hotel.
- **Reservas** (`reservar.html`): el cliente elige fechas → ve cabañas disponibles → envía su solicitud. Recibe un código y un botón de WhatsApp para confirmar.
- **Panel admin** (`admin.html`, ruta `/admin`): login con contraseña, métricas, gestión de reservas (confirmar / completar / cancelar / eliminar), calendario mensual, bloqueo de fechas y edición de precios/capacidad/disponibilidad de cabañas.
- **API + backend** (`server.js`, `repo.js`): Express + PostgreSQL.

El flujo de pago es **solicitud → confirmación por WhatsApp** (la reserva nace "pendiente" y el admin la confirma). No hay pasarela de pago en línea (se puede agregar después).

## Correr en local

```bash
npm install
npm start
```

Abre http://localhost:3000

- Sin `DATABASE_URL`, usa un almacén **en memoria** (se borra al reiniciar) — perfecto para probar.
- Para usar Postgres en local, copia `.env.example` a `.env` y completa `DATABASE_URL`.

Panel admin: http://localhost:3000/admin — usuario `admin` y contraseña `admin123` por defecto (cámbialos con `ADMIN_USERNAME` y `ADMIN_PASSWORD`).

## Desplegar en Railway

1. Sube este proyecto a un repositorio de GitHub.
2. En Railway: **New Project → Deploy from GitHub repo** y elige el repo.
3. **Add → Database → PostgreSQL**. Railway crea la variable `DATABASE_URL` y la enlaza al servicio.
4. En el servicio web, pestaña **Variables**, agrega:
   - `ADMIN_USERNAME` = tu usuario del panel (por defecto `admin`)
   - `ADMIN_PASSWORD` = tu contraseña del panel
   - `JWT_SECRET` = una cadena larga y aleatoria
   - `NODE_ENV` = `production`
5. Railway detecta Node por `package.json` y ejecuta `npm start`. Las tablas se crean solas en el primer arranque y se siembran las 3 cabañas.
6. Abre la URL pública. El panel está en `/admin`.

> Si la conexión a Postgres da error de SSL, agrega la variable `PGSSL=true` (o `PGSSL=false` para la red interna de Railway).

## Variables de entorno

| Variable        | Descripción                                              |
|-----------------|----------------------------------------------------------|
| `DATABASE_URL`  | Conexión a PostgreSQL (la pone Railway).                 |
| `ADMIN_USERNAME`| Usuario del panel `/admin` (por defecto `admin`).        |
| `ADMIN_PASSWORD`| Contraseña del panel `/admin`.                           |
| `JWT_SECRET`    | Secreto para firmar las sesiones del admin.              |
| `PORT`          | Puerto (Railway lo define automáticamente).              |
| `PGSSL`         | `true`/`false` para forzar/desactivar SSL (opcional).    |

## Notas

- WhatsApp configurado: `573113822023`. Si cambia, busca esa constante en `reservar.html` y los enlaces de `index.html`.
- Las cabañas iniciales y sus precios se definen en `repo.js` (`SEED_CABANAS`) y luego se editan desde el panel.
