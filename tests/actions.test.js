const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getActionsCatalog,
  executeAction,
  executeAdHocCommand,
  getAuditLog,
  clearAuditLog
} = require('../server/actions');

test('getActionsCatalog returns curated actions for kasa, toshi, and quasimodo with HIG confirmation metadata', () => {
  const catalog = getActionsCatalog();
  assert.equal(Array.isArray(catalog), true);
  assert.equal(catalog.length >= 9, true);

  const nodes = new Set(catalog.map((a) => a.node));
  assert.equal(nodes.has('kasa'), true);
  assert.equal(nodes.has('toshi'), true);
  assert.equal(nodes.has('quasimodo'), true);

  const destructive = catalog.filter((a) => a.destructive);
  assert.equal(destructive.length >= 2, true);
  for (const item of destructive) {
    assert.equal(typeof item.confirmText, 'string');
    assert.equal(item.confirmText.length > 10, true);
  }
});

test('executeAction dispatches remote SSH or local commands and records audit entry', async () => {
  clearAuditLog();
  const calls = [];
  const fakeDeps = {
    sshExec: async (host, cmd) => {
      calls.push({ type: 'ssh', host, cmd });
      return { ok: true, stdout: 'Toggled control center', stderr: '', exitCode: 0, timedOut: false, durationMs: 42 };
    },
    runCommand: async (cmd, args) => {
      calls.push({ type: 'local', cmd, args });
      return { ok: true, stdout: 'Local ok', stderr: '', exitCode: 0, timedOut: false, durationMs: 12 };
    }
  };

  const res = await executeAction('toshi-toggle-control-center', fakeDeps);
  assert.equal(res.ok, true);
  assert.equal(res.actionId, 'toshi-toggle-control-center');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].host, 'toshi@100.79.246.19');

  const log = getAuditLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].actionId, 'toshi-toggle-control-center');
  assert.equal(log[0].ok, true);
});

test('executeAction rejects unknown actionId cleanly', async () => {
  const res = await executeAction('non-existent-action-id');
  assert.equal(res.ok, false);
  assert.match(res.error, /Unknown action/i);
});

test('executeAdHocCommand blocks unsafe commands before invoking executor and keeps audit log bounded to 50', async () => {
  clearAuditLog();
  let invoked = false;
  const fakeDeps = {
    sshExec: async () => {
      invoked = true;
      return { ok: true, stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, durationMs: 5 };
    },
    runCommand: async () => {
      invoked = true;
      return { ok: true, stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, durationMs: 5 };
    }
  };

  const blocked = await executeAdHocCommand('kasa', 'rm -rf /', fakeDeps);
  assert.equal(blocked.ok, false);
  assert.equal(invoked, false);
  assert.match(blocked.error, /blocked/i);

  // Fill 55 entries and verify audit log caps at 50
  for (let i = 0; i < 55; i++) {
    await executeAdHocCommand('toshi', `uptime #${i}`, fakeDeps);
  }
  const log = getAuditLog();
  assert.equal(log.length, 50);
});
