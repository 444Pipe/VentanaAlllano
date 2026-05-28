/**
 * Ecocabañas Ventana al Llano — servidor web + API de reservas.
 */
try { require('dotenv').config(); } catch (_) { /* dotenv opcional */ }

const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const repo = require('./repo');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'ventana-al-llano-dev-secret-cambia-esto';

if (process.env.NODE_ENV === 'production') {
  if (ADMIN_PASSWORD === 'admin123') console.warn('[seguridad] Define ADMIN_PASSWORD en las variables de entorno.');
  if (JWT_SECRET.includes('dev-secret')) console.warn('[seguridad] Define JWT_SECRET en las variables de entorno.');
}

app.use(express.json());

// ---------- No exponer código fuente / configuración ----------
app.use((req, res, next) => {
  if (/\.(js|json|md|lock)$/i.test(req.path) || req.path.toLowerCase().startsWith('/.env')) {
    return res.status(404).send('No encontrado');
  }
  next();
});

// ---------- Archivos estáticos (index.html, reservar.html, admin.html, statics/) ----------
app.use(express.static(__dirname, { extensions: ['html'] }));

// ============================================================
//  Utilidades
// ============================================================
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });

// ============================================================
//  API PÚBLICA
// ============================================================

// Health check (para Railway)
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Lista de cabañas activas
app.get('/api/cabanas', wrap(async (req, res) => {
  const cabanas = await repo.listCabanas(true);
  res.json(cabanas);
}));

// Disponibilidad para un rango de fechas
app.get('/api/disponibilidad', wrap(async (req, res) => {
  const { entrada, salida } = req.query;
  const personas = parseInt(req.query.personas, 10) || 1;
  if (!isISODate(entrada) || !isISODate(salida)) {
    return res.status(400).json({ error: 'Fechas inválidas' });
  }
  if (entrada < repo.todayISO()) return res.status(400).json({ error: 'La fecha de entrada no puede ser pasada' });
  if (salida <= entrada) return res.status(400).json({ error: 'La salida debe ser posterior a la entrada' });

  const noches = repo.nightsBetween(entrada, salida);
  const disponibles = await repo.availableCabanas(entrada, salida, personas);
  res.json({
    entrada, salida, personas, noches,
    cabanas: disponibles.map((c) => ({
      id: c.id, slug: c.slug, nombre: c.nombre, descripcion: c.descripcion,
      capacidad: c.capacidad, precio_noche: c.precio_noche, imagen: c.imagen,
      total: c.precio_noche * noches,
    })),
  });
}));

// Crear una solicitud de reserva
app.post('/api/reservas', wrap(async (req, res) => {
  const b = req.body || {};
  const nombre = (b.nombre || '').trim();
  const telefono = (b.telefono || '').trim();
  const email = (b.email || '').trim() || null;
  const notas = (b.notas || '').trim() || null;
  const personas = parseInt(b.personas, 10) || 1;
  const { entrada, salida } = b;

  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  if (!telefono) return res.status(400).json({ error: 'El teléfono es obligatorio' });
  if (!isISODate(entrada) || !isISODate(salida)) return res.status(400).json({ error: 'Fechas inválidas' });
  if (entrada < repo.todayISO()) return res.status(400).json({ error: 'La fecha de entrada no puede ser pasada' });
  if (salida <= entrada) return res.status(400).json({ error: 'La salida debe ser posterior a la entrada' });

  const cabana = await repo.getCabana(b.cabana_id);
  if (!cabana || !cabana.activa) return res.status(400).json({ error: 'Cabaña no disponible' });
  if (personas > cabana.capacidad) return res.status(400).json({ error: `Esta cabaña admite hasta ${cabana.capacidad} personas` });

  const libre = await repo.isAvailable(cabana.id, entrada, salida);
  if (!libre) return res.status(409).json({ error: 'Lo sentimos, esas fechas ya no están disponibles para esta cabaña' });

  const noches = repo.nightsBetween(entrada, salida);
  const total = cabana.precio_noche * noches;
  const reserva = await repo.createReserva({
    codigo: repo.genCodigo(), cabana_id: cabana.id, nombre, email, telefono,
    entrada, salida, personas, noches, total, notas,
  });

  res.status(201).json({
    ok: true,
    codigo: reserva.codigo,
    reserva: { ...reserva, cabana_nombre: cabana.nombre },
  });
}));

// ============================================================
//  API ADMIN
// ============================================================
app.post('/api/admin/login', wrap(async (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
}));

app.get('/api/admin/stats', authRequired, wrap(async (req, res) => {
  res.json(await repo.stats());
}));

app.get('/api/admin/reservas', authRequired, wrap(async (req, res) => {
  const { estado, desde, hasta, q } = req.query;
  const filters = {};
  if (estado && repo.ESTADOS.includes(estado)) filters.estado = estado;
  if (isISODate(desde)) filters.desde = desde;
  if (isISODate(hasta)) filters.hasta = hasta;
  if (q) filters.q = String(q).trim();
  res.json(await repo.listReservas(filters));
}));

app.patch('/api/admin/reservas/:id', authRequired, wrap(async (req, res) => {
  const { estado } = req.body || {};
  if (!repo.ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const r = await repo.updateReservaEstado(req.params.id, estado);
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
  res.json(r);
}));

app.delete('/api/admin/reservas/:id', authRequired, wrap(async (req, res) => {
  await repo.deleteReserva(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/admin/cabanas', authRequired, wrap(async (req, res) => {
  res.json(await repo.listCabanas(false));
}));

app.patch('/api/admin/cabanas/:id', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const fields = {};
  if (b.nombre !== undefined) fields.nombre = String(b.nombre).trim();
  if (b.descripcion !== undefined) fields.descripcion = String(b.descripcion).trim();
  if (b.capacidad !== undefined) fields.capacidad = parseInt(b.capacidad, 10);
  if (b.precio_noche !== undefined) fields.precio_noche = parseInt(b.precio_noche, 10);
  if (b.activa !== undefined) fields.activa = !!b.activa;
  const c = await repo.updateCabana(req.params.id, fields);
  if (!c) return res.status(404).json({ error: 'Cabaña no encontrada' });
  res.json(c);
}));

app.get('/api/admin/bloqueos', authRequired, wrap(async (req, res) => {
  res.json(await repo.listBloqueos());
}));

app.post('/api/admin/bloqueos', authRequired, wrap(async (req, res) => {
  const b = req.body || {};
  const cabana_id = b.cabana_id ? parseInt(b.cabana_id, 10) : null;
  if (!isISODate(b.desde) || !isISODate(b.hasta)) return res.status(400).json({ error: 'Fechas inválidas' });
  if (b.hasta <= b.desde) return res.status(400).json({ error: 'La fecha final debe ser posterior a la inicial' });
  const row = await repo.createBloqueo({ cabana_id, desde: b.desde, hasta: b.hasta, motivo: (b.motivo || '').trim() || null });
  res.status(201).json(row);
}));

app.delete('/api/admin/bloqueos/:id', authRequired, wrap(async (req, res) => {
  await repo.deleteBloqueo(req.params.id);
  res.json({ ok: true });
}));

// ============================================================
//  Arranque
// ============================================================
repo.init()
  .then(() => {
    app.listen(PORT, () => console.log(`Ventana al Llano escuchando en http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('No se pudo inicializar la base de datos:', err);
    process.exit(1);
  });
