/**
 * Capa de datos del sistema de reservas.
 * Usa PostgreSQL cuando existe DATABASE_URL (producción / Railway).
 * Si no, cae a un almacén EN MEMORIA para poder probar en local sin base de datos.
 */
const crypto = require('crypto');

// ---------- Cabañas iniciales (se siembran si la tabla está vacía) ----------
const SEED_CABANAS = [
  {
    slug: 'el-chiguiro',
    nombre: 'Cabaña El Chigüiro',
    descripcion: 'Espaciosa y acogedora, ideal para familias o grupos. Acabados en madera y vista al jardín.',
    capacidad: 6,
    precio_noche: 300000,
    imagen: 'statics/cabana-chiguiro/SaveClip.App_649228377_18009669110835757_978800948885697982_n.jpg',
  },
  {
    slug: 'el-mico',
    nombre: 'Cabaña El Mico · Glamping',
    descripcion: 'Nuestro glamping insignia. Experiencia íntima para parejas, rodeada de naturaleza.',
    capacidad: 2,
    precio_noche: 320000,
    imagen: 'statics/cabana-mico-glamping/SaveClip.App_642556274_18096203750292440_2958544728974809294_n.jpg',
  },
  {
    slug: 'el-perezoso',
    nombre: 'Cabaña El Perezoso',
    descripcion: 'Tranquilidad pura: hamacas, vista al bosque y silencio. Para descansar sin afanes.',
    capacidad: 4,
    precio_noche: 300000,
    imagen: 'statics/cabana-perezoso/SaveClip.App_650621249_18082119707588204_1388314393573503417_n.jpg',
  },
];

// ---------- Helpers ----------
const ESTADOS = ['pendiente', 'confirmada', 'cancelada', 'completada'];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function nightsBetween(entrada, salida) {
  return Math.round((new Date(salida) - new Date(entrada)) / 86400000);
}
function genCodigo() {
  return 'VLL-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}
function overlap(aIn, aOut, bIn, bOut) {
  return aIn < bOut && bIn < aOut; // rangos [entrada, salida)
}

/* ============================================================
 *  BACKEND POSTGRES
 * ============================================================ */
function makePgBackend() {
  const { Pool } = require('pg');

  function sslConfig() {
    const url = process.env.DATABASE_URL || '';
    if (process.env.PGSSL === 'true') return { rejectUnauthorized: false };
    if (process.env.PGSSL === 'false') return false;
    if (url.includes('railway.internal') || url.includes('localhost') || url.includes('127.0.0.1')) return false;
    return { rejectUnauthorized: false };
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: sslConfig() });
  const q = (text, params) => pool.query(text, params);

  return {
    async init() {
      await q(`
        CREATE TABLE IF NOT EXISTS cabanas (
          id SERIAL PRIMARY KEY,
          slug TEXT UNIQUE NOT NULL,
          nombre TEXT NOT NULL,
          descripcion TEXT,
          capacidad INT NOT NULL DEFAULT 2,
          precio_noche INT NOT NULL DEFAULT 0,
          imagen TEXT,
          activa BOOLEAN NOT NULL DEFAULT TRUE
        );`);
      await q(`
        CREATE TABLE IF NOT EXISTS reservas (
          id SERIAL PRIMARY KEY,
          codigo TEXT UNIQUE NOT NULL,
          cabana_id INT REFERENCES cabanas(id),
          nombre TEXT NOT NULL,
          email TEXT,
          telefono TEXT NOT NULL,
          entrada DATE NOT NULL,
          salida DATE NOT NULL,
          personas INT NOT NULL DEFAULT 1,
          noches INT NOT NULL,
          total INT NOT NULL,
          notas TEXT,
          estado TEXT NOT NULL DEFAULT 'pendiente',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`);
      await q(`
        CREATE TABLE IF NOT EXISTS bloqueos (
          id SERIAL PRIMARY KEY,
          cabana_id INT REFERENCES cabanas(id),
          desde DATE NOT NULL,
          hasta DATE NOT NULL,
          motivo TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );`);

      const { rows } = await q('SELECT COUNT(*)::int AS n FROM cabanas');
      if (rows[0].n === 0) {
        for (const c of SEED_CABANAS) {
          await q(
            `INSERT INTO cabanas (slug, nombre, descripcion, capacidad, precio_noche, imagen)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [c.slug, c.nombre, c.descripcion, c.capacidad, c.precio_noche, c.imagen]
          );
        }
      }
    },

    async listCabanas(activeOnly = true) {
      const { rows } = await q(
        `SELECT * FROM cabanas ${activeOnly ? 'WHERE activa = TRUE' : ''} ORDER BY id`
      );
      return rows;
    },

    async getCabana(id) {
      const { rows } = await q('SELECT * FROM cabanas WHERE id=$1', [id]);
      return rows[0] || null;
    },

    async getCabanaBySlug(slug) {
      const { rows } = await q('SELECT * FROM cabanas WHERE slug=$1', [slug]);
      return rows[0] || null;
    },

    async updateCabana(id, f) {
      const { rows } = await q(
        `UPDATE cabanas SET
           nombre = COALESCE($2, nombre),
           descripcion = COALESCE($3, descripcion),
           capacidad = COALESCE($4, capacidad),
           precio_noche = COALESCE($5, precio_noche),
           activa = COALESCE($6, activa)
         WHERE id=$1 RETURNING *`,
        [id, f.nombre ?? null, f.descripcion ?? null, f.capacidad ?? null, f.precio_noche ?? null,
         f.activa ?? null]
      );
      return rows[0] || null;
    },

    async isAvailable(cabanaId, entrada, salida, excludeReservaId = null) {
      const r = await q(
        `SELECT 1 FROM reservas
          WHERE cabana_id=$1 AND estado IN ('pendiente','confirmada')
            AND entrada < $3 AND salida > $2
            AND ($4::int IS NULL OR id <> $4)
          LIMIT 1`,
        [cabanaId, entrada, salida, excludeReservaId]
      );
      if (r.rowCount > 0) return false;
      const b = await q(
        `SELECT 1 FROM bloqueos
          WHERE (cabana_id=$1 OR cabana_id IS NULL)
            AND desde < $3 AND hasta > $2
          LIMIT 1`,
        [cabanaId, entrada, salida]
      );
      return b.rowCount === 0;
    },

    async availableCabanas(entrada, salida, personas) {
      const cabanas = await this.listCabanas(true);
      const out = [];
      for (const c of cabanas) {
        if (c.capacidad < personas) continue;
        if (await this.isAvailable(c.id, entrada, salida)) out.push(c);
      }
      return out;
    },

    async createReserva(d) {
      const { rows } = await q(
        `INSERT INTO reservas (codigo, cabana_id, nombre, email, telefono, entrada, salida, personas, noches, total, notas, estado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pendiente') RETURNING *`,
        [d.codigo, d.cabana_id, d.nombre, d.email, d.telefono, d.entrada, d.salida,
         d.personas, d.noches, d.total, d.notas]
      );
      return rows[0];
    },

    async listReservas(filters = {}) {
      const where = [];
      const params = [];
      if (filters.estado) { params.push(filters.estado); where.push(`r.estado = $${params.length}`); }
      if (filters.desde) { params.push(filters.desde); where.push(`r.salida >= $${params.length}`); }
      if (filters.hasta) { params.push(filters.hasta); where.push(`r.entrada <= $${params.length}`); }
      if (filters.q) {
        params.push('%' + filters.q.toLowerCase() + '%');
        where.push(`(LOWER(r.nombre) LIKE $${params.length} OR LOWER(r.codigo) LIKE $${params.length}
                     OR r.telefono LIKE $${params.length} OR LOWER(COALESCE(r.email,'')) LIKE $${params.length})`);
      }
      const { rows } = await q(
        `SELECT r.*, c.nombre AS cabana_nombre, c.slug AS cabana_slug
           FROM reservas r LEFT JOIN cabanas c ON c.id = r.cabana_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY r.entrada DESC, r.id DESC`,
        params
      );
      return rows;
    },

    async updateReservaEstado(id, estado) {
      const { rows } = await q('UPDATE reservas SET estado=$2 WHERE id=$1 RETURNING *', [id, estado]);
      return rows[0] || null;
    },

    async deleteReserva(id) {
      await q('DELETE FROM reservas WHERE id=$1', [id]);
    },

    async listBloqueos() {
      const { rows } = await q(
        `SELECT b.*, c.nombre AS cabana_nombre FROM bloqueos b
           LEFT JOIN cabanas c ON c.id=b.cabana_id ORDER BY b.desde DESC`
      );
      return rows;
    },

    async createBloqueo(d) {
      const { rows } = await q(
        `INSERT INTO bloqueos (cabana_id, desde, hasta, motivo) VALUES ($1,$2,$3,$4) RETURNING *`,
        [d.cabana_id, d.desde, d.hasta, d.motivo]
      );
      return rows[0];
    },

    async deleteBloqueo(id) {
      await q('DELETE FROM bloqueos WHERE id=$1', [id]);
    },

    async stats() {
      const today = todayISO();
      const r = await q(`
        SELECT
          COUNT(*) FILTER (WHERE estado='pendiente')::int AS pendientes,
          COUNT(*) FILTER (WHERE estado='confirmada')::int AS confirmadas,
          COUNT(*) FILTER (WHERE estado='confirmada' AND entrada >= $1)::int AS proximas,
          COALESCE(SUM(total) FILTER (WHERE estado IN ('confirmada','completada')),0)::bigint AS ingresos
        FROM reservas`, [today]);
      return r.rows[0];
    },
  };
}

/* ============================================================
 *  BACKEND EN MEMORIA (solo pruebas locales)
 * ============================================================ */
function makeMemoryBackend() {
  const db = { cabanas: [], reservas: [], bloqueos: [] };
  let ids = { cabanas: 0, reservas: 0, bloqueos: 0 };
  const nextId = (t) => (++ids[t]);

  return {
    async init() {
      for (const c of SEED_CABANAS) {
        db.cabanas.push({ id: nextId('cabanas'), activa: true, ...c });
      }
    },
    async listCabanas(activeOnly = true) {
      return db.cabanas.filter((c) => (activeOnly ? c.activa : true)).map((c) => ({ ...c }));
    },
    async getCabana(id) {
      return db.cabanas.find((c) => c.id === Number(id)) || null;
    },
    async getCabanaBySlug(slug) {
      return db.cabanas.find((c) => c.slug === slug) || null;
    },
    async updateCabana(id, f) {
      const c = db.cabanas.find((x) => x.id === Number(id));
      if (!c) return null;
      ['nombre', 'descripcion', 'capacidad', 'precio_noche', 'activa'].forEach((k) => {
        if (f[k] !== undefined && f[k] !== null) c[k] = f[k];
      });
      return { ...c };
    },
    async isAvailable(cabanaId, entrada, salida, excludeReservaId = null) {
      const choca = db.reservas.some((r) =>
        r.cabana_id === Number(cabanaId) &&
        ['pendiente', 'confirmada'].includes(r.estado) &&
        r.id !== excludeReservaId &&
        overlap(entrada, salida, r.entrada, r.salida));
      if (choca) return false;
      const bloqueado = db.bloqueos.some((b) =>
        (b.cabana_id === Number(cabanaId) || b.cabana_id === null) &&
        overlap(entrada, salida, b.desde, b.hasta));
      return !bloqueado;
    },
    async availableCabanas(entrada, salida, personas) {
      const out = [];
      for (const c of db.cabanas) {
        if (!c.activa || c.capacidad < personas) continue;
        if (await this.isAvailable(c.id, entrada, salida)) out.push({ ...c });
      }
      return out;
    },
    async createReserva(d) {
      const row = { id: nextId('reservas'), estado: 'pendiente', created_at: new Date().toISOString(), ...d };
      db.reservas.push(row);
      return { ...row };
    },
    async listReservas(filters = {}) {
      let rows = db.reservas.slice();
      if (filters.estado) rows = rows.filter((r) => r.estado === filters.estado);
      if (filters.desde) rows = rows.filter((r) => r.salida >= filters.desde);
      if (filters.hasta) rows = rows.filter((r) => r.entrada <= filters.hasta);
      if (filters.q) {
        const s = filters.q.toLowerCase();
        rows = rows.filter((r) =>
          (r.nombre || '').toLowerCase().includes(s) ||
          (r.codigo || '').toLowerCase().includes(s) ||
          (r.telefono || '').includes(s) ||
          (r.email || '').toLowerCase().includes(s));
      }
      return rows
        .map((r) => {
          const c = db.cabanas.find((x) => x.id === r.cabana_id);
          return { ...r, cabana_nombre: c ? c.nombre : null, cabana_slug: c ? c.slug : null };
        })
        .sort((a, b) => (a.entrada < b.entrada ? 1 : a.entrada > b.entrada ? -1 : b.id - a.id));
    },
    async updateReservaEstado(id, estado) {
      const r = db.reservas.find((x) => x.id === Number(id));
      if (!r) return null;
      r.estado = estado;
      return { ...r };
    },
    async deleteReserva(id) {
      db.reservas = db.reservas.filter((x) => x.id !== Number(id));
    },
    async listBloqueos() {
      return db.bloqueos
        .map((b) => {
          const c = db.cabanas.find((x) => x.id === b.cabana_id);
          return { ...b, cabana_nombre: c ? c.nombre : null };
        })
        .sort((a, b) => (a.desde < b.desde ? 1 : -1));
    },
    async createBloqueo(d) {
      const row = { id: nextId('bloqueos'), created_at: new Date().toISOString(), ...d };
      db.bloqueos.push(row);
      return { ...row };
    },
    async deleteBloqueo(id) {
      db.bloqueos = db.bloqueos.filter((x) => x.id !== Number(id));
    },
    async stats() {
      const today = todayISO();
      return {
        pendientes: db.reservas.filter((r) => r.estado === 'pendiente').length,
        confirmadas: db.reservas.filter((r) => r.estado === 'confirmada').length,
        proximas: db.reservas.filter((r) => r.estado === 'confirmada' && r.entrada >= today).length,
        ingresos: db.reservas
          .filter((r) => ['confirmada', 'completada'].includes(r.estado))
          .reduce((s, r) => s + Number(r.total || 0), 0),
      };
    },
  };
}

// ---------- Selección de backend ----------
let impl = null;
async function init() {
  if (process.env.DATABASE_URL) {
    impl = makePgBackend();
    console.log('[repo] Usando PostgreSQL');
  } else {
    impl = makeMemoryBackend();
    console.warn('[repo] DATABASE_URL no definido — usando almacén EN MEMORIA (los datos se pierden al reiniciar). Solo para pruebas locales.');
  }
  await impl.init();
}

module.exports = {
  ESTADOS,
  todayISO,
  nightsBetween,
  genCodigo,
  init,
  listCabanas: (...a) => impl.listCabanas(...a),
  getCabana: (...a) => impl.getCabana(...a),
  getCabanaBySlug: (...a) => impl.getCabanaBySlug(...a),
  updateCabana: (...a) => impl.updateCabana(...a),
  isAvailable: (...a) => impl.isAvailable(...a),
  availableCabanas: (...a) => impl.availableCabanas(...a),
  createReserva: (...a) => impl.createReserva(...a),
  listReservas: (...a) => impl.listReservas(...a),
  updateReservaEstado: (...a) => impl.updateReservaEstado(...a),
  deleteReserva: (...a) => impl.deleteReserva(...a),
  listBloqueos: (...a) => impl.listBloqueos(...a),
  createBloqueo: (...a) => impl.createBloqueo(...a),
  deleteBloqueo: (...a) => impl.deleteBloqueo(...a),
  stats: (...a) => impl.stats(...a),
};
