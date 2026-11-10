# Fleet Deck — Sovereign Multi-Machine Mission Control Design Spec

**Date:** 2026-11-10
**Project:** `fleet-deck` (`/home/kasa/apps/fleet-deck`)
**Port:** `8091` (`http://100.69.155.110:8091`)

---

## 1. Intent & Why

The user operates a heterogeneous personal machine fleet connected over a local LAN and Tailscale mesh network:
- **Kasa (`100.69.155.110`):** Debian host, Docker application server, central storage vault (`/home/kasa/Depo`).
- **Toshi (`100.79.246.19`):** Linux laptop (LXQt), custom PyQt6 control center (`toshi-control-center`), portable gaming and daily mobile workstation.
- **Quasimodo (`100.108.206.20`):** Dell Latitude E6430 Windows laptop (`semsettin`), OpenSSH server, `C:\rclone\rclone.exe` Google Drive (`gdrive:`) bridge.
- **Android / Mobile Endpoints:** Tailscale peers (`tecno-spark-20-pro`, `kill-tablet`) accessing local web apps and PWAs.

Previously, checking cross-machine telemetry (Toshi battery/temp/Wi-Fi, Quasimodo CPU/disk/battery, Kasa Docker containers and `/home/kasa/Depo` storage) or dispatching common headless operations (toggling Toshi control center, launching games on Toshi, syncing `apps` to Google Drive, restarting Docker containers, running quick diagnostic commands) required switching devices or manually typing SSH commands.

**Fleet Deck** solves this by providing a single, zero-cloud, crash-proof, Apple HIG-compliant Mission Control dashboard running in Docker on Kasa.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
1. **Live Tri-Node Telemetry:** Real-time hardware and network visibility for **Kasa**, **Toshi**, and **Quasimodo** with single-flight request coalescing and TTL caching so refresh storms never overload any machine.
2. **Direct Socket Integration on Kasa:**
   - Query `/var/run/docker.sock` directly over HTTP Unix socket to inspect, start, stop, restart containers, and view live container logs.
   - Query `/var/run/tailscale/tailscaled.sock` directly over HTTP Unix socket (`/localapi/v0/status`) for instant (<5ms) Tailscale mesh peer radar.
3. **One-Tap Cross-Machine Action Deck:** Curated, verified headless actions for Kasa, Toshi, and Quasimodo with execution history, duration tracking, and confirmation dialogs for power/destructive actions.
4. **Safe Ad-Hoc Command Runner:** Run quick diagnostic shell commands on `kasa`, `toshi`, or `quasimodo` from any browser/phone with an anti-crash command guardrail that rejects fork-bombs/destructive root wipes and enforces hard process timeouts.
5. **Depo & Service Portal:** Inspect `/home/kasa/Depo` (`apps`, `music`, `paras`, ISOs) and one-click launch active web services (`Fil :8090`, `Kush :8088`, `Cat Disco :8089`, `Dancing Chicken :8085`, `Simple Web :8080`).
6. **Crash-Proof Resource Footprint (`bi de pc çökmesin`):**
   - Strict Docker limits (`mem_limit: 256m`, `cpus: 0.50`).
   - Hard SSH timeouts (`ConnectTimeout=3`, `ServerAliveInterval=2`, process kill after `5000ms`).
   - Single-flight promise deduplication for all SSH and socket polls.

### Non-Goals
- Multi-tenant cloud user authentication or third-party cloud telemetry.
- Modifying host system packages outside Docker.

### Anti-Goals
- **No AI Slop Aesthetics:** No purple/indigo `blur-3xl` radial neon glows, no `Inter` font, no fake SaaS marketing copy, no unlabelled color-only status dots.
- **No Unbounded Subprocesses:** Never spawn background SSH processes without a hard kill timer or concurrency lock.

---

## 3. Approaches Considered

1. **Agent-Based Push Architecture (Rejected):** Installing custom background daemons on Toshi (Linux) and Quasimodo (Windows) to push metrics to Kasa. Rejected because it pollutes host systems and creates maintenance burden on Windows.
2. **Agentless SSH + Native Unix Socket Bridge in Docker (Selected):**
   - Kasa uses local `/proc`, `/sys`, `/var/run/docker.sock`, and `/var/run/tailscale/tailscaled.sock`.
   - Toshi and Quasimodo are queried agentlessly over existing passwordless OpenSSH (`id_ed25519`) with single-flight coalescing and 8-second TTL caching.
   - Zero software installation needed on Toshi or Quasimodo.
3. **Heavy Monitoring Stack (Prometheus + Grafana + Node Exporter) (Rejected):** Overkill memory/CPU footprint, no custom cross-machine action buttons, violates lightweight requirement.

---

## 4. Architecture & Component Design

### 4.1 Backend (`server/`)
- **`server/parsers.js`**: Pure, deterministic parsing and normalization functions:
  - `parseKasaMetrics(raw)`: Parses Linux `/proc/loadavg`, `/proc/meminfo`, `/proc/uptime`, thermal zones, and `df -BM` output into structured telemetry.
  - `parseToshiMetrics(raw)`: Parses Toshi single-shot SSH telemetry output (`BAT*` capacity/status, thermal zone millidegrees, `/proc/loadavg`, `free -m`, `df -BM`, `/proc/net/wireless` link quality & dBm, `toshi-control-center.service` status).
  - `parseQuasimodoMetrics(raw)`: Parses Windows `wmic` key-value output (`LoadPercentage`, `FreePhysicalMemory`, `TotalVisibleMemorySize`, `FreeSpace`, `Size`, `BatteryStatus`, `EstimatedChargeRemaining`, `LastBootUpTime`). Normalizes Dell Latitude E6430 WMI battery values (`>100` -> `100%`, `acPower: true`, `quirkNormalized: true`).
  - `parseTailscaleStatus(json)`: Normalizes Tailscale LocalAPI `/localapi/v0/status` JSON into sorted node list with online state, IPv4, OS, latency/relay info, and traffic counters.
  - `validateCommandSafety(command)`: Rejects catastrophic patterns (`rm -rf /`, fork bombs `:(){:|:&};:`, unbounded `yes`, raw disk overwrites `dd if=... of=/dev/sd*`, `mkfs`, `format c:`) with clear reason strings.
- **`server/coalesce.js`**:
  - `CoalescingCache`: Keyed async cache with configurable `ttlMs`. If a fetch for `key` is already in-flight, concurrent callers share the exact same Promise. Returns cached data when within TTL unless `force=true` (even on `force=true`, shares any currently in-flight request to prevent SSH stampedes).
- **`server/executor.js`**:
  - `runCommand(cmd, args, options)`: Spawns child process with hard `timeoutMs` (default `5000ms`), `maxBuffer` (`512KB`), capturing `stdout`, `stderr`, `exitCode`, `timedOut`, and `durationMs`.
  - `dockerSocketRequest(method, path, body)`: Communicates with `/var/run/docker.sock` via Node `http.request`.
  - `tailscaleSocketRequest(path)`: Communicates with `/var/run/tailscale/tailscaled.sock` via Node `http.request`.
- **`server/collector.js`**:
  - Collects Kasa, Toshi, Quasimodo, Docker, Tailscale, Service Portal, and Depo telemetry using `CoalescingCache` and `executor`.
- **`server/actions.js`**:
  - Defines curated actions across `kasa`, `toshi`, and `quasimodo` (with metadata: `id`, `node`, `label`, `description`, `category`, `destructive`, `confirmText`).
  - Executes actions and records an in-memory bounded audit log (last 50 executions with timestamp, node, action, status, duration, and output snippet).
- **`server/index.js`**:
  - HTTP REST API + static file server + WebSocket (`ws`) live broadcast server on port `8091`.

### 4.2 Frontend (`public/`)
- **Apple HIG Visual System:**
  - 8pt grid layout (`8px`, `16px`, `24px`, `32px`), minimum `44x44px` interactive targets.
  - Adaptive Light & Dark mode (persisted in `localStorage` + respects `prefers-color-scheme`).
  - Explicit semantic status badges combining icon + text + high-contrast color (`● Çevrimiçi / Online`, `▲ Uyarı / Warning`, `■ Çevrimdışı / Offline`).
  - Tabular numbers (`font-variant-numeric: tabular-nums`) on all gauges, counters, and timers.
  - Confirmation modal (`role="dialog"`, `aria-modal="true"`) with `Escape` to cancel for destructive/power actions (`Stop Container`, `Suspend Toshi`, `Sleep Quasimodo`, `Docker Prune`).

---

## 5. Verification & Delivery Contract
1. Unit & integration tests (`node --test`) covering all parsers, edge cases (Dell E6430 battery `563` quirk, SSH timeout fallback, malformed outputs), coalescing cache concurrency, command safety guardrails, action dispatcher, and HTTP API endpoints.
2. Live Docker deployment (`docker compose up -d --build`) verified against real Kasa, Toshi, and Quasimodo machines.
3. Stress test verifying 30 concurrent API requests trigger only 1 SSH session per remote host.
4. Copy final release to `/home/kasa/Depo/agy/apps/fleet-deck`, push to GitHub (`gh repo create`), and upload to Google Drive (`rclone copy ... gdrive:apps/fleet-deck`).
