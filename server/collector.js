'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { CoalescingCache } = require('./coalesce');
const { TelemetryHistoryRing } = require('./history');
const defaultExecutor = require('./executor');
const {
  parseKasaMetrics,
  parseToshiMetrics,
  parseQuasimodoMetrics,
  parseTailscaleStatus
} = require('./parsers');

const TOSHI_TELEMETRY_SCRIPT = [
  'echo "__SECTION_BAT_CAP__"; cat /sys/class/power_supply/BAT*/capacity 2>/dev/null || echo 100',
  'echo "__SECTION_BAT_STATUS__"; cat /sys/class/power_supply/BAT*/status 2>/dev/null || echo Full',
  'echo "__SECTION_TEMP__"; cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0',
  'echo "__SECTION_LOAD__"; cat /proc/loadavg 2>/dev/null',
  'echo "__SECTION_UPTIME__"; cat /proc/uptime 2>/dev/null',
  'echo "__SECTION_FREE__"; free -m 2>/dev/null',
  'echo "__SECTION_DF__"; df -BM / 2>/dev/null | tail -1',
  'echo "__SECTION_WIFI__"; cat /proc/net/wireless 2>/dev/null',
  'echo "__SECTION_SERVICE__"; systemctl --user is-active toshi-control-center.service 2>/dev/null || echo inactive'
].join('; ');

const QUASIMODO_TELEMETRY_CMD = [
  'wmic cpu get loadpercentage /value',
  'wmic OS get FreePhysicalMemory,TotalVisibleMemorySize,LastBootUpTime /value',
  'wmic logicaldisk where DriveType=3 get DeviceID,FreeSpace,Size /value',
  'wmic path Win32_Battery get EstimatedChargeRemaining,BatteryStatus /value'
].join(' && ');

const KNOWN_SERVICES = [
  { id: 'fleet-deck', name: 'Fleet Deck', subtitle: 'Mission Control & Telemetry', port: 8091, container: 'fleet-deck' },
  { id: 'fil', name: 'Fil', subtitle: 'Universal File Bridge & Tunnel', port: 8090, container: 'fil' },
  { id: 'cat-disco', name: 'Cat Disco', subtitle: 'Interactive Synth & Visual Club', port: 8089, container: 'cat-disco' },
  { id: 'kush', name: 'Kush', subtitle: 'Zero-Latency LAN Messenger & Clipboard', port: 8088, container: 'kush' },
  { id: 'dancing-chicken', name: 'Dancing Chicken', subtitle: 'Web Audio & Stage App', port: 8085, container: 'dancing-chicken-web' },
  { id: 'simple-web', name: 'Simple Web', subtitle: 'Static Web Server', port: 8080, container: 'basic-simple-web' }
];

function stripDockerStreamHeaders(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) {
    return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  }
  if ((buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    const out = [];
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const frameLen = buf.readUInt32BE(offset + 4);
      const start = offset + 8;
      const end = Math.min(buf.length, start + frameLen);
      out.push(buf.subarray(start, end).toString('utf8'));
      offset = end;
    }
    return out.join('');
  }
  return buf.toString('utf8');
}

function probeServiceHttp(host, port, timeoutMs = 800) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (reachable) => {
      if (settled) return;
      settled = true;
      resolve({
        reachable,
        latencyMs: reachable ? Math.max(1, Date.now() - t0) : null
      });
    };

    const req = http.get(
      { hostname: host, port, path: '/', timeout: timeoutMs },
      (res) => {
        res.resume();
        done(true);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
  });
}

function createFleetCollector(deps = {}) {
  const cache = deps.cache || new CoalescingCache(8000);
  const history = deps.history || new TelemetryHistoryRing(30);
  const runCommand = deps.runCommand || defaultExecutor.runCommand;
  const sshExec = deps.sshExec || defaultExecutor.sshExec;
  const dockerSocketRequest = deps.dockerSocketRequest || defaultExecutor.dockerSocketRequest;
  const tailscaleSocketRequest = deps.tailscaleSocketRequest || defaultExecutor.tailscaleSocketRequest;

  const lastKnownStoragePath = deps.lastKnownStoragePath || process.env.LAST_KNOWN_PATH || path.join(__dirname, 'data', 'last-known-nodes.json');
  const lastKnownMap = new Map();
  let loadPromise = null;

  function ensureLastKnownLoaded() {
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const raw = await fs.readFile(lastKnownStoragePath, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) {
              if (!lastKnownMap.has(k)) {
                lastKnownMap.set(k, v);
              }
            }
          }
        } catch (_) {}
      })();
    }
    return loadPromise;
  }

  async function recordLastKnown(nodeKey, metrics) {
    await ensureLastKnownLoaded();
    const snapshot = {
      ...metrics,
      lastSeenOnlineAt: new Date().toISOString()
    };
    lastKnownMap.set(nodeKey, snapshot);
    try {
      await fs.mkdir(path.dirname(lastKnownStoragePath), { recursive: true });
      const obj = Object.fromEntries(lastKnownMap.entries());
      const tmpPath = `${lastKnownStoragePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(obj, null, 2), 'utf8');
      await fs.rename(tmpPath, lastKnownStoragePath);
    } catch (_) {}
  }

  async function attachLastKnown(nodeKey, offlineObj) {
    await ensureLastKnownLoaded();
    const prev = lastKnownMap.get(nodeKey);
    if (prev) {
      return {
        ...offlineObj,
        lastKnown: prev
      };
    }
    return offlineObj;
  }

  const depoBasePath = deps.depoPath || process.env.DEPO_PATH || '/host-depo';
  const fallbackDepoPath = '/home/kasa/Depo';
  const toshiTarget = process.env.TOSHI_SSH_TARGET || 'toshi@100.79.246.19';
  const quasimodoTarget = process.env.QUASIMODO_SSH_TARGET || 'semsettin@100.108.206.20';

  async function resolveDepoDir() {
    try {
      await fs.access(depoBasePath);
      return depoBasePath;
    } catch (_) {
      return fallbackDepoPath;
    }
  }

  async function collectKasa() {
    const t0 = Date.now();
    const [loadavg, meminfo, uptime, dfRoot, dfDepo] = await Promise.all([
      fs.readFile('/proc/loadavg', 'utf8').catch(() => ''),
      fs.readFile('/proc/meminfo', 'utf8').catch(() => ''),
      fs.readFile('/proc/uptime', 'utf8').catch(() => ''),
      runCommand('df', ['-BM', '/'], { timeoutMs: 2500 }).then((r) => r.stdout).catch(() => ''),
      resolveDepoDir().then((dir) => runCommand('df', ['-BM', dir], { timeoutMs: 2500 }).then((r) => r.stdout)).catch(() => '')
    ]);

    const thermals = [];
    for (let i = 0; i < 5; i++) {
      try {
        const t = await fs.readFile(`/sys/class/thermal/thermal_zone${i}/temp`, 'utf8');
        thermals.push(t.trim());
      } catch (_) {
        break;
      }
    }

    const parsed = parseKasaMetrics({
      loadavg,
      meminfo,
      uptime,
      thermals,
      dfRoot,
      dfDepo,
      cpuCores: os.cpus().length || 4
    });
    parsed.pingMs = Math.max(1, Date.now() - t0);
    history.record('kasa', parsed);
    return parsed;
  }

  async function collectToshi() {
    const res = await sshExec(toshiTarget, TOSHI_TELEMETRY_SCRIPT, { timeoutMs: 6500 });
    if (!res.ok || !res.stdout) {
      return attachLastKnown('toshi', {
        node: 'toshi',
        hostname: 'toshi',
        ip: '100.79.246.19',
        os: 'Linux (LXQt)',
        online: false,
        cpuPercent: 0,
        error: res.stderr || (res.timedOut ? 'SSH timeout (6.5s)' : 'Node unreachable')
      });
    }
    const parsed = parseToshiMetrics(res.stdout);
    parsed.pingMs = res.durationMs || 0;
    history.record('toshi', parsed);
    await recordLastKnown('toshi', parsed);
    return parsed;
  }

  async function collectQuasimodo() {
    const res = await sshExec(quasimodoTarget, QUASIMODO_TELEMETRY_CMD, { timeoutMs: 9000 });
    if (!res.stdout || !res.stdout.includes('=')) {
      return attachLastKnown('quasimodo', {
        node: 'quasimodo',
        hostname: 'quasimodo',
        ip: '100.108.206.20',
        os: 'Windows (Dell E6430)',
        online: false,
        cpuPercent: 0,
        error: res.stderr || (res.timedOut ? 'SSH timeout (9s)' : 'Node unreachable')
      });
    }
    const parsed = parseQuasimodoMetrics(res.stdout);
    parsed.pingMs = res.durationMs || 0;
    history.record('quasimodo', parsed);
    await recordLastKnown('quasimodo', parsed);
    return parsed;
  }

  async function captureToshiScreenshot() {
    return cache.getOrFetch(
      'toshi-screenshot',
      async () => {
        const cmd = 'DISPLAY=:0 XAUTHORITY=/home/toshi/.Xauthority maim -u /tmp/fleet_toshi_live.png && base64 -w0 /tmp/fleet_toshi_live.png && rm -f /tmp/fleet_toshi_live.png';
        const res = await sshExec(toshiTarget, cmd, { timeoutMs: 6000 });
        if (!res.ok || !res.stdout) {
          return {
            ok: false,
            error: res.stderr || 'Could not capture Toshi display (:0)'
          };
        }
        return {
          ok: true,
          mimeType: 'image/png',
          base64: res.stdout.trim(),
          capturedAt: new Date().toISOString(),
          durationMs: res.durationMs
        };
      },
      { ttlMs: 1500, force: true }
    );
  }

  async function controlToshiHardware(type, rawValue) {
    const val = Number(rawValue);
    if (type === 'brightness') {
      if (Number.isNaN(val) || val < 10 || val > 100) {
        const err = new Error('Brightness must be between 10% and 100% to prevent a dark/unusable screen.');
        err.statusCode = 400;
        throw err;
      }
      const rounded = Math.round(val);
      const frac = (rounded / 100).toFixed(2);
      const cmd = `brightnessctl set ${rounded}% >/dev/null 2>&1 || true; DISP=$(DISPLAY=:0 XAUTHORITY=/home/toshi/.Xauthority xrandr --current 2>/dev/null | grep ' connected' | head -n1 | cut -d' ' -f1); if [ -n "$DISP" ]; then DISPLAY=:0 XAUTHORITY=/home/toshi/.Xauthority xrandr --output "$DISP" --brightness ${frac}; fi; echo "Brightness set to ${rounded}%"`;
      const res = await sshExec(toshiTarget, cmd, { timeoutMs: 4500 });
      return { ok: res.ok, type, value: rounded, stdout: res.stdout, error: res.ok ? null : res.stderr };
    }

    if (type === 'volume') {
      if (Number.isNaN(val) || val < 0 || val > 100) {
        const err = new Error('Volume must be between 0% and 100%.');
        err.statusCode = 400;
        throw err;
      }
      const rounded = Math.round(val);
      const cmd = `pactl set-sink-volume @DEFAULT_SINK@ ${rounded}% && echo "Volume set to ${rounded}%"`;
      const res = await sshExec(toshiTarget, cmd, { timeoutMs: 4500 });
      return { ok: res.ok, type, value: rounded, stdout: res.stdout, error: res.ok ? null : res.stderr };
    }

    if (type === 'mute') {
      const cmd = 'pactl set-sink-mute @DEFAULT_SINK@ toggle && pactl get-sink-mute @DEFAULT_SINK@';
      const res = await sshExec(toshiTarget, cmd, { timeoutMs: 4500 });
      return { ok: res.ok, type, stdout: res.stdout, error: res.ok ? null : res.stderr };
    }

    const err = new Error(`Unsupported hardware control type "${type}".`);
    err.statusCode = 400;
    throw err;
  }

  async function getDockerContainers({ force = false } = {}) {
    return cache.getOrFetch(
      'docker-containers',
      async () => {
        const res = await dockerSocketRequest('GET', '/containers/json?all=1', { timeoutMs: 3000 });
        if (!res.ok || !Array.isArray(res.data)) {
          return [];
        }
        return res.data.map((c) => {
          const name = Array.isArray(c.Names) && c.Names[0] ? c.Names[0].replace(/^\//, '') : c.Id.slice(0, 12);
          const ports = Array.isArray(c.Ports)
            ? Array.from(new Set(c.Ports.filter((p) => p.PublicPort).map((p) => p.PublicPort))).sort((a, b) => a - b)
            : [];
          return {
            id: c.Id.slice(0, 12),
            fullId: c.Id,
            name,
            image: c.Image,
            state: c.State,
            status: c.Status,
            ports,
            created: c.Created,
            isSelf: name === 'fleet-deck'
          };
        });
      },
      { ttlMs: 3000, force }
    );
  }

  async function performDockerAction(containerId, action) {
    const allowedActions = ['start', 'stop', 'restart'];
    if (!allowedActions.includes(action)) {
      const err = new Error(`Unsupported container action "${action}". Allowed: start, stop, restart.`);
      err.statusCode = 400;
      throw err;
    }

    const containers = await getDockerContainers({ force: true });
    const target = containers.find((c) => c.id === containerId || c.fullId === containerId || c.name === containerId);
    if (!target) {
      const err = new Error(`Container "${containerId}" not found.`);
      err.statusCode = 404;
      throw err;
    }

    if (target.name === 'fleet-deck' && action === 'stop') {
      const err = new Error('Stopping fleet-deck itself is blocked to prevent mission control lockout. Use restart instead.');
      err.statusCode = 400;
      throw err;
    }

    const res = await dockerSocketRequest('POST', `/containers/${target.fullId}/${action}`, { timeoutMs: 8000 });
    cache.invalidate('docker-containers');
    if (!res.ok && res.statusCode !== 204 && res.statusCode !== 304) {
      const err = new Error(`Docker ${action} failed (HTTP ${res.statusCode}): ${res.raw || res.error || 'Unknown error'}`);
      err.statusCode = 502;
      throw err;
    }

    return {
      ok: true,
      id: target.id,
      name: target.name,
      action
    };
  }

  async function getDockerContainerLogs(containerId) {
    const containers = await getDockerContainers();
    const target = containers.find((c) => c.id === containerId || c.fullId === containerId || c.name === containerId);
    const idToUse = target ? target.fullId : containerId;

    const res = await dockerSocketRequest(
      'GET',
      `/containers/${encodeURIComponent(idToUse)}/logs?stdout=1&stderr=1&tail=80&timestamps=1`,
      { timeoutMs: 4000 }
    );
    if (!res.ok) {
      return {
        ok: false,
        id: containerId,
        logs: '',
        error: res.error || `Failed to fetch logs (HTTP ${res.statusCode})`
      };
    }

    const cleanText = stripDockerStreamHeaders(res.buffer || Buffer.from(res.raw || '', 'utf8'));
    return {
      ok: true,
      id: containerId,
      name: target ? target.name : containerId,
      logs: cleanText.trim() || '(No recent log lines)'
    };
  }

  async function collectTailscale({ force = false } = {}) {
    return cache.getOrFetch(
      'tailscale-status',
      async () => {
        const res = await tailscaleSocketRequest('/localapi/v0/status', { timeoutMs: 2500 });
        if (!res.ok || !res.data || typeof res.data !== 'object') {
          return {
            backendState: 'Unavailable',
            onlineCount: 0,
            totalCount: 0,
            nodes: []
          };
        }
        return parseTailscaleStatus(res.data);
      },
      { ttlMs: 4000, force }
    );
  }

  async function getDepoOverview({ force = false } = {}) {
    return cache.getOrFetch(
      'depo-overview',
      async () => {
        const base = await resolveDepoDir();
        const appsDir = path.join(base, 'agy', 'apps');
        const parasDir = path.join(base, 'agy', 'paras');
        const musicDir = path.join(base, 'music');

        const [appsEntries, parasEntries, musicEntries, rootEntries] = await Promise.all([
          fs.readdir(appsDir, { withFileTypes: true }).catch(() => []),
          fs.readdir(parasDir, { withFileTypes: true }).catch(() => []),
          fs.readdir(musicDir, { recursive: true }).catch(() => []),
          fs.readdir(base, { withFileTypes: true }).catch(() => [])
        ]);

        const apps = appsEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
        const parasFiles = parasEntries.filter((e) => !e.name.startsWith('.')).map((e) => e.name);
        const musicCount = musicEntries.filter((f) => /\.(mp3|flac|wav|ogg|m4a|opus)$/i.test(String(f))).length;

        const isoFiles = [];
        for (const entry of rootEntries) {
          if (entry.isFile() && /\.iso$/i.test(entry.name)) {
            try {
              const st = await fs.stat(path.join(base, entry.name));
              isoFiles.push({
                name: entry.name,
                sizeMb: Math.round(st.size / (1024 * 1024))
              });
            } catch (_) {}
          }
        }

        let filTunnelUrl = null;
        const filLogPaths = [
          '/host-fil-logs/tunnel.json',
          '/host-fil-logs/cloudflared.log',
          '/home/kasa/apps/fil/server/logs/cloudflared.log'
        ];
        for (const p of filLogPaths) {
          try {
            const content = await fs.readFile(p, 'utf8');
            const m = content.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
            if (m && m.length > 0) {
              filTunnelUrl = m[m.length - 1];
              break;
            }
          } catch (_) {}
        }

        return {
          ok: true,
          depoPath: base,
          apps,
          musicCount,
          parasFiles,
          parasClean: parasFiles.length === 0,
          isoFiles,
          filTunnelUrl
        };
      },
      { ttlMs: 10000, force }
    );
  }

  function isTailscaleNodeOffline(tailscaleSummary, hostnameOrIp) {
    if (!tailscaleSummary || tailscaleSummary.backendState !== 'Running' || !Array.isArray(tailscaleSummary.nodes)) {
      return null;
    }
    const found = tailscaleSummary.nodes.find(
      (n) => n.hostname.toLowerCase() === hostnameOrIp.toLowerCase() || n.ip === hostnameOrIp
    );
    if (found && !found.online) {
      return found;
    }
    return null;
  }

  async function getFleetSummary({ force = false } = {}) {
    const tailscale = await collectTailscale({ force });

    const toshiOfflinePeer = isTailscaleNodeOffline(tailscale, 'toshi') || isTailscaleNodeOffline(tailscale, '100.79.246.19');
    const quasimodoOfflinePeer = isTailscaleNodeOffline(tailscale, 'quasimodo') || isTailscaleNodeOffline(tailscale, '100.108.206.20');

    const [kasa, toshi, quasimodo, containers, depo] = await Promise.all([
      cache.getOrFetch('node-kasa', collectKasa, { ttlMs: 3000, force }),
      toshiOfflinePeer
        ? attachLastKnown('toshi', {
            node: 'toshi',
            hostname: 'toshi',
            ip: '100.79.246.19',
            os: 'Linux (LXQt)',
            online: false,
            cpuPercent: 0,
            error: 'Offline on Tailscale mesh (Sleep / Powered Off)'
          })
        : cache.getOrFetch('node-toshi', collectToshi, { ttlMs: 8000, force }),
      quasimodoOfflinePeer
        ? attachLastKnown('quasimodo', {
            node: 'quasimodo',
            hostname: 'quasimodo',
            ip: '100.108.206.20',
            os: 'Windows (Dell E6430)',
            online: false,
            cpuPercent: 0,
            error: 'Offline on Tailscale mesh (Sleep / Standby)'
          })
        : cache.getOrFetch('node-quasimodo', collectQuasimodo, { ttlMs: 10000, force }),
      getDockerContainers({ force }),
      getDepoOverview({ force })
    ]);

    const runningContainers = containers.filter((c) => c.state === 'running');
    const services = KNOWN_SERVICES.map((svc) => {
      const matched = containers.find((c) => c.name === svc.container);
      const isOnline = svc.id === 'fleet-deck' ? true : Boolean(matched && matched.state === 'running');
      return {
        ...svc,
        online: isOnline,
        status: matched ? matched.status : (svc.id === 'fleet-deck' ? 'Up (Active)' : 'Stopped'),
        externalUrl: svc.id === 'fil' && depo.filTunnelUrl ? depo.filTunnelUrl : null
      };
    });

    return {
      timestamp: new Date().toISOString(),
      forced: Boolean(force),
      nodes: {
        kasa,
        toshi,
        quasimodo
      },
      history: history.getAllHistory(),
      docker: {
        runningCount: runningContainers.length,
        totalCount: containers.length,
        containers
      },
      tailscale,
      services,
      depo
    };
  }

  return {
    getFleetSummary,
    getDockerContainers,
    performDockerAction,
    getDockerContainerLogs,
    getDepoOverview,
    collectTailscale,
    captureToshiScreenshot,
    controlToshiHardware
  };
}

module.exports = {
  createFleetCollector,
  stripDockerStreamHeaders,
  probeServiceHttp,
  QUASIMODO_TELEMETRY_CMD
};
