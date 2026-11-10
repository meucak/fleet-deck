'use strict';

const http = require('node:http');
const assert = require('node:assert/strict');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 8091, path, timeout: 15000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c.toString('utf8'); });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(raw) });
        } catch (err) {
          reject(new Error(`Invalid JSON from ${path}: ${raw.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

function postJson(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 8091,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c.toString('utf8'); });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode, data: JSON.parse(raw) });
          } catch (err) {
            reject(new Error(`Invalid JSON from ${path}: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('1. Checking /api/health...');
  const health = await getJson('/api/health');
  assert.equal(health.statusCode, 200);
  assert.equal(health.data.ok, true);

  console.log('2. Fetching live Tri-Node Telemetry (/api/fleet/summary?force=true)...');
  const summary = await getJson('/api/fleet/summary?force=true');
  assert.equal(summary.statusCode, 200);
  const { kasa, toshi, quasimodo } = summary.data.nodes;
  console.log('   - Kasa online:', kasa.online, '| CPU:', kasa.cpuPercent + '%', '| RAM:', kasa.memory.percent + '%', '| Temp:', kasa.temperatureC + '°C');
  console.log('   - Toshi online:', toshi.online, '| CPU:', toshi.cpuPercent + '%', '| Battery:', toshi.battery?.percent + '%', '| Temp:', toshi.temperatureC + '°C', '| Wi-Fi:', toshi.wifi?.signalDbm + ' dBm');
  console.log('   - Quasimodo online:', quasimodo.online, '| CPU:', quasimodo.cpuPercent + '%', '| Battery:', quasimodo.battery?.status, '| Disk C: free:', quasimodo.disk?.freeGb + ' GB');
  console.log('   - Docker running:', summary.data.docker.runningCount + '/' + summary.data.docker.totalCount);
  console.log('   - Tailscale peers online:', summary.data.tailscale.onlineCount + '/' + summary.data.tailscale.totalCount);

  assert.equal(kasa.online, true, 'Kasa must be online');
  assert.equal(toshi.online, true, 'Toshi must be online over SSH from inside container');
  const quasiPeer = summary.data.tailscale.nodes.find((n) => n.hostname === 'quasimodo');
  if (quasiPeer && quasiPeer.online) {
    assert.equal(quasimodo.online, true, 'Quasimodo is online on Tailscale so SSH telemetry must succeed');
  } else {
    assert.equal(quasimodo.online, false, 'Quasimodo is asleep on Tailscale so fast-fail offline state must be reported');
    console.log('   - Quasimodo fast-fail verified (offline on Tailscale):', quasimodo.error);
  }
  assert.equal(summary.data.docker.runningCount >= 5, true, 'Docker socket must report running containers');
  assert.equal(summary.data.tailscale.onlineCount >= 2, true, 'Tailscale socket must report online nodes');

  console.log('3. Stress testing 30 concurrent /api/fleet/summary?force=true requests (Coalescing verification)...');
  const t0 = Date.now();
  const burst = await Promise.all(
    Array.from({ length: 30 }, () => getJson('/api/fleet/summary?force=true'))
  );
  const elapsed = Date.now() - t0;
  for (const r of burst) {
    assert.equal(r.statusCode, 200);
    assert.equal(r.data.nodes.kasa.online, true);
  }
  console.log(`   - 30 concurrent requests completed in ${elapsed} ms with 0 errors!`);

  console.log('4. Testing Self-Stop Lockout Protection on fleet-deck container...');
  const selfStop = await postJson('/api/docker/containers/fleet-deck/action', { action: 'stop' });
  assert.equal(selfStop.statusCode, 400);
  console.log('   - Self-stop blocked as expected:', selfStop.data.error);

  console.log('5. Testing Safe Ad-Hoc Command Runner across Kasa, Toshi, and Quasimodo...');
  const toshiExec = await postJson('/api/terminal/exec', { node: 'toshi', command: 'hostname && uname -r' });
  assert.equal(toshiExec.statusCode, 200);
  assert.equal(toshiExec.data.ok, true);
  console.log('   - Toshi ad-hoc output:', toshiExec.data.stdout.replace(/\n/g, ' | '));

  const unsafeExec = await postJson('/api/terminal/exec', { node: 'kasa', command: 'rm -rf /' });
  assert.equal(unsafeExec.statusCode, 400);
  console.log('   - Unsafe command blocked:', unsafeExec.data.error);

  console.log('6. Testing v2 Live Toshi Screenshot Preview (/api/nodes/toshi/screenshot)...');
  const snap = await getJson('/api/nodes/toshi/screenshot');
  assert.equal(snap.statusCode, 200);
  assert.equal(snap.data.ok, true);
  assert.equal(snap.data.base64.length > 5000, true, 'Must receive real PNG base64 from Toshi Display :0');
  console.log(`   - Live Toshi desktop PNG captured (${Math.round((snap.data.base64.length * 3) / 4 / 1024)} KB in ${snap.data.durationMs} ms)`);

  console.log('7. Testing v2 Sovereign Scratchpad & Toshi Clipboard Bridge...');
  const padSave = await postJson('/api/scratchpad', { text: 'Fleet Deck v2.0 Live Sync — http://100.69.155.110:8091' });
  assert.equal(padSave.statusCode, 200);
  const clipPush = await postJson('/api/dispatch/clipboard', { node: 'toshi', text: 'http://100.69.155.110:8091' });
  assert.equal(clipPush.statusCode, 200);
  assert.equal(clipPush.data.ok, true);
  console.log('   - Pushed text to Toshi X11 clipboard in', clipPush.data.durationMs, 'ms');

  console.log('ALL LIVE E2E & STRESS CHECKS PASSED!');
}

main().catch((err) => {
  console.error('LIVE VERIFICATION FAILED:', err);
  process.exit(1);
});
