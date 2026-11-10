const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TelemetryHistoryRing } = require('../server/history');
const {
  validateDispatchUrl,
  createScratchpadService
} = require('../server/scratchpad');
const { getActionsCatalog } = require('../server/actions');
const { QUASIMODO_TELEMETRY_CMD, createFleetCollector } = require('../server/collector');
const { createFleetServer } = require('../server/index');

test('createFleetCollector fast-fails offline Tailscale nodes in 0ms without spawning doomed SSH processes', async () => {
  let sshCallsToQuasimodo = 0;
  const collector = createFleetCollector({
    tailscaleSocketRequest: async () => ({
      ok: true,
      statusCode: 200,
      data: {
        BackendState: 'Running',
        Self: { HostName: 'kasa', OS: 'linux', TailscaleIPs: ['100.69.155.110'], Online: true },
        Peer: {
          p1: { HostName: 'toshi', OS: 'linux', TailscaleIPs: ['100.79.246.19'], Online: true },
          p2: { HostName: 'quasimodo', OS: 'windows', TailscaleIPs: ['100.108.206.20'], Online: false, LastSeen: '2026-11-10T21:59:00Z' }
        }
      }
    }),
    dockerSocketRequest: async () => ({ ok: true, statusCode: 200, data: [] }),
    sshExec: async (host) => {
      if (host.includes('100.108.206.20')) {
        sshCallsToQuasimodo += 1;
      }
      return {
        ok: true,
        stdout: '__SECTION_BAT_CAP__\n100\n__SECTION_BAT_STATUS__\nFull\n__SECTION_LOAD__\n0.20 0.20 0.20',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 15
      };
    }
  });

  const summary = await collector.getFleetSummary({ force: true });
  assert.equal(summary.nodes.toshi.online, true);
  assert.equal(summary.nodes.quasimodo.online, false);
  assert.equal(sshCallsToQuasimodo, 0, 'Must not spawn SSH to a node that Tailscale already knows is offline');
  assert.match(summary.nodes.quasimodo.error, /Tailscale/i);
});

test('QUASIMODO_TELEMETRY_CMD is quote-free (DriveType=3) so Windows OpenSSH cmd.exe never fails with Invalid query', () => {
  assert.equal(typeof QUASIMODO_TELEMETRY_CMD, 'string');
  assert.match(QUASIMODO_TELEMETRY_CMD, /DriveType=3/);
  assert.equal(/["']/.test(QUASIMODO_TELEMETRY_CMD), false, 'Must contain no nested quotes that Windows OpenSSH strips');
});

test('TelemetryHistoryRing maintains bounded rolling series per node and computes stats', () => {
  const ring = new TelemetryHistoryRing(5);

  for (let i = 1; i <= 7; i++) {
    ring.record('toshi', {
      cpuPercent: i * 10,
      memory: { percent: 20 + i },
      temperatureC: 50 + i,
      pingMs: 100 + i
    });
  }

  const series = ring.getNodeHistory('toshi');
  assert.equal(series.points.length, 5);
  assert.deepEqual(
    series.points.map((p) => p.cpuPercent),
    [30, 40, 50, 60, 70]
  );
  assert.equal(series.stats.cpuMax, 70);
  assert.equal(series.stats.cpuAvg, 50);
  assert.equal(series.stats.lastPingMs, 107);
});

test('toshi-take-screenshot action uses non-interactive maim -u instead of blocking interactive maim -s', () => {
  const catalog = getActionsCatalog({ includeInternalCommand: true });
  const snapAction = catalog.find((a) => a.id === 'toshi-take-screenshot');
  assert.ok(snapAction);
  assert.match(snapAction.command, /maim\s+-u/);
  assert.equal(/maim\s+-s/.test(snapAction.command), false, 'Must never use interactive -s flag in headless SSH');
});

test('validateDispatchUrl allows clean http/https URLs and rejects shell metacharacters or non-http schemes', () => {
  assert.equal(validateDispatchUrl('http://100.69.155.110:8090').ok, true);
  assert.equal(validateDispatchUrl('https://github.com/meucak').ok, true);

  assert.equal(validateDispatchUrl('javascript:alert(1)').ok, false);
  assert.equal(validateDispatchUrl('file:///etc/passwd').ok, false);
  assert.equal(validateDispatchUrl('http://example.com"; rm -rf /').ok, false);
  assert.equal(validateDispatchUrl('http://example.com`id`').ok, false);
});

test('Scratchpad service stores notes, pushes clipboard safely via stdin, and dispatches validated URLs', async () => {
  const sentStdin = [];
  const sshCalls = [];

  const svc = createScratchpadService({
    storagePath: '/tmp/test-fleet-scratchpad-' + Date.now() + '.json',
    sshStdinExec: async (host, remoteCmd, stdinText) => {
      sentStdin.push({ host, remoteCmd, stdinText });
      return { ok: true, durationMs: 19 };
    },
    sshExec: async (host, remoteCmd) => {
      sshCalls.push({ host, remoteCmd });
      return { ok: true, stdout: 'opened', durationMs: 22 };
    }
  });

  const saved = await svc.saveNote('Tailscale IP: 100.69.155.110:8091');
  assert.equal(saved.text, 'Tailscale IP: 100.69.155.110:8091');

  const clipRes = await svc.pushClipboard('toshi', 'Secret $(whoami) text');
  assert.equal(clipRes.ok, true);
  assert.equal(sentStdin.length, 1);
  assert.equal(sentStdin[0].stdinText, 'Secret $(whoami) text');
  assert.match(sentStdin[0].remoteCmd, />\/dev\/null\s+2>&1/, 'xclip over SSH must redirect stdout/stderr to /dev/null so X11 daemon does not hang SSH');

  const badUrlRes = await svc.openUrlOnNode('quasimodo', 'http://bad.com & calc.exe');
  assert.equal(badUrlRes.ok, false);
  assert.equal(sshCalls.length, 0);

  const goodUrlRes = await svc.openUrlOnNode('toshi', 'http://100.69.155.110:8090');
  assert.equal(goodUrlRes.ok, true);
  assert.equal(sshCalls.length, 1);
});

test('v2 HTTP endpoints: /api/scratchpad, /api/dispatch/clipboard, /api/dispatch/open-url, /api/nodes/toshi/control, and /api/nodes/toshi/screenshot', async (t) => {
  const mockCollector = {
    getFleetSummary: async () => ({
      timestamp: new Date().toISOString(),
      nodes: { kasa: { online: true }, toshi: { online: true }, quasimodo: { online: true } },
      docker: { runningCount: 1, totalCount: 1, containers: [] },
      tailscale: { backendState: 'Running', onlineCount: 3, totalCount: 3, nodes: [] },
      services: [],
      history: { kasa: { points: [] }, toshi: { points: [] }, quasimodo: { points: [] } }
    }),
    captureToshiScreenshot: async () => ({
      ok: true,
      mimeType: 'image/png',
      base64: Buffer.from('fake-png-bytes').toString('base64'),
      capturedAt: '2026-11-10T16:48:00Z'
    }),
    controlToshiHardware: async (type, value) => {
      if (type === 'brightness' && value < 10) {
        const err = new Error('Brightness cannot be set below 10% to prevent black screen');
        err.statusCode = 400;
        throw err;
      }
      return { ok: true, type, value };
    }
  };

  const mockScratchpad = {
    getNote: async () => ({ text: 'hello fleet', updatedAt: '2026-11-10T16:48:00Z' }),
    saveNote: async (text) => ({ text, updatedAt: '2026-11-10T16:48:05Z' }),
    pushClipboard: async (node, text) => ({ ok: true, node, length: text.length }),
    openUrlOnNode: async (node, url) => {
      const v = validateDispatchUrl(url);
      if (!v.ok) return { ok: false, error: v.error };
      return { ok: true, node, url };
    }
  };

  const app = createFleetServer({
    port: 0,
    collector: mockCollector,
    scratchpad: mockScratchpad,
    disableBroadcastLoop: true
  });
  await app.start();
  const port = app.getPort();
  t.after(async () => await app.stop());

  const reqJson = (method, path, body = null) =>
    new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c.toString('utf8'); });
          res.on('end', () => resolve({ statusCode: res.statusCode, json: JSON.parse(raw) }));
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  const snap = await reqJson('GET', '/api/nodes/toshi/screenshot');
  assert.equal(snap.statusCode, 200);
  assert.equal(snap.json.ok, true);
  assert.equal(typeof snap.json.base64, 'string');

  const lowBright = await reqJson('POST', '/api/nodes/toshi/control', { type: 'brightness', value: 2 });
  assert.equal(lowBright.statusCode, 400);

  const okVol = await reqJson('POST', '/api/nodes/toshi/control', { type: 'volume', value: 65 });
  assert.equal(okVol.statusCode, 200);
  assert.equal(okVol.json.value, 65);

  const noteSave = await reqJson('POST', '/api/scratchpad', { text: 'New shared fleet note' });
  assert.equal(noteSave.statusCode, 200);
  assert.equal(noteSave.json.text, 'New shared fleet note');

  const badUrl = await reqJson('POST', '/api/dispatch/open-url', { node: 'toshi', url: 'javascript:evil()' });
  assert.equal(badUrl.statusCode, 400);
});
