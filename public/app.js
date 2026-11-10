(() => {
  'use strict';

  const state = {
    summary: null,
    actions: [],
    auditLog: [],
    nodeFilter: 'all',
    searchQuery: '',
    pendingConfirmFn: null,
    activeLogContainerId: null,
    ws: null
  };

  const els = {
    wsStatusBadge: document.getElementById('wsStatusBadge'),
    wsStatusText: document.getElementById('wsStatusText'),
    lastUpdatedTime: document.getElementById('lastUpdatedTime'),
    globalSearchInput: document.getElementById('globalSearchInput'),
    toshiLiveScreenBtn: document.getElementById('toshiLiveScreenBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    themeLabel: document.getElementById('themeLabel'),
    liveToast: document.getElementById('liveToast'),
    onlineNodesCount: document.getElementById('onlineNodesCount'),
    runningDockerCount: document.getElementById('runningDockerCount'),
    tailscaleOnlineCount: document.getElementById('tailscaleOnlineCount'),
    nodesGrid: document.getElementById('nodesGrid'),
    actionsGrid: document.getElementById('actionsGrid'),
    actionOutputPanel: document.getElementById('actionOutputPanel'),
    actionOutputBadge: document.getElementById('actionOutputBadge'),
    actionOutputTitle: document.getElementById('actionOutputTitle'),
    actionOutputMeta: document.getElementById('actionOutputMeta'),
    actionOutputPre: document.getElementById('actionOutputPre'),
    closeActionOutputBtn: document.getElementById('closeActionOutputBtn'),
    scratchpadTextarea: document.getElementById('scratchpadTextarea'),
    saveScratchpadBtn: document.getElementById('saveScratchpadBtn'),
    pushClipToshiBtn: document.getElementById('pushClipToshiBtn'),
    pushClipQuasimodoBtn: document.getElementById('pushClipQuasimodoBtn'),
    openUrlInput: document.getElementById('openUrlInput'),
    openUrlToshiBtn: document.getElementById('openUrlToshiBtn'),
    openUrlQuasimodoBtn: document.getElementById('openUrlQuasimodoBtn'),
    servicePortalGrid: document.getElementById('servicePortalGrid'),
    dockerTableBody: document.getElementById('dockerTableBody'),
    terminalForm: document.getElementById('terminalForm'),
    terminalNodeSelect: document.getElementById('terminalNodeSelect'),
    terminalCommandInput: document.getElementById('terminalCommandInput'),
    terminalRunBtn: document.getElementById('terminalRunBtn'),
    terminalStatusLabel: document.getElementById('terminalStatusLabel'),
    terminalDurationLabel: document.getElementById('terminalDurationLabel'),
    terminalConsoleOutput: document.getElementById('terminalConsoleOutput'),
    auditLogList: document.getElementById('auditLogList'),
    tailscaleNodesList: document.getElementById('tailscaleNodesList'),
    depoOverviewBox: document.getElementById('depoOverviewBox'),
    confirmModal: document.getElementById('confirmModal'),
    confirmModalTitle: document.getElementById('confirmModalTitle'),
    confirmModalDesc: document.getElementById('confirmModalDesc'),
    confirmCancelBtn: document.getElementById('confirmCancelBtn'),
    confirmProceedBtn: document.getElementById('confirmProceedBtn'),
    logsModal: document.getElementById('logsModal'),
    logsModalTitle: document.getElementById('logsModalTitle'),
    logsModalSubtitle: document.getElementById('logsModalSubtitle'),
    logsModalPre: document.getElementById('logsModalPre'),
    refreshLogsBtn: document.getElementById('refreshLogsBtn'),
    closeLogsModalBtn: document.getElementById('closeLogsModalBtn'),
    screenshotModal: document.getElementById('screenshotModal'),
    screenshotModalMeta: document.getElementById('screenshotModalMeta'),
    screenshotModalImg: document.getElementById('screenshotModalImg'),
    refreshScreenshotBtn: document.getElementById('refreshScreenshotBtn'),
    downloadScreenshotLink: document.getElementById('downloadScreenshotLink'),
    closeScreenshotModalBtn: document.getElementById('closeScreenshotModalBtn')
  };

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDurationUptime(seconds) {
    const s = Number(seconds) || 0;
    if (s <= 0) return '--';
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}g ${h}s ${m}dk`;
    if (h > 0) return `${h}s ${m}dk`;
    return `${m}dk`;
  }

  function formatBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 ** 3) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 ** 3)).toFixed(2)} GB`;
  }

  function barLevelClass(percent) {
    const p = Number(percent) || 0;
    if (p >= 90) return 'level-crit';
    if (p >= 75) return 'level-warn';
    return '';
  }

  function showToast(msg) {
    if (!els.liveToast) return;
    els.liveToast.textContent = msg;
    els.liveToast.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      els.liveToast.classList.add('hidden');
    }, 4000);
  }

  /* Inline SVG Sparkline Generator */
  function renderSparklineSvg(points, stats) {
    const list = Array.isArray(points) && points.length > 0 ? points : [{ cpuPercent: 0 }];
    const width = 260;
    const height = 34;
    const vals = list.map((p) => Math.min(100, Math.max(0, Number(p.cpuPercent) || 0)));
    const stepX = vals.length > 1 ? width / (vals.length - 1) : width;

    const coords = vals.map((v, idx) => {
      const x = Math.round(idx * stepX * 10) / 10;
      const y = Math.round((height - 4 - (v / 100) * (height - 8)) * 10) / 10;
      return `${x},${y}`;
    });
    const polylinePoints = vals.length === 1 ? `0,${coords[0].split(',')[1]} ${width},${coords[0].split(',')[1]}` : coords.join(' ');

    const avg = stats ? stats.cpuAvg : vals[vals.length - 1];
    const max = stats ? stats.cpuMax : vals[vals.length - 1];
    const ping = stats && stats.lastPingMs ? `${stats.lastPingMs} ms` : '--';

    return `
      <div class="sparkline-box">
        <div class="sparkline-header mono-num">
          <span>CPU Trend (Ort: ${avg}% · Zirve: ${max}%)</span>
          <span>Yanıt: ${escapeHtml(ping)}</span>
        </div>
        <svg class="sparkline-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="CPU Trend Sparkline">
          <polyline
            fill="none"
            stroke="var(--accent-primary)"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
            points="${polylinePoints}"
          />
        </svg>
      </div>
    `;
  }

  /* Theme Management */
  function initTheme() {
    const saved = localStorage.getItem('fleet-deck-theme');
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    const theme = saved || (prefersLight ? 'light' : 'dark');
    applyTheme(theme);
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('fleet-deck-theme', theme);
    if (els.themeLabel) {
      els.themeLabel.textContent = theme === 'dark' ? 'Koyu' : 'Açık';
    }
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  }

  /* Confirmation Modal (Apple HIG Destructive Action Gate) */
  function openConfirmModal(title, description, onConfirm) {
    state.pendingConfirmFn = onConfirm;
    els.confirmModalTitle.textContent = title;
    els.confirmModalDesc.textContent = description;
    els.confirmModal.classList.remove('hidden');
    els.confirmCancelBtn.focus();
  }

  function closeConfirmModal() {
    state.pendingConfirmFn = null;
    els.confirmModal.classList.add('hidden');
  }

  /* Logs Modal */
  async function openLogsModal(containerId, containerName) {
    state.activeLogContainerId = containerId;
    els.logsModalTitle.textContent = `Loglar: ${containerName || containerId}`;
    els.logsModalSubtitle.textContent = `Konteyner ID: ${containerId} · Son 80 satır`;
    els.logsModalPre.textContent = 'Log akışı okunuyor...';
    els.logsModal.classList.remove('hidden');
    els.closeLogsModalBtn.focus();
    await fetchContainerLogs(containerId);
  }

  function closeLogsModal() {
    state.activeLogContainerId = null;
    els.logsModal.classList.add('hidden');
  }

  async function fetchContainerLogs(containerId) {
    try {
      const res = await fetch(`/api/docker/containers/${encodeURIComponent(containerId)}/logs`);
      const data = await res.json();
      els.logsModalPre.textContent = data.ok ? data.logs : `Hata: ${data.error || 'Loglar alınamadı'}`;
    } catch (err) {
      els.logsModalPre.textContent = `Bağlantı hatası: ${err.message}`;
    }
  }

  /* Live Toshi Screenshot Preview Modal */
  async function openScreenshotModal() {
    els.screenshotModal.classList.remove('hidden');
    els.closeScreenshotModalBtn.focus();
    await fetchLiveToshiScreenshot();
  }

  function closeScreenshotModal() {
    els.screenshotModal.classList.add('hidden');
  }

  async function fetchLiveToshiScreenshot() {
    els.screenshotModalMeta.textContent = 'Toshi (:0) ekranı yakalanıyor...';
    try {
      const res = await fetch('/api/nodes/toshi/screenshot');
      const data = await res.json();
      if (!res.ok || !data.ok || !data.base64) {
        els.screenshotModalMeta.textContent = `Hata: ${data.error || 'Ekran yakalanamadı'}`;
        return;
      }
      const dataUri = `data:${data.mimeType || 'image/png'};base64,${data.base64}`;
      els.screenshotModalImg.src = dataUri;
      els.screenshotModalImg.classList.remove('hidden');
      els.downloadScreenshotLink.href = dataUri;
      els.screenshotModalMeta.textContent = `Yakalandı: ${new Date(data.capturedAt).toLocaleTimeString('tr-TR')} (${data.durationMs || 0} ms)`;
    } catch (err) {
      els.screenshotModalMeta.textContent = `Bağlantı hatası: ${err.message}`;
    }
  }

  /* Render Node Telemetry Cards */
  function renderNodeCard(nodeData) {
    if (!nodeData) return '';
    const isOnline = Boolean(nodeData.online);
    const statusBadge = isOnline
      ? '<span class="status-pill status-online"><span aria-hidden="true">●</span> Çevrimiçi</span>'
      : '<span class="status-pill status-offline"><span aria-hidden="true">■</span> Çevrimdışı</span>';

    if (!isOnline) {
      const lk = nodeData.lastKnown;
      let lkHtml = '';
      if (lk) {
        const lkBadges = [];
        if (lk.lastSeenOnlineAt) {
          lkBadges.push(`<span class="kv-badge">Son Aktif: <strong>${escapeHtml(new Date(lk.lastSeenOnlineAt).toLocaleTimeString('tr-TR'))}</strong></span>`);
        }
        if (lk.battery) {
          lkBadges.push(`<span class="kv-badge">Son Pil: <strong>${escapeHtml(lk.battery.status || `${lk.battery.percent}%`)}</strong></span>`);
        }
        if (lk.disk) {
          const dLabel = lk.disk.totalGb !== undefined
            ? `C: ${lk.disk.usedGb} / ${lk.disk.totalGb} GB (${lk.disk.freeGb} GB Boş)`
            : `${Math.round(lk.disk.usedMb / 1024)} / ${Math.round(lk.disk.totalMb / 1024)} GB`;
          lkBadges.push(`<span class="kv-badge">Son Disk: <strong>${escapeHtml(dLabel)}</strong></span>`);
        }
        if (lk.memory) {
          lkBadges.push(`<span class="kv-badge">Son RAM: <strong>${lk.memory.usedMb} / ${lk.memory.totalMb} MB</strong></span>`);
        }
        lkHtml = `<div class="node-chips-row">${lkBadges.join('')}</div>`;
      }
      return `
        <article class="node-card" data-node="${escapeHtml(nodeData.node)}">
          <div class="node-card-header">
            <div>
              <h3 class="node-name">${escapeHtml(nodeData.hostname || nodeData.node)}</h3>
              <div class="node-meta mono-num">${escapeHtml(nodeData.ip || '')} · ${escapeHtml(nodeData.os || '')}</div>
            </div>
            ${statusBadge}
          </div>
          <p class="section-desc">Düğüm şu an uyku modunda veya kapalı (${escapeHtml(nodeData.error || 'Çevrimdışı')}).</p>
          ${lkHtml}
        </article>
      `;
    }

    const cpuPct = Number(nodeData.cpuPercent) || 0;
    const memPct = nodeData.memory ? Number(nodeData.memory.percent) || 0 : 0;
    const memText = nodeData.memory
      ? `${nodeData.memory.usedMb} / ${nodeData.memory.totalMb} MB (${memPct}%)`
      : '--';

    let diskPct = 0;
    let diskText = '--';
    if (nodeData.disk) {
      diskPct = Number(nodeData.disk.percent) || 0;
      if (nodeData.disk.totalGb !== undefined) {
        diskText = `C: ${nodeData.disk.usedGb} / ${nodeData.disk.totalGb} GB (${diskPct}%)`;
      } else {
        diskText = `${Math.round(nodeData.disk.usedMb / 1024)} / ${Math.round(nodeData.disk.totalMb / 1024)} GB (${diskPct}%)`;
      }
    }

    const nodeHist = state.summary && state.summary.history && state.summary.history[nodeData.node];
    const sparklineHtml = renderSparklineSvg(
      nodeHist ? nodeHist.points : [{ cpuPercent: cpuPct }],
      nodeHist ? nodeHist.stats : { cpuAvg: cpuPct, cpuMax: cpuPct, lastPingMs: nodeData.pingMs }
    );

    const extraBadges = [];
    extraBadges.push(`<span class="kv-badge">Açık Süre: <strong>${escapeHtml(formatDurationUptime(nodeData.uptimeSeconds))}</strong></span>`);

    if (nodeData.temperatureC) {
      extraBadges.push(`<span class="kv-badge">Sıcaklık: <strong>${escapeHtml(nodeData.temperatureC)}°C</strong></span>`);
    }
    if (nodeData.load) {
      extraBadges.push(`<span class="kv-badge">Yük (1dk): <strong>${escapeHtml(nodeData.load.load1)}</strong></span>`);
    }
    if (nodeData.battery) {
      extraBadges.push(`<span class="kv-badge">Güç/Pil: <strong>${escapeHtml(nodeData.battery.status || `${nodeData.battery.percent}%`)}</strong></span>`);
    }
    if (nodeData.wifi && nodeData.wifi.interface) {
      extraBadges.push(`<span class="kv-badge">Wi-Fi (${escapeHtml(nodeData.wifi.interface)}): <strong>${escapeHtml(nodeData.wifi.qualityPercent)}% (${escapeHtml(nodeData.wifi.signalDbm)} dBm)</strong></span>`);
    }
    if (nodeData.controlCenterService) {
      extraBadges.push(`<span class="kv-badge">Denetim Merkezi: <strong>${escapeHtml(nodeData.controlCenterService)}</strong></span>`);
    }

    return `
      <article class="node-card" data-node="${escapeHtml(nodeData.node)}">
        <div class="node-card-header">
          <div>
            <h3 class="node-name">${escapeHtml(nodeData.hostname || nodeData.node)}</h3>
            <div class="node-meta mono-num">${escapeHtml(nodeData.ip)} · ${escapeHtml(nodeData.os)}</div>
          </div>
          ${statusBadge}
        </div>

        <div class="metrics-list">
          <div class="metric-item">
            <div class="metric-label-row">
              <span>CPU Kullanımı</span>
              <strong class="mono-num">${cpuPct}%</strong>
            </div>
            <div class="metric-bar-track" role="progressbar" aria-valuenow="${cpuPct}" aria-valuemin="0" aria-valuemax="100">
              <div class="metric-bar-fill ${barLevelClass(cpuPct)}" style="width: ${cpuPct}%"></div>
            </div>
          </div>

          <div class="metric-item">
            <div class="metric-label-row">
              <span>RAM Bellek</span>
              <strong class="mono-num">${escapeHtml(memText)}</strong>
            </div>
            <div class="metric-bar-track" role="progressbar" aria-valuenow="${memPct}" aria-valuemin="0" aria-valuemax="100">
              <div class="metric-bar-fill ${barLevelClass(memPct)}" style="width: ${memPct}%"></div>
            </div>
          </div>

          <div class="metric-item">
            <div class="metric-label-row">
              <span>Disk Alanı</span>
              <strong class="mono-num">${escapeHtml(diskText)}</strong>
            </div>
            <div class="metric-bar-track" role="progressbar" aria-valuenow="${diskPct}" aria-valuemin="0" aria-valuemax="100">
              <div class="metric-bar-fill ${barLevelClass(diskPct)}" style="width: ${diskPct}%"></div>
            </div>
          </div>
        </div>

        ${sparklineHtml}

        <div class="node-chips-row">
          ${extraBadges.join('')}
        </div>
      </article>
    `;
  }

  function renderNodesSection() {
    if (!state.summary || !state.summary.nodes) return;
    const { kasa, toshi, quasimodo } = state.summary.nodes;
    const allNodes = [kasa, toshi, quasimodo].filter(Boolean);
    const onlineCount = allNodes.filter((n) => n.online).length;

    els.onlineNodesCount.textContent = `${onlineCount} / ${allNodes.length}`;
    if (state.summary.docker) {
      els.runningDockerCount.textContent = `${state.summary.docker.runningCount} / ${state.summary.docker.totalCount}`;
    }
    if (state.summary.tailscale) {
      els.tailscaleOnlineCount.textContent = `${state.summary.tailscale.onlineCount} / ${state.summary.tailscale.totalCount}`;
    }

    els.nodesGrid.innerHTML = allNodes.map(renderNodeCard).join('');
  }

  /* Render Curated Actions Deck */
  function renderActionsSection() {
    const q = state.searchQuery.toLowerCase();
    const filtered = state.actions.filter((a) => {
      if (state.nodeFilter !== 'all' && a.node !== state.nodeFilter) return false;
      if (!q) return true;
      return (
        a.label.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.node.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q)
      );
    });

    if (filtered.length === 0) {
      els.actionsGrid.innerHTML = '<p class="section-desc">Seçili filtreye uygun eylem bulunamadı.</p>';
      return;
    }

    els.actionsGrid.innerHTML = filtered
      .map((a) => {
        const btnClass = a.destructive ? 'btn btn-danger' : 'btn btn-primary';
        const btnText = a.destructive ? '▲ Onaylı Çalıştır' : '▶ Çalıştır';
        return `
          <article class="action-card">
            <div class="action-top">
              <div class="action-tags">
                <span class="node-tag">${escapeHtml(a.node)}</span>
                <span class="category-tag">${escapeHtml(a.category)}</span>
              </div>
              <h3 class="action-title">${escapeHtml(a.label)}</h3>
              <p class="action-desc">${escapeHtml(a.description)}</p>
            </div>
            <button
              type="button"
              class="${btnClass}"
              data-action-id="${escapeHtml(a.id)}"
              data-destructive="${a.destructive ? 'true' : 'false'}"
              data-confirm-text="${escapeHtml(a.confirmText || '')}"
              data-action-label="${escapeHtml(a.label)}"
            >
              ${btnText}
            </button>
          </article>
        `;
      })
      .join('');
  }

  async function triggerAction(actionId, label) {
    showToast(`Çalıştırılıyor: ${label}...`);
    try {
      const res = await fetch(`/api/actions/${encodeURIComponent(actionId)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await res.json();
      els.actionOutputPanel.classList.remove('hidden');
      els.actionOutputBadge.className = data.ok ? 'status-pill status-online' : 'status-pill status-offline';
      els.actionOutputBadge.textContent = data.ok ? '● Başarılı' : '■ Hata';
      els.actionOutputTitle.textContent = `${data.label || label} (${data.node || ''})`;
      els.actionOutputMeta.textContent = `${data.durationMs || 0} ms`;
      els.actionOutputPre.textContent = data.stdout || data.stderr || data.error || '(Çıktı yok)';
      await fetchActionsAndAudit();
    } catch (err) {
      showToast(`Eylem hatası: ${err.message}`);
    }
  }

  /* Render Service Portal & Docker Containers */
  function renderDockerAndPortal() {
    if (!state.summary) return;
    const host = window.location.hostname || '100.69.155.110';
    const q = state.searchQuery.toLowerCase();

    const services = state.summary.services || [];
    els.servicePortalGrid.innerHTML = services
      .map((s) => {
        const badge = s.online
          ? '<span class="status-pill status-online">● Aktif</span>'
          : '<span class="status-pill status-offline">■ Kapalı</span>';
        const localUrl = `http://${host}:${s.port}`;
        const tunnelBtn = s.externalUrl
          ? `<a href="${escapeHtml(s.externalUrl)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">🌐 Cloudflare Tunnel</a>`
          : '';
        return `
          <div class="portal-card">
            <div>
              <div class="portal-card-head">
                <span class="portal-name">${escapeHtml(s.name)}</span>
                ${badge}
              </div>
              <div class="portal-sub">${escapeHtml(s.subtitle)} · <code class="mono-num">:${s.port}</code></div>
            </div>
            <div class="portal-links">
              <a href="${escapeHtml(localUrl)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">Aç (:${s.port}) ↗</a>
              ${tunnelBtn}
            </div>
          </div>
        `;
      })
      .join('');

    const containers = (state.summary.docker && state.summary.docker.containers) || [];
    const filteredContainers = containers.filter((c) => {
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q) || c.status.toLowerCase().includes(q);
    });

    els.dockerTableBody.innerHTML = filteredContainers
      .map((c) => {
        const isRunning = c.state === 'running';
        const pill = isRunning
          ? '<span class="status-pill status-online">● Çalışıyor</span>'
          : '<span class="status-pill status-offline">■ Durdu</span>';

        const portLinks = (c.ports || [])
          .map((p) => `<a href="http://${escapeHtml(host)}:${p}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm mono-num">:${p} ↗</a>`)
          .join(' ');

        const toggleAction = isRunning ? 'stop' : 'start';
        const toggleLabel = isRunning ? 'Durdur' : 'Başlat';
        const toggleBtn = c.isSelf
          ? `<button type="button" class="btn btn-ghost btn-sm" disabled title="Fleet Deck kendisini durduramaz">Korumalı</button>`
          : `<button type="button" class="btn ${isRunning ? 'btn-danger' : 'btn-primary'} btn-sm" data-docker-id="${escapeHtml(c.id)}" data-docker-name="${escapeHtml(c.name)}" data-docker-action="${toggleAction}">${toggleLabel}</button>`;

        return `
          <tr>
            <td>${pill}</td>
            <td><strong class="mono-num">${escapeHtml(c.name)}</strong></td>
            <td><code class="mono-num">${escapeHtml(c.image)}</code></td>
            <td class="mono-num">${escapeHtml(c.status)}</td>
            <td>${portLinks || '<span class="text-muted">İç Ağ</span>'}</td>
            <td class="text-right">
              <div class="table-actions">
                <button type="button" class="btn btn-secondary btn-sm" data-docker-id="${escapeHtml(c.id)}" data-docker-name="${escapeHtml(c.name)}" data-docker-action="restart">↻ Yeniden Başlat</button>
                ${toggleBtn}
                <button type="button" class="btn btn-secondary btn-sm" data-docker-logs="${escapeHtml(c.id)}" data-docker-name="${escapeHtml(c.name)}">Loglar</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  async function executeDockerContainerAction(containerId, containerName, action) {
    showToast(`Konteyner ${containerName}: ${action} uygulanıyor...`);
    try {
      const res = await fetch(`/api/docker/containers/${encodeURIComponent(containerId)}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showToast(`Hata: ${data.error || 'İşlem başarısız'}`);
        return;
      }
      showToast(`Konteyner ${containerName}: ${action} tamamlandı.`);
      await fetchFleetSummary(true);
    } catch (err) {
      showToast(`Bağlantı hatası: ${err.message}`);
    }
  }

  /* Render Tailscale & Depo Overview */
  function renderTailscaleAndDepo() {
    if (!state.summary) return;
    const q = state.searchQuery.toLowerCase();
    const tsNodes = (state.summary.tailscale && state.summary.tailscale.nodes) || [];
    const filteredTs = tsNodes.filter((n) => !q || n.hostname.toLowerCase().includes(q) || n.ip.includes(q) || n.os.toLowerCase().includes(q));

    els.tailscaleNodesList.innerHTML = filteredTs
      .map((n) => {
        const badge = n.online
          ? '<span class="status-pill status-online">● Aktif</span>'
          : '<span class="status-pill status-offline">■ Çevrimdışı</span>';
        return `
          <div class="list-row">
            <div>
              <strong>${escapeHtml(n.hostname)}</strong>
              <span class="text-muted mono-num"> · ${escapeHtml(n.ip)} · ${escapeHtml(n.os)} (${escapeHtml(n.connectionMode)})</span>
            </div>
            <div class="output-title-group">
              <span class="mono-num text-muted">↓ ${escapeHtml(formatBytes(n.rxBytes))} ↑ ${escapeHtml(formatBytes(n.txBytes))}</span>
              ${badge}
            </div>
          </div>
        `;
      })
      .join('');

    const depo = state.summary.depo;
    if (depo) {
      const parasBadge = depo.parasClean
        ? '<span class="status-pill status-online">● Paras Gelen Kutusu Temiz (0 Dosya)</span>'
        : `<span class="status-pill status-warning">▲ Paras Gelen Kutusunda ${depo.parasFiles.length} Dosya Bekliyor</span>`;

      const appBadges = (depo.apps || []).map((app) => `<span class="kv-badge"><strong>${escapeHtml(app)}</strong></span>`).join('');
      const isoBadges = (depo.isoFiles || []).map((iso) => `<span class="kv-badge mono-num">${escapeHtml(iso.name)} (<strong>${iso.sizeMb} MB</strong>)</span>`).join('');

      els.depoOverviewBox.innerHTML = `
        <div>${parasBadge}</div>
        <div>
          <div class="form-label">Paylaşılan Uygulamalar (/home/kasa/Depo/agy/apps)</div>
          <div class="node-chips-row">${appBadges || '<span class="text-muted">Yok</span>'}</div>
        </div>
        <div class="node-chips-row">
          <span class="kv-badge">Müzik Arşivi: <strong class="mono-num">${escapeHtml(depo.musicCount)} Parça</strong></span>
          ${isoBadges}
        </div>
      `;
    }
  }

  /* Render Audit Log */
  function renderAuditLog() {
    if (!state.auditLog || state.auditLog.length === 0) {
      els.auditLogList.innerHTML = '<p class="section-desc">Henüz bu oturumda tetiklenen bir işlem kaydı yok.</p>';
      return;
    }
    els.auditLogList.innerHTML = state.auditLog
      .slice(0, 15)
      .map((item) => {
        const badge = item.ok
          ? '<span class="status-pill status-online">● OK</span>'
          : '<span class="status-pill status-offline">■ Hata</span>';
        const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString('tr-TR') : '';
        return `
          <div class="list-row">
            <div>
              <strong>${escapeHtml(item.label || item.actionId)}</strong>
              <div class="text-muted mono-num">${escapeHtml(item.node)} · ${escapeHtml(timeStr)} · ${item.durationMs || 0} ms</div>
            </div>
            ${badge}
          </div>
        `;
      })
      .join('');
  }

  /* Scratchpad, Clipboard & Remote URL Actions */
  async function loadScratchpad() {
    try {
      const res = await fetch('/api/scratchpad');
      const data = await res.json();
      if (data.ok && els.scratchpadTextarea) {
        els.scratchpadTextarea.value = data.text || '';
      }
    } catch (_) {}
  }

  async function saveScratchpad() {
    const text = els.scratchpadTextarea.value;
    try {
      const res = await fetch('/api/scratchpad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      if (data.ok) {
        showToast('Ortak not kaydedildi ve eşitlendi.');
      }
    } catch (err) {
      showToast(`Not kaydedilemedi: ${err.message}`);
    }
  }

  async function pushToNodeClipboard(node) {
    const text = els.scratchpadTextarea.value;
    if (!text.trim()) {
      showToast('Panoya göndermek için önce metin girin.');
      return;
    }
    showToast(`${node} panosuna kopyalanıyor...`);
    try {
      const res = await fetch('/api/dispatch/clipboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node, text })
      });
      const data = await res.json();
      showToast(data.ok ? `${node.toUpperCase()} sistem panosuna kopyalandı (${data.length} kr).` : `Pano hatası: ${data.error}`);
    } catch (err) {
      showToast(`Pano bağlantı hatası: ${err.message}`);
    }
  }

  async function openUrlOnRemoteNode(node) {
    const url = els.openUrlInput.value.trim();
    if (!url) return;
    showToast(`URL ${node} üzerinde açılıyor...`);
    try {
      const res = await fetch('/api/dispatch/open-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node, url })
      });
      const data = await res.json();
      showToast(data.ok ? `URL ${node.toUpperCase()} ekranında açıldı.` : `URL hatası: ${data.error}`);
    } catch (err) {
      showToast(`Bağlantı hatası: ${err.message}`);
    }
  }

  async function controlToshiHw(type, value) {
    showToast(`Toshi ${type} ayarlanıyor...`);
    try {
      const res = await fetch('/api/nodes/toshi/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, value: Number(value) })
      });
      const data = await res.json();
      showToast(data.ok ? `Toshi: ${data.stdout || type + ' güncellendi'}` : `Hata: ${data.error}`);
    } catch (err) {
      showToast(`Toshi donanım hatası: ${err.message}`);
    }
  }

  /* Data Fetching & WebSocket */
  async function fetchFleetSummary(force = false) {
    try {
      const res = await fetch(`/api/fleet/summary${force ? '?force=true' : ''}`);
      const data = await res.json();
      state.summary = data;
      els.lastUpdatedTime.textContent = new Date(data.timestamp || Date.now()).toLocaleTimeString('tr-TR');
      renderNodesSection();
      renderDockerAndPortal();
      renderTailscaleAndDepo();
    } catch (err) {
      showToast(`Telemetri yenilenemedi: ${err.message}`);
    }
  }

  async function fetchActionsAndAudit() {
    try {
      const res = await fetch('/api/actions');
      const data = await res.json();
      if (data.ok) {
        state.actions = data.actions || [];
        state.auditLog = data.auditLog || [];
        renderActionsSection();
        renderAuditLog();
      }
    } catch (_) {}
  }

  function connectWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.addEventListener('open', () => {
      els.wsStatusBadge.className = 'status-pill status-online';
      els.wsStatusText.textContent = 'Canlı Akış';
    });

    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'fleet-summary' && msg.data) {
          state.summary = msg.data;
          els.lastUpdatedTime.textContent = new Date(msg.data.timestamp || Date.now()).toLocaleTimeString('tr-TR');
          renderNodesSection();
          renderDockerAndPortal();
          renderTailscaleAndDepo();
        } else if (msg.type === 'scratchpad-update' && msg.data && document.activeElement !== els.scratchpadTextarea) {
          els.scratchpadTextarea.value = msg.data.text || '';
        }
      } catch (_) {}
    });

    ws.addEventListener('close', () => {
      els.wsStatusBadge.className = 'status-pill status-warning';
      els.wsStatusText.textContent = 'Yeniden Bağlanıyor';
      setTimeout(connectWebSocket, 4000);
    });
  }

  /* Event Listeners */
  els.refreshBtn.addEventListener('click', () => {
    showToast('Telemetri yenileniyor...');
    fetchFleetSummary(true);
  });

  els.toshiLiveScreenBtn.addEventListener('click', openScreenshotModal);
  els.refreshScreenshotBtn.addEventListener('click', fetchLiveToshiScreenshot);
  els.closeScreenshotModalBtn.addEventListener('click', closeScreenshotModal);

  els.saveScratchpadBtn.addEventListener('click', saveScratchpad);
  els.pushClipToshiBtn.addEventListener('click', () => pushToNodeClipboard('toshi'));
  els.pushClipQuasimodoBtn.addEventListener('click', () => pushToNodeClipboard('quasimodo'));
  els.openUrlToshiBtn.addEventListener('click', () => openUrlOnRemoteNode('toshi'));
  els.openUrlQuasimodoBtn.addEventListener('click', () => openUrlOnRemoteNode('quasimodo'));

  document.querySelectorAll('button[data-toshi-hw]').forEach((btn) => {
    btn.addEventListener('click', () => {
      controlToshiHw(btn.getAttribute('data-toshi-hw'), btn.getAttribute('data-toshi-val'));
    });
  });

  els.themeToggleBtn.addEventListener('click', toggleTheme);

  els.globalSearchInput.addEventListener('input', (e) => {
    state.searchQuery = e.target.value.trim();
    renderActionsSection();
    renderDockerAndPortal();
    renderTailscaleAndDepo();
  });

  document.querySelectorAll('.segment-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segment-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.nodeFilter = btn.getAttribute('data-node-filter') || 'all';
      renderActionsSection();
    });
  });

  els.actionsGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action-id]');
    if (!btn) return;
    const actionId = btn.getAttribute('data-action-id');
    const label = btn.getAttribute('data-action-label');
    const destructive = btn.getAttribute('data-destructive') === 'true';
    const confirmText = btn.getAttribute('data-confirm-text');

    if (destructive) {
      openConfirmModal(`${label} — Onay`, confirmText || 'Bu işlemi onaylıyor musunuz?', () => {
        triggerAction(actionId, label);
      });
    } else {
      triggerAction(actionId, label);
    }
  });

  els.closeActionOutputBtn.addEventListener('click', () => {
    els.actionOutputPanel.classList.add('hidden');
  });

  els.dockerTableBody.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('button[data-docker-action]');
    if (actionBtn) {
      const id = actionBtn.getAttribute('data-docker-id');
      const name = actionBtn.getAttribute('data-docker-name');
      const action = actionBtn.getAttribute('data-docker-action');
      if (action === 'stop') {
        openConfirmModal(
          `${name} Konteynerini Durdur`,
          `${name} servisini durdurmak istediğinize emin misiniz?`,
          () => executeDockerContainerAction(id, name, action)
        );
      } else {
        executeDockerContainerAction(id, name, action);
      }
      return;
    }

    const logsBtn = e.target.closest('button[data-docker-logs]');
    if (logsBtn) {
      const id = logsBtn.getAttribute('data-docker-logs');
      const name = logsBtn.getAttribute('data-docker-name');
      openLogsModal(id, name);
    }
  });

  els.confirmCancelBtn.addEventListener('click', closeConfirmModal);
  els.confirmProceedBtn.addEventListener('click', () => {
    const fn = state.pendingConfirmFn;
    closeConfirmModal();
    if (typeof fn === 'function') fn();
  });

  els.closeLogsModalBtn.addEventListener('click', closeLogsModal);
  els.refreshLogsBtn.addEventListener('click', () => {
    if (state.activeLogContainerId) {
      fetchContainerLogs(state.activeLogContainerId);
    }
  });

  document.querySelectorAll('.chip-btn').forEach((chip) => {
    chip.addEventListener('click', () => {
      els.terminalNodeSelect.value = chip.getAttribute('data-preset-node') || 'kasa';
      els.terminalCommandInput.value = chip.getAttribute('data-preset-cmd') || '';
      els.terminalCommandInput.focus();
    });
  });

  els.terminalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const node = els.terminalNodeSelect.value;
    const command = els.terminalCommandInput.value.trim();
    if (!command) return;

    els.terminalRunBtn.disabled = true;
    els.terminalStatusLabel.textContent = `Çalıştırılıyor (${node})...`;
    els.terminalConsoleOutput.textContent = 'Komut gönderildi...';

    try {
      const res = await fetch('/api/terminal/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node, command })
      });
      const data = await res.json();
      els.terminalStatusLabel.textContent = data.ok ? `● Başarılı (${node})` : `■ Hata / Engellendi (${node})`;
      els.terminalDurationLabel.textContent = `${data.durationMs || 0} ms`;
      els.terminalConsoleOutput.textContent = data.stdout || data.stderr || data.error || '(Boş çıktı)';
      await fetchActionsAndAudit();
    } catch (err) {
      els.terminalStatusLabel.textContent = '■ Bağlantı Hatası';
      els.terminalConsoleOutput.textContent = err.message;
    } finally {
      els.terminalRunBtn.disabled = false;
    }
  });

  /* Global Keyboard Shortcuts (Escape, /, R, T) */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.confirmModal.classList.contains('hidden')) {
        closeConfirmModal();
        return;
      }
      if (!els.logsModal.classList.contains('hidden')) {
        closeLogsModal();
        return;
      }
      if (!els.screenshotModal.classList.contains('hidden')) {
        closeScreenshotModal();
        return;
      }
    }

    const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
    if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select') {
      return;
    }

    if (e.key === '/') {
      e.preventDefault();
      els.globalSearchInput.focus();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      showToast('Telemetri yenileniyor...');
      fetchFleetSummary(true);
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      toggleTheme();
    }
  });

  /* Register PWA Service Worker */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  /* Bootstrap */
  initTheme();
  fetchFleetSummary(false);
  fetchActionsAndAudit();
  loadScratchpad();
  connectWebSocket();
})();
