/**
 * TikTok Video Downloader — Popup Script
 * Controls the popup UI, communicates with background service worker.
 */

(function () {
  'use strict';

  // ─── DOM References ──────────────────────────────────────────────────

  const els = {
    // Status
    queueState: document.getElementById('queue-state'),
    queueProgress: document.getElementById('queue-progress'),
    progressContainer: document.getElementById('progress-container'),
    progressFill: document.getElementById('progress-fill'),
    progressPercent: document.getElementById('progress-percent'),
    progressCounts: document.getElementById('progress-counts'),
    statsRow: document.getElementById('stats-row'),
    statPending: document.getElementById('stat-pending'),
    statActive: document.getElementById('stat-active'),
    statDone: document.getElementById('stat-done'),
    statFailed: document.getElementById('stat-failed'),

    // Controls
    btnScan: document.getElementById('btn-scan'),
    btnPause: document.getElementById('btn-pause'),
    btnResume: document.getElementById('btn-resume'),
    btnCancel: document.getElementById('btn-cancel'),
    btnRetry: document.getElementById('btn-retry'),
    btnExportLog: document.getElementById('btn-export-log'),
    btnSettings: document.getElementById('btn-settings'),

    // Videos
    sectionVideos: document.getElementById('section-videos'),
    sectionEmpty: document.getElementById('section-empty'),
    videoList: document.getElementById('video-list'),
    videoCount: document.getElementById('video-count'),
    btnLoadMore: document.getElementById('btn-load-more'),
  };

  // ─── State ───────────────────────────────────────────────────────────

  let currentStatus = null;
  let displayedItems = 0;
  const ITEMS_PER_PAGE = 30;
  let pollInterval = null;

  // ─── Initialization ──────────────────────────────────────────────────

  async function init() {
    attachEventListeners();
    await refreshStatus();
    startPolling();
  }

  function attachEventListeners() {
    els.btnScan.addEventListener('click', handleScan);
    els.btnPause.addEventListener('click', handlePause);
    els.btnResume.addEventListener('click', handleResume);
    els.btnCancel.addEventListener('click', handleCancel);
    els.btnRetry.addEventListener('click', handleRetry);
    els.btnExportLog.addEventListener('click', handleExportLog);
    els.btnSettings.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
    els.btnLoadMore.addEventListener('click', loadMoreItems);
  }

  // ─── Status Polling ──────────────────────────────────────────────────

  function startPolling() {
    pollInterval = setInterval(refreshStatus, 1500);
  }

  async function refreshStatus() {
    try {
      const response = await sendMessage({ type: TTDL.MSG.GET_QUEUE_STATUS });
      if (response && response.success) {
        currentStatus = response;
        updateUI(response);
      }
    } catch (err) {
      console.error('[TTDL Popup] Failed to get status:', err);
    }
  }

  // ─── UI Updates ──────────────────────────────────────────────────────

  function updateUI(status) {
    const { state, stats, items } = status;

    // Queue state label
    const stateLabels = {
      idle: 'Idle',
      running: 'Running',
      paused: 'Paused',
      cancelled: 'Cancelled',
    };
    els.queueState.textContent = stateLabels[state] || state;
    els.queueState.style.color = state === 'running' ? '#25f4ee'
      : state === 'paused' ? '#facc15'
      : state === 'cancelled' ? '#ef4444'
      : '#25f4ee';

    // Progress
    const total = stats.total || 0;
    const completed = stats.completed || 0;
    const failed = stats.failed || 0;
    const done = completed + failed;

    els.queueProgress.textContent = `${done} / ${total}`;

    // Progress bar
    if (total > 0) {
      els.progressContainer.style.display = 'block';
      els.statsRow.style.display = 'flex';

      const percent = total > 0 ? Math.round((done / total) * 100) : 0;
      els.progressFill.style.width = `${percent}%`;
      els.progressPercent.textContent = `${percent}%`;
      els.progressCounts.textContent = `${completed} completed, ${failed} failed`;
    } else {
      els.progressContainer.style.display = 'none';
      els.statsRow.style.display = 'none';
    }

    // Stats
    els.statPending.textContent = stats.pending || 0;
    els.statActive.textContent = stats.downloading || 0;
    els.statDone.textContent = stats.completed || 0;
    els.statFailed.textContent = stats.failed || 0;

    // Button states
    const isRunning = state === 'running';
    const isPaused = state === 'paused';
    const hasPending = (stats.pending || 0) > 0;
    const hasFailed = (stats.failed || 0) > 0;

    els.btnPause.disabled = !isRunning;
    els.btnPause.style.display = isRunning ? '' : 'none';
    els.btnResume.disabled = !isPaused;
    els.btnResume.style.display = isPaused ? '' : 'none';
    els.btnCancel.disabled = !isRunning && !isPaused;
    els.btnRetry.disabled = !hasFailed;

    // Video list
    if (items && items.length > 0) {
      els.sectionVideos.style.display = 'block';
      els.sectionEmpty.style.display = 'none';
      els.videoCount.textContent = items.length;
      renderVideoList(items);
    } else if (total === 0) {
      els.sectionVideos.style.display = 'none';
      els.sectionEmpty.style.display = 'flex';
    }
  }

  /**
   * Render the video list with lazy loading / chunking.
   */
  function renderVideoList(items) {
    // Only re-render if items changed
    const currentCount = els.videoList.children.length;
    const itemsToShow = items.slice(0, displayedItems || ITEMS_PER_PAGE);

    // Update existing items' statuses in-place where possible
    if (currentCount > 0 && currentCount <= itemsToShow.length) {
      for (let i = 0; i < currentCount; i++) {
        const el = els.videoList.children[i];
        const item = itemsToShow[i];
        const statusEl = el.querySelector('.video-item-status');
        if (statusEl) {
          const newClass = `video-item-status status-${item.state}`;
          const newText = formatState(item.state);
          if (statusEl.className !== newClass || statusEl.textContent !== newText) {
            statusEl.className = newClass;
            statusEl.textContent = newText;
          }
        }
      }

      // Append new items if the list grew
      for (let i = currentCount; i < itemsToShow.length; i++) {
        els.videoList.appendChild(createVideoItem(itemsToShow[i]));
      }
    } else {
      // Full re-render
      els.videoList.innerHTML = '';
      const fragment = document.createDocumentFragment();
      itemsToShow.forEach(item => {
        fragment.appendChild(createVideoItem(item));
      });
      els.videoList.appendChild(fragment);
    }

    displayedItems = itemsToShow.length;

    // Show/hide load more button
    if (items.length > displayedItems) {
      els.btnLoadMore.style.display = 'block';
      els.btnLoadMore.textContent = `Load More (${items.length - displayedItems} remaining)`;
    } else {
      els.btnLoadMore.style.display = 'none';
    }
  }

  function createVideoItem(item) {
    const div = document.createElement('div');
    div.className = 'video-item';
    div.innerHTML = `
      <div class="video-item-info">
        <div class="video-item-title">@${escapeHtml(item.username)} — ${escapeHtml(item.videoId)}</div>
        <div class="video-item-meta">${item.error ? escapeHtml(item.error) : `Retry: ${item.retryCount || 0}`}</div>
      </div>
      <span class="video-item-status status-${item.state}">${formatState(item.state)}</span>
    `;
    return div;
  }

  function loadMoreItems() {
    if (currentStatus && currentStatus.items) {
      displayedItems += ITEMS_PER_PAGE;
      renderVideoList(currentStatus.items);
    }
  }

  function formatState(state) {
    const labels = {
      pending: 'Pending',
      downloading: 'Active',
      complete: 'Done',
      failed: 'Failed',
      cancelled: 'Cancelled',
    };
    return labels[state] || state;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ─── Event Handlers ──────────────────────────────────────────────────

  async function handleScan() {
    els.btnScan.disabled = true;
    els.btnScan.textContent = 'Scanning...';

    try {
      // Get the active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !tab.url || !tab.url.includes('tiktok.com')) {
        showPopupToast('Please navigate to a TikTok page first.', 'warning');
        return;
      }

      // Send scan message to content script
      const response = await chrome.tabs.sendMessage(tab.id, { type: TTDL.MSG.GET_PAGE_VIDEOS });

      if (response && response.videos && response.videos.length > 0) {
        showPopupToast(`Found ${response.videos.length} video(s)!`, 'success');

        // Queue all found videos — background will resolve URLs during download
        const result = await sendMessage({
          type: TTDL.MSG.DOWNLOAD_BATCH,
          videos: response.videos,
        });

        if (result && result.success) {
          showPopupToast(`Queued ${result.added} video(s). ${result.duplicates} duplicates skipped.`, 'success');
        } else {
          showPopupToast(result?.error || 'Failed to queue downloads.', 'error');
        }
      } else {
        showPopupToast('No downloadable videos found on this page.', 'info');
      }
    } catch (err) {
      console.error('[TTDL Popup] Scan error:', err);
      showPopupToast('Could not scan this page. Make sure you\'re on a TikTok page.', 'error');
    } finally {
      els.btnScan.disabled = false;
      els.btnScan.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        Scan Page
      `;
    }
  }

  async function handlePause() {
    await sendMessage({ type: TTDL.MSG.PAUSE_QUEUE });
    await refreshStatus();
  }

  async function handleResume() {
    await sendMessage({ type: TTDL.MSG.RESUME_QUEUE });
    await refreshStatus();
  }

  async function handleCancel() {
    if (confirm('Cancel all pending downloads?')) {
      await sendMessage({ type: TTDL.MSG.CANCEL_QUEUE });
      await refreshStatus();
    }
  }

  async function handleRetry() {
    const response = await sendMessage({ type: TTDL.MSG.RETRY_FAILED });
    if (response && response.success) {
      showPopupToast(`Retrying ${response.retried} failed item(s).`, 'info');
    }
    await refreshStatus();
  }

  async function handleExportLog() {
    try {
      const response = await sendMessage({ type: TTDL.MSG.GET_FAILURE_LOG });
      if (!response || !response.log || response.log.length === 0) {
        showPopupToast('No failure logs to export.', 'info');
        return;
      }

      const logText = response.log.map(entry =>
        `[${entry.timestamp}] @${entry.username} (${entry.videoId})\n  URL: ${entry.url}\n  Error: ${entry.error}\n  Retries: ${entry.retryCount}\n`
      ).join('\n');

      const blob = new Blob([logText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `ttdl-failure-log-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();

      URL.revokeObjectURL(url);
      showPopupToast('Failure log exported!', 'success');
    } catch (err) {
      showPopupToast('Failed to export log.', 'error');
    }
  }

  // ─── Messaging Utility ───────────────────────────────────────────────

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[TTDL Popup] Message error:', chrome.runtime.lastError);
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  }

  // ─── Popup Toast ─────────────────────────────────────────────────────

  function showPopupToast(message, type = 'info') {
    const existing = document.querySelector('.popup-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `popup-toast popup-toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 8px;
      left: 8px;
      right: 8px;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 500;
      z-index: 9999;
      animation: fadeIn 0.2s ease;
      text-align: center;
      ${type === 'success' ? 'background: rgba(34,197,94,0.15); color: #22c55e; border: 1px solid rgba(34,197,94,0.2);' :
        type === 'error' ? 'background: rgba(239,68,68,0.15); color: #ef4444; border: 1px solid rgba(239,68,68,0.2);' :
        type === 'warning' ? 'background: rgba(250,204,21,0.15); color: #facc15; border: 1px solid rgba(250,204,21,0.2);' :
        'background: rgba(37,244,238,0.15); color: #25f4ee; border: 1px solid rgba(37,244,238,0.2);'}
    `;

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────

  window.addEventListener('unload', () => {
    if (pollInterval) clearInterval(pollInterval);
  });

  // ─── Start ───────────────────────────────────────────────────────────

  init();
})();
