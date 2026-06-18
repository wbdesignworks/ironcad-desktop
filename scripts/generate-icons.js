/**
 * generate-icons.js
 *
 * Generates platform-specific app icons from the base assets/icon.png (>=512x512).
 *   - Windows  -> assets/icon.ico  (multi-resolution: 16,24,32,48,64,128,256)
 *   - macOS    -> assets/icon.icns (multi-resolution iconset)
 *
 * The committed assets/icon.ico and assets/icon.icns are ALREADY real
 * multi-resolution icons (regenerated 2026-06-14, replacing earlier renamed-PNG
 * placeholders). Re-run this only if you change assets/icon.png.
 *
 * Strategy (best available wins; all optional — electron-builder can also auto-convert
 * a 512x512 PNG at build time, so a missing converter is non-fatal):
 *   1. npm dev-dep png-to-ico for .ico
 *   2. ImageMagick `magick`/`convert` on PATH for .ico
 *   3. macOS iconutil + sips for .icns
 * If a real icon already exists, it is left untouched.
 *
 * Usage: node scripts/generate-icons.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const assetsDir = path.join(__dirname, '..', 'assets');
const srcIcon = path.join(assetsDir, 'icon.png');
const icoPath = path.join(assetsDir, 'icon.ico');
const icnsPath = path.join(assetsDir, 'icon.icns');

if (!fs.existsSync(srcIcon)) {
  console.error('ERROR: assets/icon.png not found. Provide a >=512x512 PNG first.');
  process.exit(1);
}
console.log('Source icon:', srcIcon, `(${fs.statSync(srcIcon).size} bytes)`);

function have(cmd) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}
// A real .ico starts with bytes 00 00 01 00; a renamed PNG starts with 89 50 4E 47.
function isRealIco(p) {
  try { const b = fs.readFileSync(p).subarray(0, 4); return b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0; }
  catch { return false; }
}
// A real .icns starts with the ASCII magic "icns".
function isRealIcns(p) {
  try { return fs.readFileSync(p).subarray(0, 4).toString('ascii') === 'icns'; }
  catch { return false; }
}

// ── Windows .ico ──────────────────────────────────────────────────
if (isRealIco(icoPath)) {
  console.log('OK: assets/icon.ico is already a real multi-res ICO — leaving it.');
} else {
  let done = false;
  try {
    const pngToIco = require('png-to-ico'); // optional: npm i -D png-to-ico
    pngToIco(srcIcon).then((buf) => { fs.writeFileSync(icoPath, buf); console.log('Created assets/icon.ico via png-to-ico'); });
    done = true;
  } catch { /* fall through to ImageMagick */ }
  if (!done) {
    const im = have('magick') ? 'magick' : (have('convert') ? 'convert' : null);
    if (im) {
      execFileSync(im, [srcIcon, '-define', 'icon:auto-resize=256,128,64,48,32,24,16', icoPath]);
      console.log(`Created assets/icon.ico via ImageMagick (${im})`);
      done = true;
    }
  }
  if (!done) console.warn('WARN: could not regenerate icon.ico (install png-to-ico or ImageMagick). electron-builder converts icon.png at build time as a fallback.');
}

// ── macOS .icns ───────────────────────────────────────────────────
if (isRealIcns(icnsPath)) {
  console.log('OK: assets/icon.icns is already a real ICNS — leaving it.');
} else if (process.platform === 'darwin' && have('iconutil') && have('sips')) {
  const set = path.join(assetsDir, 'icon.iconset');
  fs.mkdirSync(set, { recursive: true });
  const sizes = [[16,'16x16'],[32,'16x16@2x'],[32,'32x32'],[64,'32x32@2x'],[128,'128x128'],[256,'128x128@2x'],[256,'256x256'],[512,'256x256@2x'],[512,'512x512'],[1024,'512x512@2x']];
  for (const [sz, name] of sizes) execFileSync('sips', ['-z', String(sz), String(sz), srcIcon, '--out', path.join(set, `icon_${name}.png`)]);
  execFileSync('iconutil', ['-c', 'icns', set, '-o', icnsPath]);
  fs.rmSync(set, { recursive: true, force: true });
  console.log('Created assets/icon.icns via iconutil');
} else {
  console.warn('WARN: icon.icns not regenerated here (needs macOS iconutil/sips). The committed real asset stands; electron-builder also converts icon.png at build time on macOS.');
}

console.log('Done.');
