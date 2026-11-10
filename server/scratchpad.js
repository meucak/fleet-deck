'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const defaultExecutor = require('./executor');

const NODE_SSH_TARGETS = {
  toshi: process.env.TOSHI_SSH_TARGET || 'toshi@100.79.246.19',
  quasimodo: process.env.QUASIMODO_SSH_TARGET || 'semsettin@100.108.206.20'
};

function validateDispatchUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, error: 'URL is required' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > 1024) {
    return { ok: false, error: 'URL exceeds maximum length' };
  }
  if (/[\r\n"'`$;&|<>]/.test(trimmed)) {
    return { ok: false, error: 'URL contains forbidden shell metacharacters' };
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    return { ok: false, error: 'Invalid URL format' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// URLs are allowed' };
  }
  return { ok: true, url: parsed.toString() };
}

function defaultSshStdinExec(host, remoteCommand, stdinText, options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const sshKeyPath = options.identityFile || process.env.SSH_IDENTITY_FILE || '/root/.ssh/id_ed25519';
  const startMs = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const args = [
      '-o', 'LogLevel=ERROR',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=3',
      '-o', 'ServerAliveInterval=2',
      '-i', sshKeyPath,
      host,
      remoteCommand
    ];

    let child;
    try {
      child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, error: err.message, durationMs: Date.now() - startMs });
      return;
    }

    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: 'Clipboard SSH timed out', durationMs: Date.now() - startMs });
      }
    }, timeoutMs);

    child.stderr.on('data', (c) => {
      if (stderr.length < 16384) stderr += c.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, durationMs: Date.now() - startMs });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        error: code === 0 ? null : (stderr.trim() || `SSH exited with code ${code}`),
        durationMs: Date.now() - startMs
      });
    });

    try {
      child.stdin.write(String(stdinText ?? ''), 'utf8');
      child.stdin.end();
    } catch (_) {}
  });
}

function createScratchpadService(deps = {}) {
  const storagePath = deps.storagePath || process.env.SCRATCHPAD_PATH || path.join(__dirname, 'data', 'scratchpad.json');
  const sshStdinExec = deps.sshStdinExec || defaultSshStdinExec;
  const sshExec = deps.sshExec || defaultExecutor.sshExec;

  let memoryState = {
    text: 'Fleet Deck Ortak Not & Pano Alanı — IP: http://100.69.155.110:8091',
    updatedAt: new Date().toISOString()
  };
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await fs.readFile(storagePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.text === 'string') {
        memoryState = parsed;
      }
    } catch (_) {}
  }

  async function getNote() {
    await ensureLoaded();
    return { ...memoryState };
  }

  async function saveNote(text) {
    const cleanText = String(text ?? '').slice(0, 16384);
    memoryState = {
      text: cleanText,
      updatedAt: new Date().toISOString()
    };
    try {
      await fs.mkdir(path.dirname(storagePath), { recursive: true });
      await fs.writeFile(storagePath, JSON.stringify(memoryState, null, 2), 'utf8');
    } catch (_) {}
    return { ...memoryState };
  }

  async function pushClipboard(node, text) {
    const content = String(text ?? '');
    if (!content) {
      return { ok: false, error: 'Clipboard text cannot be empty' };
    }
    if (content.length > 32768) {
      return { ok: false, error: 'Clipboard text exceeds 32 KB limit' };
    }

    if (node === 'toshi') {
      const res = await sshStdinExec(
        NODE_SSH_TARGETS.toshi,
        'DISPLAY=:0 XAUTHORITY=/home/toshi/.Xauthority xclip -selection clipboard -i >/dev/null 2>&1',
        content
      );
      return { ...res, node: 'toshi', length: content.length };
    }

    if (node === 'quasimodo') {
      const res = await sshStdinExec(
        NODE_SSH_TARGETS.quasimodo,
        'clip',
        content
      );
      return { ...res, node: 'quasimodo', length: content.length };
    }

    return { ok: false, error: `Unsupported clipboard target node: ${node}` };
  }

  async function openUrlOnNode(node, rawUrl) {
    const check = validateDispatchUrl(rawUrl);
    if (!check.ok) {
      return { ok: false, error: check.error };
    }
    const safeUrl = check.url;

    if (node === 'toshi') {
      const res = await sshExec(
        NODE_SSH_TARGETS.toshi,
        `DISPLAY=:0 XAUTHORITY=/home/toshi/.Xauthority nohup xdg-open '${safeUrl}' >/dev/null 2>&1 & echo "Opened on Toshi"`
      );
      return { ok: res.ok, node: 'toshi', url: safeUrl, error: res.ok ? null : res.stderr };
    }

    if (node === 'quasimodo') {
      const res = await sshExec(
        NODE_SSH_TARGETS.quasimodo,
        `cmd /c start "" "${safeUrl}"`
      );
      return { ok: res.ok, node: 'quasimodo', url: safeUrl, error: res.ok ? null : res.stderr };
    }

    return { ok: false, error: `Unsupported URL target node: ${node}` };
  }

  return {
    getNote,
    saveNote,
    pushClipboard,
    openUrlOnNode
  };
}

module.exports = {
  validateDispatchUrl,
  createScratchpadService
};
