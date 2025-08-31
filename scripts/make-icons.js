// "npm run make-icons"
// with only logo.png (1024px+) saved in assets/, this will generate the needed icons for windows, linux, and mac
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import iconGenPkg from 'icon-gen';

const iconGen = iconGenPkg.default || iconGenPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT = path.join(__dirname, '..', 'assets', 'logo.png'); // source
const OUT_DIR = path.join(__dirname, '..', 'assets');
const LINUX_PNG_DIR = path.join(OUT_DIR, 'icons', 'png');        // Linux PNGs only
const TMP_DIR = path.join(OUT_DIR, '.tmp');
const PREPARED = path.join(TMP_DIR, 'logo-1024.png');

const linuxSizes = [16, 32, 48, 128, 256, 512, 1024];

async function ensurePreparedPng() {
  await fs.access(INPUT).catch(() => {
    throw new Error(`Source not found: ${INPUT}\nPlace a high-res PNG there (ideally 1024x1024, transparent).`);
  });

  const img = sharp(INPUT).png();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error('Could not read image metadata.');

  const maxSide = Math.max(meta.width, meta.height, 1024);
  await fs.mkdir(TMP_DIR, { recursive: true });

  await img
    .extend({
      top: Math.floor((maxSide - meta.height) / 2),
      bottom: Math.ceil((maxSide - meta.height) / 2),
      left: Math.floor((maxSide - meta.width) / 2),
      right: Math.ceil((maxSide - meta.width) / 2),
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .resize(1024, 1024, { fit: 'cover' })
    .toFile(PREPARED);

  return PREPARED;
}

async function run() {
  try {
    console.log('🔎 Preparing source PNG…');
    const prepared = await ensurePreparedPng();

    await fs.mkdir(LINUX_PNG_DIR, { recursive: true });

    console.log('🛠️  Generating .icns (macOS) and .ico (Windows)…');
    // Generate directly into OUT_DIR (no duplicates in /icons)
    await iconGen(prepared, OUT_DIR, {
      report: true,
      modes: ['icns', 'ico'],
      icns: { name: 'logo' }, // assets/logo.icns
      ico: { name: 'logo' }   // assets/logo.ico
    });

    console.log('🛠️  Generating Linux PNG set…');
    for (const size of linuxSizes) {
      const outFile = path.join(LINUX_PNG_DIR, `logo-${size}x${size}.png`);
      await sharp(prepared).resize(size, size).toFile(outFile);
    }

    console.log('✅ Done!');
    console.log(`- macOS: ${path.join(OUT_DIR, 'logo.icns')}`);
    console.log(`- Windows: ${path.join(OUT_DIR, 'logo.ico')}`);
    console.log(`- Linux PNGs: ${LINUX_PNG_DIR}`);
  } catch (err) {
    console.error('❌ Icon generation failed:', err?.message || err);
    process.exit(1);
  } finally {
    await fs.rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

run();
