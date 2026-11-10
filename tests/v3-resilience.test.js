const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createFleetCollector, probeServiceHttp } = require('../server/collector');
const { createFleetServer } = require('../server/index');

test('createFleetCollector preserves lastKnown hardware snapshot when an online laptop later goes to sleep', async () => {
  let quasiOnlineOnTailscale = true;

  const collector = createFleetCollector({
    lastKnownStoragePath: '/tmp/test-last-known-' + Date.now() + '.json',
    tailscaleSocketRequest: async () => ({
      ok: true,
      statusCode: 200,
      data: {
        BackendState: 'Running',
        Self: { HostName: 'kasa', OS: 'linux', TailscaleIPs: ['100.69.155.110'], Online: true },
        Peer: {
          p1: { HostName: 'toshi', OS: 'linux', TailscaleIPs: ['100.79.246.19'], Online: true },
          p2: { HostName: 'quasimodo', OS: 'windows', TailscaleIPs: ['100.108.206.20'], Online: quasiOnlineOnTailscale }
        }
      }
    }),
    dockerSocketRequest: async () => ({ ok: true, statusCode: 200, data: [] }),
    sshExec: async (host) => {
      if (host.includes('100.108.206.20')) {
        return {
          ok: true,
          stdout: [
            'LoadPercentage=11',
            'FreePhysicalMemory=4100000',
            'TotalVisibleMemorySize=8256664',
            'FreeSpace=38536863744',
            'Size=239358746624',
            'BatteryStatus=2',
            'EstimatedChargeRemaining=563'
          ].join('\r\n'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          durationMs: 120
        };
      }
      return {
        ok: true,
        stdout: '__SECTION_BAT_CAP__\n95\n__SECTION_BAT_STATUS__\nCharging\n__SECTION_LOAD__\n0.25 0.30 0.35',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 18
      };
    }
  });

  // Poll 1: Quasimodo is online
  const first = await collector.getFleetSummary({ force: true });
  assert.equal(first.nodes.quasimodo.online, true);
  assert.equal(first.nodes.quasimodo.disk.freeGb, 35.9);

  // Poll 2: Quasimodo closes lid and goes offline on Tailscale
  quasiOnlineOnTailscale = false;
  const second = await collector.getFleetSummary({ force: true });
  assert.equal(second.nodes.quasimodo.online, false);
  assert.ok(second.nodes.quasimodo.lastKnown, 'Must attach lastKnown snapshot when node goes offline');
  assert.equal(second.nodes.quasimodo.lastKnown.disk.freeGb, 35.9);
  assert.equal(second.nodes.quasimodo.lastKnown.battery.status, 'AC Direct (100%)');
  assert.equal(typeof second.nodes.quasimodo.lastKnown.lastSeenOnlineAt, 'string');
});

test('probeServiceHttp measures TCP/HTTP reachability and latency accurately', async (t) => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  t.after(() => srv.close());

  const alive = await probeServiceHttp('127.0.0.1', port, 1000);
  assert.equal(alive.reachable, true);
  assert.equal(typeof alive.latencyMs, 'number');

  const dead = await probeServiceHttp('127.0.0.1', 65431, 300);
  assert.equal(dead.reachable, false);
});

test('GET /api/fleet/export returns downloadable JSON diagnostic snapshot', async (t) => {
  const app = createFleetServer({ port: 0, disableBroadcastLoop: true });
  await app.start();
  const port = app.getPort();
  t.after(async () => await app.stop());

  const res = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/api/fleet/export' }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c.toString('utf8'); });
      r.on('end', () => resolve({ statusCode: r.statusCode, headers: r.headers, body }));
    }).on('error', reject);
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-disposition'] || '', /attachment;\s*filename="fleet-deck-snapshot-/);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.exportedFrom, 'fleet-deck');
});
