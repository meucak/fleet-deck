# Fleet Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy Fleet Deck, a crash-proof, zero-cloud Apple HIG multi-machine Mission Control dashboard in Docker on Kasa (`:8091`) managing Kasa, Toshi, Quasimodo, Docker containers, Tailscale peers, and `/home/kasa/Depo`.

**Architecture:** Node.js HTTP + WebSocket (`ws`) backend with pure telemetry parsers, single-flight `CoalescingCache` to prevent SSH storms, native Unix socket clients for `/var/run/docker.sock` and `/var/run/tailscale/tailscaled.sock`, curated cross-machine SSH action dispatcher with anti-crash guardrails, and an accessible Apple HIG responsive web/PWA frontend.

**Tech Stack:** Node.js 20 (`node:http`, `node:child_process`, `node:test`, `ws`), HTML5/CSS3 (Apple HIG 8pt grid, adaptive light/dark theme, tabular numerals), Docker & Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-10-fleet-deck-design.md`

## Global Constraints

- Port `8091` (`PORT=8091`).
- Docker resource bounds: `mem_limit: 256m`, `cpus: 0.50`.
- Hard SSH and subprocess timeouts: `ConnectTimeout=3`, `ServerAliveInterval=2`, process timeout `5000ms` (telemetry) / `8000ms` (actions).
- Single-flight request coalescing for all remote polls so concurrent requests never spawn parallel SSH storms.
- Apple HIG compliance: 8pt spacing grid, minimum `44x44px` touch targets, adaptive Light/Dark themes, no generic AI slop (`blur-3xl` neon blobs or `Inter`), status always conveyed by icon + label + color, confirmation dialogs required for destructive/power actions.

## Review Focus

1. **Dell Latitude E6430 WMI Battery Quirk (`EstimatedChargeRemaining=563`):** `parseQuasimodoMetrics` must normalize values `> 100` to `100` and mark `acPower: true` and `quirkNormalized: true` instead of breaking progress bars or displaying `563%`.
2. **Concurrent Refresh Stampede ("PC Çökmesin" Protection):** When 25 requests hit `/api/fleet/summary?force=true` simultaneously, `CoalescingCache` must coalesce all 25 calls into a single in-flight fetch per node rather than spawning 25 concurrent SSH processes.
3. **Unreachable / Offline Remote Host Timeout:** When Toshi or Quasimodo is offline or SSH times out, `collector` must gracefully return `online: false` with cached/fallback metadata within 5 seconds without throwing unhandled rejections or blocking Kasa's telemetry.
4. **Catastrophic Ad-Hoc Command Injection:** `validateCommandSafety` must block fork bombs (`:(){:|:&};:`), root filesystem wipes (`rm -rf /`), raw disk overwrites (`dd if=/dev/zero of=/dev/sda`), and unbounded loops (`yes`) before any subprocess is spawned.
5. **Self-Stop Container Lockout:** Attempting to `stop` the `fleet-deck` container itself via `/api/docker/containers/:id/action` must be rejected with HTTP `400` and a clear protective message so the user cannot accidentally kill the mission control UI from inside itself (while allowing `restart`).

---

### Task 1: Telemetry Parsers, Dell E6430 Normalizer & Command Safety Guardrail

**Files:**
- Create: `package.json`
- Create: `server/parsers.js`
- Test: `tests/parsers.test.js`

**Interfaces:**
- Produces:
  - `parseKasaMetrics(raw: { loadavg: string, meminfo: string, uptime: string, thermals: string[], dfRoot: string, dfDepo: string }): KasaMetrics`
  - `parseToshiMetrics(rawOutput: string): ToshiMetrics`
  - `parseQuasimodoMetrics(rawOutput: string): QuasimodoMetrics`
  - `parseTailscaleStatus(rawJson: object): TailscaleSummary`
  - `validateCommandSafety(command: string): { safe: boolean, reason?: string }`

- [ ] **Step 1: Write failing tests in `tests/parsers.test.js`**
  Test `parseKasaMetrics`, `parseToshiMetrics` (battery, temp, load, mem, disk, wireless `wlp8s0`, service status), `parseQuasimodoMetrics` (including `EstimatedChargeRemaining=563` normalization and offline/empty handling), `parseTailscaleStatus`, and `validateCommandSafety` (blocking fork bomb, `rm -rf /`, `mkfs`, `format c:`, allowing safe commands like `uptime`, `df -h`).
- [ ] **Step 2: Run `node --test tests/parsers.test.js` to verify RED**
- [ ] **Step 3: Implement `server/parsers.js`**
- [ ] **Step 4: Run `node --test tests/parsers.test.js` to verify GREEN**
- [ ] **Step 5: Commit Task 1**

---

### Task 2: Single-Flight Coalescing Cache & Safe Subprocess/Socket Executor

**Files:**
- Create: `server/coalesce.js`
- Create: `server/executor.js`
- Test: `tests/coalesce-executor.test.js`

**Interfaces:**
- Produces:
  - `class CoalescingCache { constructor(defaultTtlMs?: number); getOrFetch(key: string, fetcher: () => Promise<any>, options?: { ttlMs?: number, force?: boolean }): Promise<any>; invalidate(key: string): void; getStats(): object }`
  - `runCommand(cmd: string, args: string[], options?: { timeoutMs?: number, cwd?: string, env?: object }): Promise<{ ok: boolean, stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, durationMs: number }>`
  - `sshExec(host: string, remoteCommand: string, options?: { timeoutMs?: number }): Promise<{ ok: boolean, stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, durationMs: number }>`
  - `dockerSocketRequest(method: string, path: string, options?: { socketPath?: string, timeoutMs?: number }): Promise<{ statusCode: number, data: any, raw: string }>`
  - `tailscaleSocketRequest(path?: string, options?: { socketPath?: string, timeoutMs?: number }): Promise<{ statusCode: number, data: any }>`

- [ ] **Step 1: Write failing tests in `tests/coalesce-executor.test.js`**
  Test that 25 simultaneous `getOrFetch('toshi', fn, { force: true })` calls invoke `fn` exactly once; test TTL caching; test `runCommand` hard timeout kills slow processes and sets `timedOut: true`; test socket request error handling when socket is missing.
- [ ] **Step 2: Run `node --test tests/coalesce-executor.test.js` to verify RED**
- [ ] **Step 3: Implement `server/coalesce.js` and `server/executor.js`**
- [ ] **Step 4: Run `node --test tests/coalesce-executor.test.js` to verify GREEN**
- [ ] **Step 5: Commit Task 2**

---

### Task 3: Action Registry, Cross-Machine Dispatcher & Bounded Audit Log

**Files:**
- Create: `server/actions.js`
- Test: `tests/actions.test.js`

**Interfaces:**
- Consumes: `runCommand`, `sshExec` from `server/executor.js`, `validateCommandSafety` from `server/parsers.js`
- Produces:
  - `getActionsCatalog(): ActionDefinition[]`
  - `executeAction(actionId: string, deps?: { runCommand?, sshExec? }): Promise<ActionResult>`
  - `executeAdHocCommand(node: 'kasa'|'toshi'|'quasimodo', command: string, deps?: { runCommand?, sshExec? }): Promise<ActionResult>`
  - `getAuditLog(): AuditEntry[]`

- [ ] **Step 1: Write failing tests in `tests/actions.test.js`**
  Verify catalog contains actions for `kasa`, `toshi`, and `quasimodo`, destructive actions have `destructive: true` and `confirmText`, unknown action IDs return `{ ok: false }`, ad-hoc command runner enforces `validateCommandSafety`, and audit log stays bounded to 50 entries.
- [ ] **Step 2: Run `node --test tests/actions.test.js` to verify RED**
- [ ] **Step 3: Implement `server/actions.js`**
- [ ] **Step 4: Run `node --test tests/actions.test.js` to verify GREEN**
- [ ] **Step 5: Commit Task 3**

---

### Task 4: Fleet Telemetry Collector & HTTP/WebSocket Server

**Files:**
- Create: `server/collector.js`
- Create: `server/index.js`
- Test: `tests/server-api.test.js`

**Interfaces:**
- Consumes: `server/parsers.js`, `server/coalesce.js`, `server/executor.js`, `server/actions.js`
- Produces:
  - `createFleetCollector(deps?: object)`
  - `createFleetServer(options?: { port?: number, collector?: object, actions?: object })`

- [ ] **Step 1: Write failing API tests in `tests/server-api.test.js`**
  Test `GET /api/health`, `GET /api/fleet/summary`, `GET /api/docker/containers`, `POST /api/docker/containers/:id/action` (including self-stop protection for `fleet-deck` returning HTTP 400), `GET /api/docker/containers/:id/logs`, `GET /api/actions`, `POST /api/actions/:id/run`, `POST /api/terminal/exec` (blocking unsafe command with HTTP 400), and `GET /api/depo/overview`.
- [ ] **Step 2: Run `node --test tests/server-api.test.js` to verify RED**
- [ ] **Step 3: Implement `server/collector.js` and `server/index.js`**
- [ ] **Step 4: Run `node --test tests/server-api.test.js` to verify GREEN**
- [ ] **Step 5: Commit Task 4**

---

### Task 5: Apple HIG Frontend, Accessibility, PWA & UI Verification

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/app.js`
- Create: `public/manifest.json`
- Create: `public/sw.js`
- Create: `public/icons/icon.svg`
- Test: `tests/ui-hig.test.js`

**Interfaces:**
- Consumes: REST endpoints `/api/fleet/summary`, `/api/docker/containers`, `/api/actions`, `/api/terminal/exec`, `/api/depo/overview` and WebSocket `/ws`.

- [ ] **Step 1: Write failing UI & HIG compliance tests in `tests/ui-hig.test.js`**
  Verify HTML semantic structure, ARIA modal dialog for destructive confirmations, theme toggle, keyboard shortcut bindings, absence of forbidden AI-slop (`blur-3xl`, `Inter`), tabular-nums CSS, minimum 44px touch targets, and PWA manifest/icon presence.
- [ ] **Step 2: Run `node --test tests/ui-hig.test.js` to verify RED**
- [ ] **Step 3: Implement `public/index.html`, `public/styles.css`, `public/app.js`, `public/manifest.json`, `public/sw.js`, `public/icons/icon.svg`**
- [ ] **Step 4: Run `node --test` (full suite) to verify GREEN**
- [ ] **Step 5: Commit Task 5**

---

### Task 6: Dockerization, Live Hardware Verification & Stress Testing

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.gitignore`
- Create: `fleet-deck-linux.sh`
- Create: `fleet-deck-windows.bat`
- Create: `fleet-deck.desktop`
- Create: `README.md`

- [ ] **Step 1: Create `Dockerfile`, `docker-compose.yml` (with `mem_limit: 256m`, `cpus: 0.50`, SSH & socket mounts), launchers, and `README.md`**
- [ ] **Step 2: Build and start container (`docker compose up -d --build`)**
- [ ] **Step 3: Verify live API against real Kasa, Toshi, and Quasimodo nodes (`curl http://127.0.0.1:8091/api/fleet/summary`) and run concurrent stress test**
- [ ] **Step 4: Copy to `/home/kasa/Depo/agy/apps/fleet-deck`, create GitHub repo & push, and sync to `gdrive:apps/fleet-deck`**
