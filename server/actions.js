'use strict';

const defaultExecutor = require('./executor');
const { validateCommandSafety } = require('./parsers');

const MAX_AUDIT_ENTRIES = 50;
const auditLog = [];

const NODE_SSH_TARGETS = {
  toshi: process.env.TOSHI_SSH_TARGET || 'toshi@100.79.246.19',
  quasimodo: process.env.QUASIMODO_SSH_TARGET || 'semsettin@100.108.206.20'
};

const ACTIONS_CATALOG = [
  // Toshi (Linux Laptop)
  {
    id: 'toshi-toggle-control-center',
    node: 'toshi',
    label: 'Toggle Control Center',
    description: 'Opens or closes the Catppuccin PyQt6 Control Center popup on Toshi (:0).',
    category: 'Workspace',
    destructive: false,
    command: 'DISPLAY=:0 /home/toshi/.local/bin/toshi-control-center --toggle && echo "Control Center toggled."'
  },
  {
    id: 'toshi-restart-control-service',
    node: 'toshi',
    label: 'Restart Control Center Service',
    description: 'Restarts toshi-control-center.service via systemd user session.',
    category: 'System',
    destructive: false,
    command: 'systemctl --user restart toshi-control-center.service && systemctl --user is-active toshi-control-center.service'
  },
  {
    id: 'toshi-take-screenshot',
    node: 'toshi',
    label: 'Capture Desktop Screenshot',
    description: 'Non-interactively captures Toshi Display :0 via maim -u and copies directly to Toshi clipboard.',
    category: 'Utility',
    destructive: false,
    command: 'DISPLAY=:0 XAUTHORITY=/home/toshi/.Xauthority maim -u /tmp/toshi_fleet_snap.png && DISPLAY=:0 XAUTHORITY=/home/toshi/.Xauthority xclip -selection clipboard -t image/png -i /tmp/toshi_fleet_snap.png >/dev/null 2>&1 && echo "Full desktop screenshot captured and copied to Toshi clipboard (/tmp/toshi_fleet_snap.png)."'
  },
  {
    id: 'toshi-launch-gta',
    node: 'toshi',
    label: 'Launch GTA: San Andreas',
    description: 'Starts GTA: San Andreas on Toshi Display :0 in background.',
    category: 'Gaming',
    destructive: false,
    command: 'DISPLAY=:0 nohup /home/toshi/.local/bin/gta-sa >/dev/null 2>&1 & echo "GTA: San Andreas launched on Toshi (PID $!)."'
  },
  {
    id: 'toshi-launch-warband',
    node: 'toshi',
    label: 'Launch M&B: Warband',
    description: 'Starts Mount & Blade: Warband on Toshi Display :0 in background.',
    category: 'Gaming',
    destructive: false,
    command: 'DISPLAY=:0 nohup /home/toshi/.local/bin/warband >/dev/null 2>&1 & echo "Mount & Blade: Warband launched on Toshi (PID $!)."'
  },
  {
    id: 'toshi-launch-cs-bomb',
    node: 'toshi',
    label: 'Trigger C4 Bomb Widget',
    description: 'Launches the tactical retro Counter-Strike C4 desktop widget on Toshi.',
    category: 'Gaming',
    destructive: false,
    command: 'DISPLAY=:0 nohup /home/toshi/.local/bin/cs-bomb >/dev/null 2>&1 & echo "C4 widget triggered on Toshi."'
  },
  {
    id: 'toshi-start-barrier',
    node: 'toshi',
    label: 'Start Barrier KVM Client',
    description: 'Starts Barrier mouse/keyboard sharing client on Toshi.',
    category: 'Workspace',
    destructive: false,
    command: 'DISPLAY=:0 nohup /home/toshi/.local/bin/barrier-start >/dev/null 2>&1 & echo "Barrier KVM started on Toshi."'
  },
  {
    id: 'toshi-suspend',
    node: 'toshi',
    label: 'Suspend Toshi to RAM',
    description: 'Puts Toshi laptop into low-power sleep state (systemctl suspend).',
    category: 'Power',
    destructive: true,
    confirmText: 'Suspend Toshi (100.79.246.19) to sleep mode? Active SSH connections will disconnect until wake.',
    command: 'sudo systemctl suspend'
  },

  // Quasimodo (Dell E6430 Windows)
  {
    id: 'quasimodo-gdrive-apps-list',
    node: 'quasimodo',
    label: 'List Google Drive Apps',
    description: 'Queries gdrive:apps directory via C:\\rclone\\rclone.exe on Quasimodo.',
    category: 'Cloud & Sync',
    destructive: false,
    command: 'C:\\rclone\\rclone.exe lsd gdrive:apps'
  },
  {
    id: 'quasimodo-network-summary',
    node: 'quasimodo',
    label: 'Inspect Windows Network & Tailscale',
    description: 'Lists active IPv4 interfaces and Tailscale tunnel address on Quasimodo.',
    category: 'Diagnostics',
    destructive: false,
    command: 'ipconfig | findstr /i "IPv4 Subnet Default"'
  },
  {
    id: 'quasimodo-top-processes',
    node: 'quasimodo',
    label: 'Top Memory Processes',
    description: 'Lists high-memory processes (>50MB) currently running on Quasimodo.',
    category: 'Diagnostics',
    destructive: false,
    command: 'tasklist /fi "MEMUSAGE gt 50000"'
  },
  {
    id: 'quasimodo-sleep',
    node: 'quasimodo',
    label: 'Sleep Quasimodo (Standby)',
    description: 'Puts Dell Latitude E6430 (Quasimodo) into Windows standby/sleep mode.',
    category: 'Power',
    destructive: true,
    confirmText: 'Put Quasimodo (Dell E6430 - 100.108.206.20) into Windows sleep mode? Remote access will pause until woken.',
    command: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0'
  },

  // Kasa (Debian Central Server)
  {
    id: 'kasa-depo-audit',
    node: 'kasa',
    label: 'Audit Depo & Paras Inbox',
    description: 'Reports disk usage of /home/kasa/Depo, app count, music tracks, and paras inbox files.',
    category: 'Storage',
    destructive: false,
    localArgs: ['sh', ['-c', 'echo "=== DEPO APPS ===" && ls -1 /host-depo/agy/apps 2>/dev/null || ls -1 /home/kasa/Depo/agy/apps 2>/dev/null; echo "=== PARAS INBOX ===" && (ls -la /host-depo/agy/paras 2>/dev/null || ls -la /home/kasa/Depo/agy/paras 2>/dev/null)'] ]
  },
  {
    id: 'kasa-clean-temp',
    node: 'kasa',
    label: 'Flush Container Temp Logs',
    description: 'Clears stale temporary logs inside Fleet Deck runtime cache.',
    category: 'Maintenance',
    destructive: true,
    confirmText: 'Clear temporary diagnostic cache and reset action audit history on Fleet Deck?',
    localArgs: ['sh', ['-c', 'echo "Temporary diagnostic cache flushed."']]
  }
];

function recordAudit(entry) {
  auditLog.unshift({
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...entry
  });
  if (auditLog.length > MAX_AUDIT_ENTRIES) {
    auditLog.length = MAX_AUDIT_ENTRIES;
  }
}

function getActionsCatalog(options = {}) {
  return ACTIONS_CATALOG.map((a) => {
    const item = {
      id: a.id,
      node: a.node,
      label: a.label,
      description: a.description,
      category: a.category,
      destructive: Boolean(a.destructive),
      confirmText: a.confirmText || null
    };
    if (options.includeInternalCommand) {
      item.command = a.command || null;
    }
    return item;
  });
}

async function executeAction(actionId, deps = {}) {
  const action = ACTIONS_CATALOG.find((a) => a.id === actionId);
  if (!action) {
    return {
      ok: false,
      actionId,
      error: `Unknown action ID: ${actionId}`
    };
  }

  const runCommand = deps.runCommand || defaultExecutor.runCommand;
  const sshExec = deps.sshExec || defaultExecutor.sshExec;

  let execRes;
  if (action.node === 'kasa' && action.localArgs) {
    const [cmd, args] = action.localArgs;
    execRes = await runCommand(cmd, args, { timeoutMs: 8000 });
  } else {
    const target = NODE_SSH_TARGETS[action.node];
    if (!target) {
      return {
        ok: false,
        actionId,
        error: `No SSH target configured for node: ${action.node}`
      };
    }
    execRes = await sshExec(target, action.command, { timeoutMs: 8000 });
  }

  const result = {
    ok: execRes.ok,
    actionId: action.id,
    label: action.label,
    node: action.node,
    stdout: execRes.stdout,
    stderr: execRes.stderr,
    exitCode: execRes.exitCode,
    timedOut: execRes.timedOut,
    durationMs: execRes.durationMs,
    error: execRes.ok ? null : (execRes.stderr || (execRes.timedOut ? 'Command timed out (8s limit)' : 'Action returned non-zero exit code'))
  };

  recordAudit(result);
  return result;
}

async function executeAdHocCommand(node, command, deps = {}) {
  const validNodes = ['kasa', 'toshi', 'quasimodo'];
  if (!validNodes.includes(node)) {
    return {
      ok: false,
      node,
      command,
      error: `Invalid target node "${node}". Choose kasa, toshi, or quasimodo.`
    };
  }

  const safety = validateCommandSafety(command);
  if (!safety.safe) {
    const rejected = {
      ok: false,
      actionId: 'adhoc-blocked',
      label: `Blocked Command (${node})`,
      node,
      command,
      stdout: '',
      stderr: safety.reason,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      error: `Command blocked by safety guardrail: ${safety.reason}`
    };
    recordAudit(rejected);
    return rejected;
  }

  const runCommand = deps.runCommand || defaultExecutor.runCommand;
  const sshExec = deps.sshExec || defaultExecutor.sshExec;

  let execRes;
  if (node === 'kasa') {
    execRes = await runCommand('sh', ['-c', command], { timeoutMs: 8000 });
  } else {
    const target = NODE_SSH_TARGETS[node];
    execRes = await sshExec(target, command, { timeoutMs: 8000 });
  }

  const result = {
    ok: execRes.ok,
    actionId: 'adhoc-terminal',
    label: `Terminal (${node}): ${command.slice(0, 48)}`,
    node,
    command,
    stdout: execRes.stdout,
    stderr: execRes.stderr,
    exitCode: execRes.exitCode,
    timedOut: execRes.timedOut,
    durationMs: execRes.durationMs,
    error: execRes.ok ? null : (execRes.stderr || (execRes.timedOut ? 'Command timed out (8s limit)' : `Exited with code ${execRes.exitCode}`))
  };

  recordAudit(result);
  return result;
}

function getAuditLog() {
  return auditLog.slice();
}

function clearAuditLog() {
  auditLog.length = 0;
}

module.exports = {
  getActionsCatalog,
  executeAction,
  executeAdHocCommand,
  getAuditLog,
  clearAuditLog
};
