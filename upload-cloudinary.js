/**
 * Sube todo statics/ a Cloudinary, reescribe las rutas en los HTML y deja un mapa.
 *
 * Uso (PowerShell):
 *   $env:CLOUDINARY_API_KEY="tu_key"; $env:CLOUDINARY_API_SECRET="tu_secret"; node upload-cloudinary.js
 * Uso (bash):
 *   CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=... node upload-cloudinary.js
 *
 * cloud_name por defecto: dxfgqsp8y (cámbialo con CLOUDINARY_CLOUD_NAME)
 */
const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'dxfgqsp8y';
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error('❌ Falta CLOUDINARY_API_KEY y/o CLOUDINARY_API_SECRET en las variables de entorno.');
  process.exit(1);
}

cloudinary.config({ cloud_name: CLOUD_NAME, api_key: API_KEY, api_secret: API_SECRET, secure: true });

const ROOT = __dirname;
const STATICS = path.join(ROOT, 'statics');
const FOLDER = 'ventana-al-llano';
const HTML_FILES = ['index.html', 'reservar.html', 'admin.html'];
const RES_TYPE = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.gif': 'image',
  '.mp4': 'video', '.mov': 'video', '.webm': 'video',
};

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

function sanitize(p) {
  // mantiene las barras de carpeta, limpia el resto
  return p.split('/').map((seg) => seg.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_')).join('/');
}

(async () => {
  const files = walk(STATICS);
  const map = {};
  let n = 0;

  for (const abs of files) {
    const ext = path.extname(abs).toLowerCase();
    const rtype = RES_TYPE[ext];
    if (!rtype) continue;

    const relFromRoot = path.relative(ROOT, abs).split(path.sep).join('/'); // statics/...
    const relFromStatics = path.relative(STATICS, abs).split(path.sep).join('/');
    const publicId = FOLDER + '/' + sanitize(relFromStatics);

    process.stdout.write(`(${++n}) ${relFromStatics} ... `);
    try {
      const res = await cloudinary.uploader.upload(abs, {
        public_id: publicId, resource_type: rtype,
        overwrite: true, unique_filename: false, use_filename: false,
      });
      map[relFromRoot] = res.secure_url;
      console.log('OK');
    } catch (e) {
      console.log('ERROR: ' + e.message);
    }
  }

  fs.writeFileSync(path.join(ROOT, 'cloudinary-map.json'), JSON.stringify(map, null, 2));
  console.log(`\n📦 ${Object.keys(map).length} archivos subidos. Mapa: cloudinary-map.json`);

  // Reescribe los HTML reemplazando statics/... por la URL de Cloudinary
  // (ordena por longitud descendente para evitar reemplazos parciales)
  const pairs = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  for (const hf of HTML_FILES) {
    const fp = path.join(ROOT, hf);
    if (!fs.existsSync(fp)) continue;
    let html = fs.readFileSync(fp, 'utf8');
    let count = 0;
    for (const [local, url] of pairs) {
      const before = html;
      html = html.split(local).join(url);
      if (html !== before) count++;
    }
    fs.writeFileSync(fp, html);
    console.log(`✍️  ${hf}: rutas actualizadas (${count} archivos referenciados)`);
  }

  // Imprime las URLs de las cabañas para actualizar repo.js
  console.log('\n🏠 URLs de cabañas (para repo.js SEED_CABANAS):');
  for (const [local, url] of Object.entries(map)) {
    if (/cabana-(chiguiro|mico|perezoso)\/.*\.(jpg|jpeg|png)$/i.test(local)) {
      // solo la primera imagen de cada carpeta sirve de referencia
    }
  }
  console.log(JSON.stringify(map, null, 2));
  console.log('\n✅ Listo. Revisa los HTML y luego actualiza repo.js con las URLs de las cabañas.');
})();
