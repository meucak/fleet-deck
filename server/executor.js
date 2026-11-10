'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');

const MAX_BUFFER_BYTES = 512 * 1024; // 512 KB cap per command output

function runCommand(cmd, args = [], options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const startMs = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(cmd, args, {
        cwd: options.cwd || process.cwd(),
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({
        ok: false,
        stdout: '',
        stderr: err.message,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - startMs
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch (_) {
        // ignore kill error
      }
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_BUFFER_BYTES) {
          stdout += chunk.toString('utf8');
        }
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_BUFFER_BYTES) {
          stderr += chunk.toString('utf8');
        }
      });
    }

    const finish = (exitCode, errorMsg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (errorMsg && !stderr) {
        stderr = errorMsg;
      }
      resolve({
        ok: !timedOut && exitCode === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
        timedOut,
        durationMs: Date.now() - startMs
      });
    };

    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code, null));
  });
}

function sshExec(host, remoteCommand, options = {}) {
  const timeoutMs = options.timeoutMs || 5000;
  const sshKeyPath = options.identityFile || process.env.SSH_IDENTITY_FILE || '/root/.ssh/id_ed25519';
  const args = [
    '-o', 'LogLevel=ERROR',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=4',
    '-o', 'ServerAliveInterval=2',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPath=/tmp/ssh-mux-%C',
    '-o', 'ControlPersist=120'
  ];
  if (options.useIdentityFile !== false && sshKeyPath) {
    args.push('-i', sshKeyPath);
  }
  args.push(host, remoteCommand);
  return runCommand('ssh', args, { timeoutMs });
}

function unixSocketHttpRequest(socketPath, hostHeader, method, path, options = {}) {
  const timeoutMs = options.timeoutMs || 3500;
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: {
          Host: hostHeader,
          Accept: 'application/json'
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on('data', (chunk) => {
          if (total < MAX_BUFFER_BYTES) {
            chunks.push(chunk);
            total += chunk.length;
          }
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const raw = buf.toString('utf8');
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (_) {
            data = raw;
          }
          done({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            statusCode: res.statusCode,
            data,
            raw,
            buffer: buf
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Socket request timed out'));
    });

    req.on('error', (err) => {
      done({
        ok: false,
        statusCode: 0,
        data: null,
        raw: '',
        error: err.message
      });
    });

    req.end();
  });
}

function dockerSocketRequest(method, path, options = {}) {
  const socketPath = options.socketPath || process.env.DOCKER_SOCK_PATH || '/var/run/docker.sock';
  return unixSocketHttpRequest(socketPath, 'localhost', method, path, options);
}

function tailscaleSocketRequest(path = '/localapi/v0/status', options = {}) {
  const socketPath = options.socketPath || process.env.TAILSCALE_SOCK_PATH || '/var/run/tailscale/tailscaled.sock';
  return unixSocketHttpRequest(socketPath, 'local-tailscaled.sock', 'GET', path, options);
}

module.exports = {
  runCommand,
  sshExec,
  dockerSocketRequest,
  tailscaleSocketRequest
};
