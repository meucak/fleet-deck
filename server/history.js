'use strict';

class TelemetryHistoryRing {
  constructor(maxPoints = 30) {
    this.maxPoints = maxPoints;
    this.buffers = new Map();
  }

  record(node, metrics = {}) {
    if (!node) return;
    if (!this.buffers.has(node)) {
      this.buffers.set(node, []);
    }
    const buf = this.buffers.get(node);
    const point = {
      ts: Date.now(),
      cpuPercent: Number(metrics.cpuPercent) || 0,
      memPercent: metrics.memory ? Number(metrics.memory.percent) || 0 : 0,
      temperatureC: Number(metrics.temperatureC) || 0,
      pingMs: Number(metrics.pingMs) || 0
    };
    buf.push(point);
    if (buf.length > this.maxPoints) {
      buf.shift();
    }
  }

  getNodeHistory(node) {
    const points = (this.buffers.get(node) || []).slice();
    if (points.length === 0) {
      return {
        points: [],
        stats: { cpuMin: 0, cpuMax: 0, cpuAvg: 0, lastPingMs: 0 }
      };
    }

    const cpus = points.map((p) => p.cpuPercent);
    const cpuMin = Math.min(...cpus);
    const cpuMax = Math.max(...cpus);
    const cpuAvg = Math.round(cpus.reduce((a, b) => a + b, 0) / cpus.length);
    const lastPingMs = points[points.length - 1].pingMs || 0;

    return {
      points,
      stats: {
        cpuMin,
        cpuMax,
        cpuAvg,
        lastPingMs
      }
    };
  }

  getAllHistory() {
    const out = {};
    for (const node of ['kasa', 'toshi', 'quasimodo']) {
      out[node] = this.getNodeHistory(node);
    }
    return out;
  }
}

module.exports = { TelemetryHistoryRing };
