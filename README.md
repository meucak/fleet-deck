# Fleet Deck — Sovereign Multi-Machine Mission Control

> **Zero-Cloud, Crash-Proof Apple HIG Mission Control Dashboard for Kasa, Toshi, Quasimodo, Docker, Tailscale & Depo**

![Fleet Deck Icon](public/icons/icon.svg)

---

## Overview

**Fleet Deck** is a self-hosted, agentless mission control web application and installable PWA running in Docker on **Kasa** (`http://100.69.155.110:8091`). It unifies real-time telemetry, rolling sparkline trends, container management, Tailscale mesh visibility, live remote screen preview, cross-device clipboard/URL dispatch, and one-tap SSH actions across three heterogeneous machines:

1. **Kasa (`100.69.155.110` — Debian Host):** CPU load, thermal sensors, memory/swap, `/home/kasa/Depo` storage vault, and direct `/var/run/docker.sock` container management.
2. **Toshi (`100.79.246.19` — Linux Laptop / LXQt):** Battery level & charging state, CPU temperature, load average, RAM, disk, `wlp8s0` Wi-Fi link quality & signal dBm, `toshi-control-center.service` status, remote audio/brightness controls, and live Display `:0` desktop screenshot streaming.
3. **Quasimodo (`100.108.206.20` — Dell Latitude E6430 Windows):** CPU load, RAM, `C:` drive usage, uptime, and WMI battery telemetry (with automatic Dell E6430 AC power normalization and Last-Known-Good snapshot persistence when asleep).

---

## Key Features

- **Crash-Proof Architecture (`bi de pc çökmesin`):**
  - **Single-Flight Coalescing Cache:** Concurrent dashboard refreshes coalesce onto a single in-flight Promise per node—30 simultaneous requests complete in ~220ms with zero duplicate SSH processes.
  - **Tailscale Fast-Fail Offline Detection:** Checks `/var/run/tailscale/tailscaled.sock` in <2ms before spawning SSH; sleeping laptops fast-fail in 0ms and display their **Last-Known-Good** hardware snapshot (battery, disk, RAM, last active timestamp).
  - **SSH `ControlMaster` Multiplexing & Hard Timeouts:** Reuses persistent multiplexed SSH channels (`ControlPersist=120`) and enforces hard process kill timers.
  - **Strict Container Bounds:** Capped at `256 MB` RAM (uses ~14 MB at runtime) and `0.50` CPU in `docker-compose.yml`.
- **Direct Unix Socket Bridges:**
  - **Docker Engine (`/var/run/docker.sock`):** Inspect, start, stop, restart containers, view live container logs (`stdout`/`stderr`), and prevent accidental self-lockout (`fleet-deck` stop protection).
  - **Tailscale LocalAPI (`/var/run/tailscale/tailscaled.sock`):** Sub-5ms peer radar displaying all tailnet devices, connection modes (`direct`, `relay`, `offline`), and TX/RX byte counters.
- **Live Toshi Desktop Preview & Remote Hardware Controls:**
  - Non-interactive `maim -u` desktop capture streamed directly into an in-browser preview modal, plus 1-click remote Volume (`pactl`) and Brightness (`brightnessctl` / `xrandr`) adjustments.
- **Sovereign Scratchpad, Clipboard & Remote URL Bridge:**
  - Persistent shared note pad on Kasa with 1-click push to Toshi's X11 clipboard (`xclip`) or Quasimodo's Windows clipboard (`clip`), plus remote URL launching on either laptop's browser.
- **Safe Ad-Hoc Command Runner & Diagnostic JSON Export:**
  - Run diagnostic commands across `kasa`, `toshi`, or `quasimodo` protected by a deterministic safety guardrail that blocks fork bombs, root wipes, and raw block overwrites.
- **Apple HIG & Accessibility (WCAG AA/AAA):**
  - 8pt spatial grid, minimum `44x44px` touch targets, adaptive Dark & Light themes, inline SVG CPU trend sparklines, tabular numerals (`tabular-nums`), semantic status badges (icon + text + contrast), and full keyboard navigation (`/`, `R`, `T`, `Escape`).

---

## Quick Start (Docker Compose)

```bash
docker compose up -d --build
```

Then open:
- **Tailscale / LAN:** `http://100.69.155.110:8091`
- **Localhost:** `http://127.0.0.1:8091`

---

## Running Tests

```bash
./scripts/test.sh
```
