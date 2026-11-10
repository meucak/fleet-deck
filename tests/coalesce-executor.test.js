const test = require('node:test');
const assert = require('node:assert/strict');
const { CoalescingCache } = require('../server/coalesce');
const {
  runCommand,
  dockerSocketRequest,
  tailscaleSocketRequest
} = require('../server/executor');

test('CoalescingCache coalesces 25 simultaneous requests into a single in-flight execution even with force=true', async () => {
  const cache = new CoalescingCache(5000);
  let executions = 0;

  const slowFetcher = async () => {
    executions += 1;
    await new Promise((r) => setTimeout(r, 80));
    return { seq: executions, ok: true };
  };

  const promises = Array.from({ length: 25 }, (_, i) =>
    cache.getOrFetch('toshi', slowFetcher, { force: i % 2 === 0 })
  );

  const results = await Promise.all(promises);
  assert.equal(executions, 1);
  for (const res of results) {
    assert.deepEqual(res, { seq: 1, ok: true });
  }

  // Subsequent non-forced call within TTL uses cache without executing fetcher
  const cachedRes = await cache.getOrFetch('toshi', slowFetcher);
  assert.equal(executions, 1);
  assert.deepEqual(cachedRes, { seq: 1, ok: true });

  const stats = cache.getStats();
  assert.equal(stats.keys.includes('toshi'), true);
});

test('CoalescingCache refreshes after TTL expires or when invalidated', async () => {
  const cache = new CoalescingCache(30);
  let count = 0;
  const fetcher = async () => ({ count: ++count });

  const first = await cache.getOrFetch('node', fetcher);
  assert.equal(first.count, 1);

  await new Promise((r) => setTimeout(r, 50));
  const second = await cache.getOrFetch('node', fetcher);
  assert.equal(second.count, 2);

  cache.invalidate('node');
  const third = await cache.getOrFetch('node', fetcher);
  assert.equal(third.count, 3);
});

test('runCommand executes fast commands and enforces hard timeout on hanging commands', async () => {
  const fast = await runCommand('node', ['-e', 'process.stdout.write("hello-fleet")'], { timeoutMs: 2000 });
  assert.equal(fast.ok, true);
  assert.equal(fast.stdout, 'hello-fleet');
  assert.equal(fast.timedOut, false);

  const slow = await runCommand('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 150 });
  assert.equal(slow.ok, false);
  assert.equal(slow.timedOut, true);
});

test('dockerSocketRequest and tailscaleSocketRequest handle missing unix sockets gracefully without crashing', async () => {
  const dockerRes = await dockerSocketRequest('GET', '/containers/json', {
    socketPath: '/tmp/nonexistent-docker-fleet.sock',
    timeoutMs: 500
  });
  assert.equal(dockerRes.ok, false);
  assert.equal(typeof dockerRes.error, 'string');

  const tsRes = await tailscaleSocketRequest('/localapi/v0/status', {
    socketPath: '/tmp/nonexistent-tailscale-fleet.sock',
    timeoutMs: 500
  });
  assert.equal(tsRes.ok, false);
  assert.equal(typeof tsRes.error, 'string');
});
