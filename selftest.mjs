// Self-test: run `node selftest.mjs` before every push. Catches truncated or
// null-padded files and syntax errors before they reach Cloudflare.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let ok = true;
const fail = (m) => { ok = false; console.log('FAIL  ' + m); };
const pass = (m) => console.log('ok    ' + m);

const files = {
  'worker.js': '// EOF worker.js',
  'dashboard.html': '<!-- EOF dashboard.html -->',
  'roster.html': '<!-- EOF roster.html -->',
  'refunds.html': '<!-- EOF refunds.html -->',
  'onboard.html': '<!-- EOF onboard.html -->',
  'staff.html': '<!-- EOF staff.html -->',
  'hub.html': '<!-- EOF hub.html -->',
  'tfn.html': '<!-- EOF tfn.html -->',
  'start.html': '<!-- EOF start.html -->',
  'poster.html': '<!-- EOF poster.html -->',
  'kitchen.html': '<!-- EOF kitchen.html -->',
  'catering.html': '<!-- EOF catering.html -->',
  'catering-admin.html': '<!-- EOF catering-admin.html -->',
  'wrangler.toml': '# EOF wrangler.toml'
};
for (const [f, marker] of Object.entries(files)) {
  const t = readFileSync(f, 'utf8');
  if (t.includes('\u0000')) fail(f + ' contains null bytes (sync hazard - rebuild it)');
  else if (!t.trimEnd().endsWith(marker)) fail(f + ' is incomplete (missing end marker)');
  else pass(f + ' complete (' + t.length + ' chars)');
}

// worker.js parses as a module (strip the html import, which wrangler resolves)
try {
  const src = readFileSync('worker.js', 'utf8').replace(/^import (\w+) from .*$/mg, 'const $1 = "";').replace(/^import \{[^}]*\} from .*$/mg, '');
  new Function(src.replace(/export default/, 'const __d ='));
  pass('worker.js syntax');
} catch (e) { fail('worker.js syntax: ' + e.message); }

// vendored pdf-lib loads and can write a PDF (signed contracts, 13 Nov 2026)
try {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const dir = mkdtempSync('/tmp/bz-');
  writeFileSync(dir + '/pdf-lib.mjs', readFileSync('vendor/pdf-lib.min.js.txt', 'utf8'));
  const { PDFDocument } = await import(dir + '/pdf-lib.mjs');
  const d = await PDFDocument.create(); d.addPage(); const b = await d.save();
  if (b.length > 100) pass('vendor/pdf-lib.min.js.txt loads (' + b.length + ' byte test PDF)'); else fail('vendor/pdf-lib.mjs wrote an empty PDF');
} catch (e) { fail('vendor/pdf-lib.mjs: ' + e.message); }

// page scripts parse
for (const f of ['dashboard.html', 'roster.html', 'refunds.html', 'onboard.html', 'staff.html', 'hub.html', 'tfn.html', 'start.html', 'poster.html', 'kitchen.html', 'catering.html', 'catering-admin.html']) {
  try {
    const html = readFileSync(f, 'utf8');
    const m = html.match(/<script>([\s\S]*)<\/script>/);
    if (!m) throw new Error('no <script> block');
    new vm.Script(m[1]);
    pass(f + ' script syntax');
  } catch (e) { fail(f + ' script: ' + e.message); }
}

// wrangler name is set (not the kit placeholder)
const toml = readFileSync('wrangler.toml', 'utf8');
const name = (toml.match(/^name\s*=\s*"([^"]+)"/m) || [])[1];
if (!name || name === 'venue-dashboard') fail('wrangler.toml name not set to the repo name');
else pass('wrangler.toml name = ' + name);

console.log(ok ? '\nGREEN - safe to push' : '\nRED - do not push');
process.exit(ok ? 0 : 1);
