const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseKasaMetrics,
  parseToshiMetrics,
  parseQuasimodoMetrics,
  parseTailscaleStatus,
  validateCommandSafety
} = require('../server/parsers');

test('parseKasaMetrics parses loadavg, meminfo, uptime, thermals, and disk usage accurately', () => {
  const raw = {
    loadavg: '0.42 0.58 0.91 2/412 9812\n',
    meminfo: [
      'MemTotal:        8120320 kB',
      'MemFree:         1024000 kB',
      'MemAvailable:    6144000 kB',
      'SwapTotal:       8388608 kB',
      'SwapFree:        8380000 kB'
    ].join('\n'),
    uptime: '14450.32 52100.10\n',
    thermals: ['27800', '29800', '34000'],
    dfRoot: 'Filesystem     1M-blocks   Used Available Use% Mounted on\n/dev/sda2        459384M 13998M   421979M   4% /\n',
    dfDepo: 'Filesystem     1M-blocks   Used Available Use% Mounted on\n/dev/sda2        459384M 13998M   421979M   4% /home/kasa/Depo\n',
    cpuCores: 4
  };

  const res = parseKasaMetrics(raw);
  assert.equal(res.online, true);
  assert.equal(res.load.load1, 0.42);
  assert.equal(res.load.load5, 0.58);
  assert.equal(res.load.load15, 0.91);
  assert.equal(res.cpuPercent, 11); // round(0.42 / 4 * 100)
  assert.equal(res.temperatureC, 34.0); // max of thermal zones
  assert.equal(res.memory.totalMb, 7930);
  assert.equal(res.memory.usedMb, 1930);
  assert.equal(res.memory.percent, 24);
  assert.equal(res.disk.totalMb, 459384);
  assert.equal(res.disk.usedMb, 13998);
  assert.equal(res.disk.percent, 4);
  assert.equal(res.uptimeSeconds, 14450);
});

test('parseToshiMetrics parses battery, temp, load, memory, disk, wireless link quality, and control-center status', () => {
  const sample = [
    '__SECTION_BAT_CAP__',
    '88',
    '__SECTION_BAT_STATUS__',
    'Discharging',
    '__SECTION_TEMP__',
    '59000',
    '__SECTION_LOAD__',
    '0.39 0.54 1.00 1/491 3540',
    '__SECTION_UPTIME__',
    '6420.50 18000.00',
    '__SECTION_FREE__',
    '               total        used        free      shared  buff/cache   available',
    'Mem:            7929        1263        1878          22        5076        6666',
    'Swap:           8171           1        8170',
    '__SECTION_DF__',
    '/dev/sda1      460311M 58333M 378523M       14% /',
    '__SECTION_WIFI__',
    'Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE',
    ' face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22',
    'wlp8s0: 0000   58.  -52.  -256        0      0      0      0   2039        0',
    '__SECTION_SERVICE__',
    'active'
  ].join('\n');

  const res = parseToshiMetrics(sample);
  assert.equal(res.online, true);
  assert.equal(res.battery.percent, 88);
  assert.equal(res.battery.status, 'Discharging');
  assert.equal(res.temperatureC, 59.0);
  assert.equal(res.load.load1, 0.39);
  assert.equal(res.memory.totalMb, 7929);
  assert.equal(res.memory.usedMb, 1263);
  assert.equal(res.memory.percent, 16);
  assert.equal(res.disk.totalMb, 460311);
  assert.equal(res.disk.usedMb, 58333);
  assert.equal(res.disk.percent, 14);
  assert.equal(res.wifi.interface, 'wlp8s0');
  assert.equal(res.wifi.signalDbm, -52);
  assert.equal(res.wifi.qualityPercent, 83); // round(58/70*100)
  assert.equal(res.controlCenterService, 'active');
  assert.equal(res.uptimeSeconds, 6420);
});

test('parseQuasimodoMetrics normalizes Dell E6430 WMI battery quirk (>100 -> 100, acPower: true)', () => {
  const sample = [
    'LoadPercentage=5',
    'FreePhysicalMemory=4396604',
    'TotalVisibleMemorySize=8256664',
    'FreeSpace=39618351104',
    'Size=239358746624',
    'BatteryStatus=2',
    'EstimatedChargeRemaining=563',
    'LastBootUpTime=20261107203245.328052+180'
  ].join('\r\n\r\n');

  const res = parseQuasimodoMetrics(sample);
  assert.equal(res.online, true);
  assert.equal(res.cpuPercent, 5);
  assert.equal(res.memory.totalMb, 8063);
  assert.equal(res.memory.usedMb, 3770);
  assert.equal(res.memory.percent, 47);
  assert.equal(res.disk.totalGb, 222.9);
  assert.equal(res.disk.freeGb, 36.9);
  assert.equal(res.disk.percent, 83);
  assert.equal(res.battery.percent, 100);
  assert.equal(res.battery.rawCharge, 563);
  assert.equal(res.battery.acPower, true);
  assert.equal(res.battery.quirkNormalized, true);
  assert.equal(res.battery.status, 'AC Direct (100%)');
});

test('parseQuasimodoMetrics handles empty or unreachable output gracefully', () => {
  const res = parseQuasimodoMetrics('');
  assert.equal(res.online, false);
  assert.equal(res.cpuPercent, 0);
});

test('parseTailscaleStatus normalizes self and peers sorted with online nodes first', () => {
  const raw = {
    BackendState: 'Running',
    Self: {
      HostName: 'kasa',
      DNSName: 'kasa.tailnet.ts.net.',
      OS: 'linux',
      TailscaleIPs: ['100.69.155.110'],
      Online: true,
      RxBytes: 1000,
      TxBytes: 2000
    },
    Peer: {
      node1: {
        HostName: 'toshi',
        OS: 'linux',
        TailscaleIPs: ['100.79.246.19'],
        Online: true,
        CurAddr: '178.244.193.15:20136',
        RxBytes: 1962304,
        TxBytes: 2496664
      },
      node2: {
        HostName: 'kill-tablet',
        OS: 'android',
        TailscaleIPs: ['100.69.75.119'],
        Online: false,
        LastSeen: '2026-11-05T12:00:00Z',
        RxBytes: 0,
        TxBytes: 0
      }
    }
  };

  const summary = parseTailscaleStatus(raw);
  assert.equal(summary.backendState, 'Running');
  assert.equal(summary.onlineCount, 2);
  assert.equal(summary.totalCount, 3);
  assert.equal(summary.nodes[0].hostname, 'kasa');
  assert.equal(summary.nodes[1].hostname, 'toshi');
  assert.equal(summary.nodes[1].connectionMode, 'direct');
  assert.equal(summary.nodes[2].hostname, 'kill-tablet');
  assert.equal(summary.nodes[2].online, false);
});

test('validateCommandSafety blocks destructive, fork-bomb, and system-halting commands while allowing diagnostics', () => {
  assert.equal(validateCommandSafety(':(){ :|:& };:').safe, false);
  assert.equal(validateCommandSafety('rm -rf /').safe, false);
  assert.equal(validateCommandSafety('sudo rm -rf --no-preserve-root /').safe, false);
  assert.equal(validateCommandSafety('dd if=/dev/zero of=/dev/sda bs=1M').safe, false);
  assert.equal(validateCommandSafety('mkfs.ext4 /dev/sda1').safe, false);
  assert.equal(validateCommandSafety('format c: /q').safe, false);
  assert.equal(validateCommandSafety('yes > /dev/null').safe, false);
  assert.equal(validateCommandSafety('').safe, false);

  assert.equal(validateCommandSafety('uptime && df -h').safe, true);
  assert.equal(validateCommandSafety('docker ps --format "table {{.Names}}\\t{{.Status}}"').safe, true);
  assert.equal(validateCommandSafety('wmic cpu get loadpercentage /value').safe, true);
});
