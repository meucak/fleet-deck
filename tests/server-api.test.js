const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createFleetServer } = require('../server/index');

function httpRequest(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk.toString('utf8'); });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) {}
          resolve({ statusCode: res.statusCode, headers: res.headers, json, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('Fleet Deck API endpoints serve health, summary, docker controls (with self-stop guard), actions, terminal guard, and depo overview', async (t) => {
  const mockCollector = {
    getFleetSummary: async ({ force } = {}) => ({
      timestamp: '2026-11-10T16:30:00Z',
      forced: Boolean(force),
      nodes: {
        kasa: { node: 'kasa', online: true, cpuPercent: 12, memory: { percent: 25, usedMb: 2000, totalMb: 8000 } },
        toshi: { node: 'toshi', online: true, cpuPercent: 15, battery: { percent: 100, status: 'Full' } },
        quasimodo: { node: 'quasimodo', online: true, cpuPercent: 5, battery: { percent: 100, quirkNormalized: true } }
      },
      tailscale: { backendState: 'Running', onlineCount: 3, totalCount: 6, nodes: [] },
      docker: { runningCount: 5, totalCount: 6, containers: [] },
      services: [{ id: 'fil', name: 'Fil', port: 8090, online: true }]
    }),
    getDockerContainers: async () => [
      { id: 'c1', name: 'fil', image: 'fil-fil', state: 'running', status: 'Up 4 hours', ports: [8090] },
      { id: 'self1', name: 'fleet-deck', image: 'fleet-deck', state: 'running', status: 'Up 1 hour', ports: [8091] }
    ],
    performDockerAction: async (id, action) => {
      if ((id === 'self1' || id === 'fleet-deck') && action === 'stop') {
        const err = new Error('Stopping fleet-deck itself is blocked to prevent mission control lockout. Use restart instead.');
        err.statusCode = 400;
        throw err;
      }
      return { ok: true, id, action };
    },
    getDockerContainerLogs: async (id) => ({
      ok: true,
      id,
      logs: `2026-11-10T16:30:00Z [${id}] server listening`
    }),
    getDepoOverview: async () => ({
      ok: true,
      apps: ['fil', 'kush', 'fleet-deck'],
      musicCount: 42,
      parasFiles: [],
      parasClean: true,
      isoFiles: [{ name: 'solid2015_disk1.iso', sizeMb: 1548 }]
    })
  };

  const mockActions = {
    getActionsCatalog: () => [
      { id: 'toshi-toggle-control-center', node: 'toshi', label: 'Toggle Control Center', destructive: false }
    ],
    getAuditLog: () => [],
    executeAction: async (id) => ({ ok: true, actionId: id, stdout: 'Toggled', durationMs: 25 }),
    executeAdHocCommand: async (node, command) => {
      if (command.includes('rm -rf /')) {
        return { ok: false, error: 'Command blocked by safety guardrail: Root filesystem deletion blocked' };
      }
      return { ok: true, node, command, stdout: 'up 2 hours', durationMs: 18 };
    }
  };

  const app = createFleetServer({ port: 0, collector: mockCollector, actions: mockActions, disableBroadcastLoop: true });
  await app.start();
  const port = app.getPort();

  t.after(async () => {
    await app.stop();
  });

  // 1. Health check
  const health = await httpRequest(port, 'GET', '/api/health');
  assert.equal(health.statusCode, 200);
  assert.equal(health.json.ok, true);
  assert.equal(health.json.service, 'fleet-deck');

  // 2. Fleet Summary
  const summary = await httpRequest(port, 'GET', '/api/fleet/summary?force=true');
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json.forced, true);
  assert.equal(summary.json.nodes.kasa.online, true);
  assert.equal(summary.json.nodes.quasimodo.battery.quirkNormalized, true);

  // 3. Docker Containers list
  const containers = await httpRequest(port, 'GET', '/api/docker/containers');
  assert.equal(containers.statusCode, 200);
  assert.equal(containers.json.containers.length, 2);

  // 4. Docker Self-Stop Protection returns HTTP 400
  const selfStop = await httpRequest(port, 'POST', '/api/docker/containers/self1/action', { action: 'stop' });
  assert.equal(selfStop.statusCode, 400);
  assert.match(selfStop.json.error, /lockout/i);

  // 5. Docker Restart allowed
  const restartFil = await httpRequest(port, 'POST', '/api/docker/containers/c1/action', { action: 'restart' });
  assert.equal(restartFil.statusCode, 200);
  assert.equal(restartFil.json.ok, true);

  // 6. Docker Container Logs
  const logs = await httpRequest(port, 'GET', '/api/docker/containers/c1/logs');
  assert.equal(logs.statusCode, 200);
  assert.match(logs.json.logs, /server listening/);

  // 7. Actions Catalog & Run
  const actionsList = await httpRequest(port, 'GET', '/api/actions');
  assert.equal(actionsList.statusCode, 200);
  assert.equal(actionsList.json.actions.length, 1);

  const actionRun = await httpRequest(port, 'POST', '/api/actions/toshi-toggle-control-center/run', {});
  assert.equal(actionRun.statusCode, 200);
  assert.equal(actionRun.json.ok, true);

  // 8. Ad-Hoc Terminal Command Safety Guard
  const unsafeExec = await httpRequest(port, 'POST', '/api/terminal/exec', { node: 'kasa', command: 'rm -rf /' });
  assert.equal(unsafeExec.statusCode, 400);
  assert.match(unsafeExec.json.error, /blocked/i);

  const safeExec = await httpRequest(port, 'POST', '/api/terminal/exec', { node: 'toshi', command: 'uptime' });
  assert.equal(safeExec.statusCode, 200);
  assert.equal(safeExec.json.ok, true);

  // 9. Depo Overview
  const depo = await httpRequest(port, 'GET', '/api/depo/overview');
  assert.equal(depo.statusCode, 200);
  assert.equal(depo.json.parasClean, true);
  assert.equal(depo.json.musicCount, 42);
});
