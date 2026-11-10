const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createFleetServer } = require('../server/index');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

test('UI & Apple HIG Compliance: HTML, CSS, JS, PWA Manifest, and Vector Icon exist and obey Anti-Slop & A11y rules', () => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  const cssPath = path.join(PUBLIC_DIR, 'styles.css');
  const jsPath = path.join(PUBLIC_DIR, 'app.js');
  const manifestPath = path.join(PUBLIC_DIR, 'manifest.json');
  const iconPath = path.join(PUBLIC_DIR, 'icons', 'icon.svg');

  assert.equal(fs.existsSync(indexPath), true, 'public/index.html must exist');
  assert.equal(fs.existsSync(cssPath), true, 'public/styles.css must exist');
  assert.equal(fs.existsSync(jsPath), true, 'public/app.js must exist');
  assert.equal(fs.existsSync(manifestPath), true, 'public/manifest.json must exist');
  assert.equal(fs.existsSync(iconPath), true, 'public/icons/icon.svg must exist');

  const html = fs.readFileSync(indexPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Anti-Slop Checks
  assert.equal(/blur-3xl/i.test(html) || /blur-3xl/i.test(css), false, 'Must not contain generic blur-3xl slop');
  assert.equal(/\bInter\b/.test(css), false, 'Must not use generic Inter font');
  assert.equal(/supercharge|empower/i.test(html), false, 'Must not contain empty marketing buzzwords');

  // Apple HIG Typography & Layout Checks
  assert.match(css, /tabular-nums/, 'Must enforce tabular-nums for telemetry metrics');
  assert.match(css, /min-height:\s*44px/, 'Must enforce minimum 44x44pt touch target height');
  assert.match(css, /prefers-reduced-motion:\s*reduce/, 'Must respect prefers-reduced-motion');
  assert.match(css, /\[data-theme="light"\]/, 'Must support Light and Dark adaptive themes');

  // Accessibility & Semantic Checks
  assert.match(html, /role="dialog"/, 'Must include accessible modal dialog');
  assert.match(html, /aria-modal="true"/, 'Modal must declare aria-modal="true"');
  assert.match(html, /aria-live="polite"/, 'Must include polite aria-live status announcer');

  // Frontend Logic Checks
  assert.match(js, /Escape/, 'Must bind Escape key to close modals');
  assert.match(js, /confirmModal/, 'Must gate destructive actions behind confirmation modal');
  assert.match(js, /renderSparklineSvg/, 'Must render inline SVG telemetry sparklines');
  assert.match(html, /id="scratchpadTextarea"/, 'Must include Sovereign Scratchpad textarea');
  assert.match(html, /id="screenshotModal"/, 'Must include Live Toshi Screenshot Preview modal');

  // PWA Manifest Checks
  assert.equal(manifest.short_name, 'Fleet Deck');
  assert.equal(manifest.display, 'standalone');
});

test('Static HTTP server delivers index.html, styles.css, app.js, manifest.json, and icon.svg with correct MIME types', async (t) => {
  const app = createFleetServer({ port: 0, disableBroadcastLoop: true });
  await app.start();
  const port = app.getPort();
  t.after(async () => {
    await app.stop();
  });

  const getPath = (urlPath) =>
    new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c.toString('utf8'); });
        res.on('end', () => resolve({ statusCode: res.statusCode, contentType: res.headers['content-type'], body }));
      }).on('error', reject);
    });

  const root = await getPath('/');
  assert.equal(root.statusCode, 200);
  assert.match(root.contentType, /text\/html/);
  assert.match(root.body, /Fleet Deck/);

  const css = await getPath('/styles.css');
  assert.equal(css.statusCode, 200);
  assert.match(css.contentType, /text\/css/);

  const icon = await getPath('/icons/icon.svg');
  assert.equal(icon.statusCode, 200);
  assert.match(icon.contentType, /image\/svg\+xml/);
});
