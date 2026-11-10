'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { createFleetCollector } = require('./collector');
const { createScratchpadService } = require('./scratchpad');
const defaultActions = require('./actions');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 64 * 1024) {
        reject(new Error('Request payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function createFleetServer(options = {}) {
  const port = options.port !== undefined ? Number(options.port) : Number(process.env.PORT || 8091);
  const collector = options.collector || createFleetCollector();
  const actions = options.actions || defaultActions;
  const scratchpad = options.scratchpad || createScratchpadService();
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, {
          ok: true,
          service: 'fleet-deck',
          version: '3.0.0',
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/fleet/summary') {
        const force = parsedUrl.searchParams.get('force') === 'true';
        const summary = await collector.getFleetSummary({ force });
        sendJson(res, 200, summary);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/fleet/export') {
        const summary = await collector.getFleetSummary({ force: false });
        const exportPayload = {
          exportedFrom: 'fleet-deck',
          version: '3.0.0',
          exportedAt: new Date().toISOString(),
          summary,
          auditLog: actions.getAuditLog()
        };
        const body = JSON.stringify(exportPayload, null, 2);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="fleet-deck-snapshot-${stamp}.json"`,
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(body)
        });
        res.end(body);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/nodes/toshi/screenshot') {
        const snap = await collector.captureToshiScreenshot();
        sendJson(res, snap.ok ? 200 : 502, snap);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/nodes/toshi/control') {
        const body = await readJsonBody(req);
        try {
          const out = await collector.controlToshiHardware(body.type, body.value);
          sendJson(res, out.ok ? 200 : 502, out);
        } catch (err) {
          sendJson(res, err.statusCode || 500, { ok: false, error: err.message });
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/scratchpad') {
        const note = await scratchpad.getNote();
        sendJson(res, 200, { ok: true, ...note });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/scratchpad') {
        const body = await readJsonBody(req);
        const saved = await scratchpad.saveNote(body.text);
        broadcastMessage({ type: 'scratchpad-update', data: saved });
        sendJson(res, 200, { ok: true, ...saved });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/dispatch/clipboard') {
        const body = await readJsonBody(req);
        const out = await scratchpad.pushClipboard(body.node, body.text);
        sendJson(res, out.ok ? 200 : 400, out);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/dispatch/open-url') {
        const body = await readJsonBody(req);
        const out = await scratchpad.openUrlOnNode(body.node, body.url);
        sendJson(res, out.ok ? 200 : 400, out);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/docker/containers') {
        const force = parsedUrl.searchParams.get('force') === 'true';
        const containers = await collector.getDockerContainers({ force });
        sendJson(res, 200, { ok: true, containers });
        return;
      }

      const dockerActionMatch = pathname.match(/^\/api\/docker\/containers\/([^/]+)\/action$/);
      if (req.method === 'POST' && dockerActionMatch) {
        const containerId = decodeURIComponent(dockerActionMatch[1]);
        const body = await readJsonBody(req);
        try {
          const out = await collector.performDockerAction(containerId, body.action);
          broadcastUpdate();
          sendJson(res, 200, out);
        } catch (err) {
          sendJson(res, err.statusCode || 500, { ok: false, error: err.message });
        }
        return;
      }

      const dockerLogsMatch = pathname.match(/^\/api\/docker\/containers\/([^/]+)\/logs$/);
      if (req.method === 'GET' && dockerLogsMatch) {
        const containerId = decodeURIComponent(dockerLogsMatch[1]);
        const out = await collector.getDockerContainerLogs(containerId);
        sendJson(res, out.ok ? 200 : 502, out);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/actions') {
        sendJson(res, 200, {
          ok: true,
          actions: actions.getActionsCatalog(),
          auditLog: actions.getAuditLog()
        });
        return;
      }

      const actionRunMatch = pathname.match(/^\/api\/actions\/([^/]+)\/run$/);
      if (req.method === 'POST' && actionRunMatch) {
        const actionId = decodeURIComponent(actionRunMatch[1]);
        const out = await actions.executeAction(actionId);
        sendJson(res, out.ok ? 200 : 400, out);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/terminal/exec') {
        const body = await readJsonBody(req);
        const out = await actions.executeAdHocCommand(body.node, body.command);
        sendJson(res, out.ok ? 200 : 400, out);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/depo/overview') {
        const force = parsedUrl.searchParams.get('force') === 'true';
        const out = await collector.getDepoOverview({ force });
        sendJson(res, 200, out);
        return;
      }

      // Static file serving
      let relPath = pathname === '/' ? '/index.html' : pathname;
      relPath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(publicDir, relPath);

      if (!filePath.startsWith(publicDir)) {
        sendJson(res, 403, { ok: false, error: 'Forbidden' });
        return;
      }

      fs.stat(filePath, (err, st) => {
        if (err || !st.isFile()) {
          sendJson(res, 404, { ok: false, error: 'Not found' });
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
        });
        fs.createReadStream(filePath).pipe(res);
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || 'Internal Server Error' });
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  let broadcastTimer = null;

  function broadcastMessage(obj) {
    if (wss.clients.size === 0) return;
    const payload = JSON.stringify(obj);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }

  async function broadcastUpdate() {
    if (wss.clients.size === 0) return;
    try {
      const summary = await collector.getFleetSummary({ force: false });
      broadcastMessage({ type: 'fleet-summary', data: summary });
    } catch (_) {}
  }

  wss.on('connection', async (ws) => {
    try {
      const summary = await collector.getFleetSummary({ force: false });
      ws.send(JSON.stringify({ type: 'fleet-summary', data: summary }));
    } catch (_) {}
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        if (!options.disableBroadcastLoop) {
          broadcastTimer = setInterval(broadcastUpdate, 8000);
          broadcastTimer.unref();
        }
        resolve(server.address().port);
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (broadcastTimer) clearInterval(broadcastTimer);
      for (const client of wss.clients) {
        try { client.terminate(); } catch (_) {}
      }
      wss.close(() => {
        server.close(() => resolve());
      });
    });
  }

  function getPort() {
    const addr = server.address();
    return addr ? addr.port : port;
  }

  return { server, wss, start, stop, getPort };
}

if (require.main === module) {
  const app = createFleetServer();
  app.start().then((actualPort) => {
    console.log(`[Fleet Deck v2.0] Sovereign Mission Control listening on http://0.0.0.0:${actualPort}`);
  }).catch((err) => {
    console.error('[Fleet Deck] Startup failed:', err);
    process.exit(1);
  });
}

module.exports = { createFleetServer };
