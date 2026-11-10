'use strict';

function parseDfLine(dfOutput) {
  if (!dfOutput || typeof dfOutput !== 'string') {
    return { totalMb: 0, usedMb: 0, availableMb: 0, percent: 0 };
  }
  const lines = dfOutput.trim().split(/\r?\n/).filter(Boolean);
  const dataLine = lines[lines.length - 1] || '';
  const match = dataLine.match(/(\d+)M\s+(\d+)M\s+(\d+)M\s+(\d+)%/);
  if (!match) {
    return { totalMb: 0, usedMb: 0, availableMb: 0, percent: 0 };
  }
  return {
    totalMb: Number(match[1]),
    usedMb: Number(match[2]),
    availableMb: Number(match[3]),
    percent: Number(match[4])
  };
}

function parseKasaMetrics(raw = {}) {
  const loadParts = String(raw.loadavg || '').trim().split(/\s+/);
  const load1 = Number(loadParts[0]) || 0;
  const load5 = Number(loadParts[1]) || 0;
  const load15 = Number(loadParts[2]) || 0;
  const cpuCores = Number(raw.cpuCores) > 0 ? Number(raw.cpuCores) : 4;
  const cpuPercent = Math.min(100, Math.max(0, Math.round((load1 / cpuCores) * 100)));

  const memMap = {};
  for (const line of String(raw.meminfo || '').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_()]+):\s+(\d+)/);
    if (m) memMap[m[1]] = Number(m[2]);
  }
  const totalKb = memMap.MemTotal || 0;
  const availKb = memMap.MemAvailable !== undefined ? memMap.MemAvailable : (memMap.MemFree || 0);
  const usedKb = Math.max(0, totalKb - availKb);
  const totalMb = Math.round(totalKb / 1024);
  const usedMb = Math.round(usedKb / 1024);
  const memPercent = totalMb > 0 ? Math.min(100, Math.round((usedMb / totalMb) * 100)) : 0;

  const swapTotalMb = Math.round((memMap.SwapTotal || 0) / 1024);
  const swapFreeMb = Math.round((memMap.SwapFree || 0) / 1024);
  const swapUsedMb = Math.max(0, swapTotalMb - swapFreeMb);

  const thermals = Array.isArray(raw.thermals) ? raw.thermals : [];
  let maxMilliC = 0;
  for (const t of thermals) {
    const val = Number(String(t).trim());
    if (!Number.isNaN(val) && val > maxMilliC) maxMilliC = val;
  }
  const temperatureC = maxMilliC > 1000 ? Math.round((maxMilliC / 100) ) / 10 : maxMilliC;

  const uptimeSeconds = Math.floor(Number(String(raw.uptime || '0').trim().split(/\s+/)[0]) || 0);
  const disk = parseDfLine(raw.dfRoot);
  const depoDisk = raw.dfDepo ? parseDfLine(raw.dfDepo) : disk;

  return {
    node: 'kasa',
    hostname: 'kasa',
    ip: '100.69.155.110',
    os: 'Debian GNU/Linux (Host)',
    online: true,
    cpuCores,
    cpuPercent,
    load: { load1, load5, load15 },
    temperatureC,
    memory: {
      totalMb,
      usedMb,
      availableMb: Math.max(0, totalMb - usedMb),
      percent: memPercent,
      swapTotalMb,
      swapUsedMb
    },
    disk,
    depoDisk,
    uptimeSeconds
  };
}

function extractSections(rawOutput) {
  const sections = {};
  let current = null;
  for (const line of String(rawOutput || '').split(/\r?\n/)) {
    const marker = line.match(/^__SECTION_([A-Z0-9_]+)__$/);
    if (marker) {
      current = marker[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(sections)) {
    out[k] = v.join('\n').trim();
  }
  return out;
}

function parseToshiMetrics(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string' || !rawOutput.trim()) {
    return {
      node: 'toshi',
      hostname: 'toshi',
      ip: '100.79.246.19',
      os: 'Linux (LXQt)',
      online: false,
      cpuPercent: 0
    };
  }

  const sec = extractSections(rawOutput);
  const batCap = Number((sec.BAT_CAP || '').split(/\s+/)[0]);
  const batPercent = !Number.isNaN(batCap) && sec.BAT_CAP ? Math.min(100, Math.max(0, batCap)) : 100;
  const batStatus = (sec.BAT_STATUS || 'Unknown').split(/\r?\n/)[0].trim();

  const rawTemp = Number((sec.TEMP || '0').split(/\s+/)[0]);
  const temperatureC = rawTemp > 1000 ? Math.round(rawTemp / 100) / 10 : rawTemp;

  const loadParts = (sec.LOAD || '').split(/\s+/);
  const load1 = Number(loadParts[0]) || 0;
  const load5 = Number(loadParts[1]) || 0;
  const load15 = Number(loadParts[2]) || 0;
  const cpuPercent = Math.min(100, Math.max(0, Math.round((load1 / 4) * 100)));

  const uptimeSeconds = Math.floor(Number((sec.UPTIME || '0').split(/\s+/)[0]) || 0);

  let totalMb = 0;
  let usedMb = 0;
  let availableMb = 0;
  for (const line of (sec.FREE || '').split(/\r?\n/)) {
    if (line.trim().startsWith('Mem:')) {
      const p = line.trim().split(/\s+/);
      totalMb = Number(p[1]) || 0;
      usedMb = Number(p[2]) || 0;
      availableMb = Number(p[6]) || Math.max(0, totalMb - usedMb);
    }
  }
  const memPercent = totalMb > 0 ? Math.min(100, Math.round((usedMb / totalMb) * 100)) : 0;

  const disk = parseDfLine(sec.DF || '');

  let wifi = { interface: 'wlp8s0', linkQuality: 0, qualityPercent: 0, signalDbm: 0 };
  for (const line of (sec.WIFI || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([a-zA-Z0-9]+):\s+\d+\s+(\d+)\.?\s+(-?\d+)\./);
    if (m) {
      const link = Number(m[2]) || 0;
      const dbm = Number(m[3]) || 0;
      wifi = {
        interface: m[1],
        linkQuality: link,
        qualityPercent: Math.min(100, Math.round((link / 70) * 100)),
        signalDbm: dbm
      };
    }
  }

  const controlCenterService = (sec.SERVICE || 'unknown').split(/\r?\n/)[0].trim() || 'unknown';

  return {
    node: 'toshi',
    hostname: 'toshi',
    ip: '100.79.246.19',
    os: 'Linux (LXQt)',
    online: true,
    cpuPercent,
    load: { load1, load5, load15 },
    temperatureC,
    battery: {
      percent: batPercent,
      status: batStatus
    },
    memory: {
      totalMb,
      usedMb,
      availableMb,
      percent: memPercent
    },
    disk,
    wifi,
    controlCenterService,
    uptimeSeconds
  };
}

function parseQuasimodoMetrics(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string' || !rawOutput.includes('=')) {
    return {
      node: 'quasimodo',
      hostname: 'quasimodo',
      ip: '100.108.206.20',
      os: 'Windows (Dell E6430)',
      online: false,
      cpuPercent: 0
    };
  }

  const kv = {};
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      kv[key] = val;
    }
  }

  const cpuPercent = Math.min(100, Math.max(0, Number(kv.LoadPercentage) || 0));
  const totalKb = Number(kv.TotalVisibleMemorySize) || 0;
  const freeKb = Number(kv.FreePhysicalMemory) || 0;
  const usedKb = Math.max(0, totalKb - freeKb);
  const totalMb = Math.round(totalKb / 1024);
  const usedMb = Math.round(usedKb / 1024);
  const memPercent = totalMb > 0 ? Math.min(100, Math.round((usedMb / totalMb) * 100)) : 0;

  const sizeBytes = Number(kv.Size) || 0;
  const freeBytes = Number(kv.FreeSpace) || 0;
  const usedBytes = Math.max(0, sizeBytes - freeBytes);
  const totalGb = Math.round((sizeBytes / (1024 ** 3)) * 10) / 10;
  const freeGb = Math.round((freeBytes / (1024 ** 3)) * 10) / 10;
  const usedGb = Math.round((usedBytes / (1024 ** 3)) * 10) / 10;
  const diskPercent = sizeBytes > 0 ? Math.min(100, Math.round((usedBytes / sizeBytes) * 100)) : 0;

  const rawCharge = Number(kv.EstimatedChargeRemaining) || 0;
  const batteryStatusCode = Number(kv.BatteryStatus) || 0;
  const acPower = batteryStatusCode === 2 || rawCharge > 100;
  const quirkNormalized = rawCharge > 100;
  const normalizedPercent = rawCharge > 100 ? 100 : Math.max(0, rawCharge);
  let batteryStatusLabel = 'Unknown';
  if (quirkNormalized) {
    batteryStatusLabel = 'AC Direct (100%)';
  } else if (acPower) {
    batteryStatusLabel = `Charging / AC (${normalizedPercent}%)`;
  } else {
    batteryStatusLabel = `Discharging (${normalizedPercent}%)`;
  }

  let uptimeSeconds = 0;
  if (kv.LastBootUpTime && kv.LastBootUpTime.length >= 14) {
    const s = kv.LastBootUpTime;
    const y = Number(s.slice(0, 4));
    const mo = Number(s.slice(4, 6)) - 1;
    const d = Number(s.slice(6, 8));
    const h = Number(s.slice(8, 10));
    const mi = Number(s.slice(10, 12));
    const se = Number(s.slice(12, 14));
    const bootMs = Date.UTC(y, mo, d, h, mi, se);
    if (!Number.isNaN(bootMs)) {
      uptimeSeconds = Math.max(0, Math.floor((Date.now() - bootMs) / 1000));
    }
  }

  return {
    node: 'quasimodo',
    hostname: 'quasimodo',
    ip: '100.108.206.20',
    os: 'Windows (Dell E6430)',
    online: true,
    cpuPercent,
    memory: {
      totalMb,
      usedMb,
      availableMb: Math.max(0, totalMb - usedMb),
      percent: memPercent
    },
    disk: {
      drive: 'C:',
      totalGb,
      usedGb,
      freeGb,
      percent: diskPercent
    },
    battery: {
      percent: normalizedPercent,
      rawCharge,
      acPower,
      quirkNormalized,
      status: batteryStatusLabel
    },
    uptimeSeconds
  };
}

function parseTailscaleStatus(rawJson = {}) {
  const nodes = [];
  if (rawJson && rawJson.Self) {
    const s = rawJson.Self;
    nodes.push({
      hostname: s.HostName || 'kasa',
      os: s.OS || 'linux',
      ip: Array.isArray(s.TailscaleIPs) ? s.TailscaleIPs[0] : '',
      online: true,
      isSelf: true,
      connectionMode: 'local',
      rxBytes: Number(s.RxBytes) || 0,
      txBytes: Number(s.TxBytes) || 0,
      lastSeen: null
    });
  }

  const peers = (rawJson && rawJson.Peer) || {};
  for (const peer of Object.values(peers)) {
    const isDirect = Boolean(peer.CurAddr);
    nodes.push({
      hostname: peer.HostName || 'unknown',
      os: peer.OS || 'unknown',
      ip: Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs[0] : '',
      online: Boolean(peer.Online),
      isSelf: false,
      connectionMode: peer.Online ? (isDirect ? 'direct' : 'relay') : 'offline',
      endpoint: peer.CurAddr || peer.Relay || '',
      rxBytes: Number(peer.RxBytes) || 0,
      txBytes: Number(peer.TxBytes) || 0,
      lastSeen: peer.LastSeen || null
    });
  }

  nodes.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.hostname.localeCompare(b.hostname);
  });

  const onlineCount = nodes.filter((n) => n.online).length;
  return {
    backendState: rawJson.BackendState || 'Unknown',
    onlineCount,
    totalCount: nodes.length,
    nodes
  };
}

const DANGEROUS_PATTERNS = [
  { regex: /:\s*\(\s*\)\s*\{/, reason: 'Fork bomb detected and blocked' },
  { regex: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--no-preserve-root|\s+-[a-zA-Z]+)*\s+\/(\s|$|\*)/i, reason: 'Root filesystem deletion blocked' },
  { regex: /--no-preserve-root/i, reason: 'Root wipe flag blocked' },
  { regex: /\bdd\s+.*\bof=\/dev\/(sd|nvme|vd|mmcblk|loop)/i, reason: 'Raw block device overwrite blocked' },
  { regex: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: 'Filesystem formatting blocked' },
  { regex: /\bformat\s+[a-z]:/i, reason: 'Windows drive formatting blocked' },
  { regex: /(^|[;&|]\s*)yes(\s|$|>)/i, reason: 'Unbounded stream generator (yes) blocked' },
  { regex: /\b(shutdown|poweroff|reboot|halt|init\s+0|init\s+6)\b/i, reason: 'Use dedicated confirmed power actions instead of raw shell shutdown/reboot' }
];

function validateCommandSafety(command) {
  if (!command || typeof command !== 'string' || !command.trim()) {
    return { safe: false, reason: 'Command cannot be empty' };
  }
  const trimmed = command.trim();
  if (trimmed.length > 500) {
    return { safe: false, reason: 'Command exceeds maximum safe length (500 chars)' };
  }
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.regex.test(trimmed)) {
      return { safe: false, reason: rule.reason };
    }
  }
  return { safe: true };
}

module.exports = {
  parseKasaMetrics,
  parseToshiMetrics,
  parseQuasimodoMetrics,
  parseTailscaleStatus,
  validateCommandSafety
};
