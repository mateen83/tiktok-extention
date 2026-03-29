/**
 * TikTok Video Downloader — Content Script
 *
 * Scans TikTok pages for video links, injects download buttons,
 * and sends video info to the background for API-based URL resolution.
 */

(function () {
  'use strict';

  if (window.__ttdl_injected) return;
  window.__ttdl_injected = true;

  const SCAN_DEBOUNCE_MS = 1000;
  const BUTTON_CLASS = 'ttdl-download-btn';
  const BATCH_BUTTON_CLASS = 'ttdl-batch-btn';
  const PROCESSED_ATTR = 'data-ttdl-processed';

  let scanTimer = null;
  let observer = null;
  let foundVideos = [];

  // ─── Access Check ────────────────────────────────────────────────────

  function checkAccessRestrictions() {
    const s = TTDL.SELECTORS;
    const loginModal = document.querySelector(s.LOGIN_WALL);
    if (loginModal && loginModal.offsetParent !== null) {
      return { restricted: true, reason: 'Login required.' };
    }
    const privateIndicator = document.querySelector(s.PRIVATE_INDICATOR);
    if (privateIndicator) return { restricted: true, reason: 'Private account.' };
    const ageGate = document.querySelector(s.AGE_GATE);
    if (ageGate && ageGate.offsetParent !== null) {
      return { restricted: true, reason: 'Age-restricted.' };
    }
    return { restricted: false };
  }

  function isProfilePage() {
    return /tiktok\.com\/@[^/]+\/?(\?.*)?$/.test(window.location.href);
  }
  function isVideoPage() {
    return /tiktok\.com\/@[^/]+\/video\/\d+/.test(window.location.href);
  }

  // ─── Video Card Extraction ───────────────────────────────────────────

  function extractVideoFromCard(card) {
    const link = card.querySelector('a[href*="/video/"]') || card.closest('a[href*="/video/"]');
    if (!link) return null;
    const href = link.href;
    const videoId = TTDLUtils.extractVideoId(href);
    const username = TTDLUtils.extractUsername(href) || getPageUsername();
    if (!videoId) return null;
    return {
      url: href,
      videoUrl: null, // Resolved by background via API
      videoId,
      username,
      hash: TTDLUtils.hashString(href),
    };
  }

  function getPageUsername() {
    for (const sel of ['[data-e2e="user-title"]', '[data-e2e="user-subtitle"]', 'h1[data-e2e="user-title"]', 'h2[data-e2e="user-subtitle"]']) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.textContent.trim().replace('@', '');
        if (text) return text;
      }
    }
    return TTDLUtils.extractUsername(window.location.href) || 'unknown';
  }

  // ─── DOM Scanning ────────────────────────────────────────────────────

  function scanPage() {
    const check = checkAccessRestrictions();
    if (check.restricted) { showNotification(check.reason, 'warning'); return; }
    if (isVideoPage()) scanSingleVideoPage();
    else if (isProfilePage()) scanProfilePage();
  }

  function scanSingleVideoPage() {
    const url = window.location.href;
    const videoId = TTDLUtils.extractVideoId(url);
    const username = getPageUsername();

    const videoData = {
      url,
      videoUrl: null, // Resolved via API
      videoId: videoId || 'unknown',
      username,
      hash: TTDLUtils.hashString(url),
    };
    foundVideos = [videoData];

    const videoEl = document.querySelector('video');
    if (videoEl && !videoEl.hasAttribute(PROCESSED_ATTR)) {
      videoEl.setAttribute(PROCESSED_ATTR, 'true');
      injectSingleDownloadButton(videoEl, videoData);
    }
  }

  function scanProfilePage() {
    const cards = document.querySelectorAll(TTDL.SELECTORS.VIDEO_CARD);
    const newVideos = [];

    cards.forEach(card => {
      if (card.hasAttribute(PROCESSED_ATTR)) return;
      card.setAttribute(PROCESSED_ATTR, 'true');
      const vd = extractVideoFromCard(card);
      if (!vd) return;
      newVideos.push(vd);
      injectCardDownloadButton(card, vd);
    });

    // Also scan links outside cards
    document.querySelectorAll('a[href*="/video/"]').forEach(link => {
      if (link.hasAttribute(PROCESSED_ATTR)) return;
      const videoId = TTDLUtils.extractVideoId(link.href);
      if (!videoId) return;
      if (foundVideos.some(v => v.videoId === videoId) || newVideos.some(v => v.videoId === videoId)) return;
      link.setAttribute(PROCESSED_ATTR, 'true');
      newVideos.push({
        url: link.href,
        videoUrl: null,
        videoId,
        username: TTDLUtils.extractUsername(link.href) || getPageUsername(),
        hash: TTDLUtils.hashString(link.href),
      });
    });

    if (newVideos.length > 0) {
      foundVideos = [...foundVideos, ...newVideos];
      const seen = new Set();
      foundVideos = foundVideos.filter(v => {
        if (seen.has(v.hash)) return false;
        seen.add(v.hash); return true;
      });
    }
    if (foundVideos.length > 0) injectBatchDownloadButton();
  }

  // ─── UI Injection ────────────────────────────────────────────────────

  function injectSingleDownloadButton(videoEl, videoData) {
    const container = videoEl.closest('[class*="DivVideoContainer"], [class*="video-card"], div') || videoEl.parentElement;
    if (!container || container.querySelector(`.${BUTTON_CLASS}`)) return;
    const btn = createDownloadButton('⬇ Download HD', () => downloadSingle(videoData));
    container.style.position = container.style.position || 'relative';
    btn.style.cssText = 'position:absolute;bottom:16px;right:16px;z-index:9999';
    container.appendChild(btn);
  }

  function injectCardDownloadButton(card, videoData) {
    if (card.querySelector(`.${BUTTON_CLASS}`)) return;
    const btn = createDownloadButton('⬇', () => downloadSingle(videoData), true);
    card.style.position = card.style.position || 'relative';
    btn.style.cssText = 'position:absolute;top:8px;right:8px;z-index:9999';
    card.appendChild(btn);
  }

  function injectBatchDownloadButton() {
    if (document.querySelector(`.${BATCH_BUTTON_CLASS}`)) {
      document.querySelector(`.${BATCH_BUTTON_CLASS}`).textContent =
        `⬇ Download All (${foundVideos.length})`;
      return;
    }
    const grid = document.querySelector(
      '[data-e2e="user-post-item-list"], [class*="DivVideoFeedV2"], [class*="video-feed"]'
    );
    if (!grid) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'ttdl-batch-wrapper';
    const disclaimer = document.createElement('div');
    disclaimer.className = 'ttdl-disclaimer';
    disclaimer.textContent = TTDL.DISCLAIMER;
    const btn = document.createElement('button');
    btn.className = `${BATCH_BUTTON_CLASS} ttdl-btn ttdl-btn-batch`;
    btn.textContent = `⬇ Download All (${foundVideos.length})`;
    btn.addEventListener('click', () => downloadBatch(foundVideos));
    wrapper.appendChild(disclaimer);
    wrapper.appendChild(btn);
    grid.parentElement.insertBefore(wrapper, grid);
  }

  function createDownloadButton(text, onClick, small = false) {
    const btn = document.createElement('button');
    btn.className = `${BUTTON_CLASS} ttdl-btn ${small ? 'ttdl-btn-small' : ''}`;
    btn.textContent = text;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    return btn;
  }

  function showNotification(message, type = 'info') {
    const existing = document.querySelector('.ttdl-notification');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `ttdl-notification ttdl-notification-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('ttdl-notification-hide');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // ─── Download Actions ────────────────────────────────────────────────

  function downloadSingle(videoData) {
    showNotification('Queuing HD download...', 'info');
    chrome.runtime.sendMessage({ type: TTDL.MSG.DOWNLOAD_VIDEO, video: videoData }, (resp) => {
      if (chrome.runtime.lastError) { showNotification('Failed to queue.', 'error'); return; }
      if (resp?.success) showNotification('Download queued! Check popup for progress.', 'success');
      else showNotification(resp?.error || 'Failed.', 'error');
    });
  }

  function downloadBatch(videos) {
    if (!videos.length) { showNotification('No videos found.', 'warning'); return; }
    if (!confirm(`Download ${videos.length} HD videos?\nOnly permitted videos will be saved.`)) return;
    showNotification(`Queuing ${videos.length} videos...`, 'info');
    chrome.runtime.sendMessage({ type: TTDL.MSG.DOWNLOAD_BATCH, videos }, (resp) => {
      if (chrome.runtime.lastError) { showNotification('Failed.', 'error'); return; }
      if (resp?.success) showNotification(`Queued ${resp.added} videos. ${resp.duplicates} dupes skipped.`, 'success');
      else showNotification(resp?.error || 'Failed.', 'error');
    });
  }

  // ─── Message Listener ────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === TTDL.MSG.GET_PAGE_VIDEOS) {
      scanPage();
      sendResponse({ videos: foundVideos });
      return false;
    }
    if (message.type === TTDL.MSG.SCAN_PAGE) {
      scanPage();
      sendResponse({ count: foundVideos.length });
      return false;
    }
  });

  // ─── MutationObserver ────────────────────────────────────────────────

  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      let hasNew = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches?.('video') || node.querySelector?.('video') ||
              node.matches?.(TTDL.SELECTORS.VIDEO_CARD) || node.querySelector?.(TTDL.SELECTORS.VIDEO_CARD) ||
              node.querySelector?.('a[href*="/video/"]')) { hasNew = true; break; }
        }
        if (hasNew) break;
      }
      if (hasNew) {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => requestAnimationFrame(scanPage), SCAN_DEBOUNCE_MS);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── SPA Navigation Detection ────────────────────────────────────────

  let lastUrl = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      foundVideos = [];
      document.querySelectorAll(`.${BUTTON_CLASS}, .${BATCH_BUTTON_CLASS}, .ttdl-batch-wrapper`)
        .forEach(el => el.remove());
      document.querySelectorAll(`[${PROCESSED_ATTR}]`)
        .forEach(el => el.removeAttribute(PROCESSED_ATTR));
      setTimeout(() => requestAnimationFrame(scanPage), 1500);
    }
  }, 1000);

  // ─── Initialize ──────────────────────────────────────────────────────

  function init() {
    console.log('[TTDL] Content script v4 loaded');
    setTimeout(() => requestAnimationFrame(scanPage), 2000);
    setupObserver();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
