/**
 * TikTok Video Downloader — Content Script
 * Injected into TikTok pages to scan for videos and inject download buttons.
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

  // ─── Hydration Data Extraction ────────────────────────────────────

  /**
   * Parse TikTok's embedded JSON data from script tags.
   */
  function extractHydrationData() {
    const ids = [
      '__UNIVERSAL_DATA_FOR_REHYDRATION__',
      'SIGI_STATE',
      '__NEXT_DATA__',
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) {
        try { return { id, data: JSON.parse(el.textContent) }; }
        catch (_) { continue; }
      }
    }
    return null;
  }

  /**
   * Decode TikTok's encoded video URLs.
   */
  function decodeUrl(url) {
    if (!url) return null;
    url = url.replace(/\\u([\dA-Fa-f]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
    url = url.replace(/&amp;/g, '&').replace(/\\\//g, '/');
    return url;
  }

  /**
   * Extract video URL from hydration data for a single video page.
   */
  function getVideoUrlFromHydration(videoId) {
    const result = extractHydrationData();
    if (!result) return null;
    const { id, data } = result;

    try {
      if (id === '__UNIVERSAL_DATA_FOR_REHYDRATION__') {
        const scope = data?.__DEFAULT_SCOPE__ || {};
        const itemStruct = scope['webapp.video-detail']?.itemInfo?.itemStruct;
        if (itemStruct?.video) {
          const v = itemStruct.video;
          return decodeUrl(v.downloadAddr || v.playAddr
            || v.bitrateInfo?.[0]?.PlayAddr?.UrlList?.[0]);
        }
      }

      if (id === 'SIGI_STATE') {
        const item = data?.ItemModule?.[videoId];
        if (item?.video) {
          return decodeUrl(item.video.downloadAddr || item.video.playAddr);
        }
      }
    } catch (_) { /* fallthrough */ }

    return null;
  }

  /**
   * Extract all video items from hydration data (profile pages).
   */
  function getProfileVideosFromHydration() {
    const result = extractHydrationData();
    if (!result) return [];
    const { id, data } = result;
    const videos = [];

    try {
      if (id === 'SIGI_STATE' && data?.ItemModule) {
        for (const [vid, item] of Object.entries(data.ItemModule)) {
          const author = typeof item.author === 'string'
            ? item.author
            : item.author?.uniqueId || 'unknown';
          videos.push({
            url: `https://www.tiktok.com/@${author}/video/${vid}`,
            videoUrl: decodeUrl(item.video?.downloadAddr || item.video?.playAddr),
            videoId: vid,
            username: author,
            hash: TTDLUtils.hashString(vid),
          });
        }
      }

      if (id === '__UNIVERSAL_DATA_FOR_REHYDRATION__') {
        const scope = data?.__DEFAULT_SCOPE__ || {};
        // Try to find video list in user post data
        for (const [key, val] of Object.entries(scope)) {
          const list = val?.videoList || val?.itemList || val?.list;
          if (Array.isArray(list)) {
            for (const item of list) {
              if (!item?.video) continue;
              const author = item.author?.uniqueId || getPageUsername();
              const vid = item.id || item.video?.id;
              if (!vid) continue;
              videos.push({
                url: `https://www.tiktok.com/@${author}/video/${vid}`,
                videoUrl: decodeUrl(item.video.downloadAddr || item.video.playAddr),
                videoId: vid,
                username: author,
                hash: TTDLUtils.hashString(vid),
              });
            }
          }
        }
      }
    } catch (_) { /* fallthrough */ }

    return videos;
  }

  // ─── Access Check Helpers ────────────────────────────────────────────

  function checkAccessRestrictions() {
    const s = TTDL.SELECTORS;
    const loginModal = document.querySelector(s.LOGIN_WALL);
    if (loginModal && loginModal.offsetParent !== null) {
      return { restricted: true, reason: 'Login required to access this content.' };
    }
    const privateIndicator = document.querySelector(s.PRIVATE_INDICATOR);
    if (privateIndicator) {
      return { restricted: true, reason: 'This account is private.' };
    }
    const ageGate = document.querySelector(s.AGE_GATE);
    if (ageGate && ageGate.offsetParent !== null) {
      return { restricted: true, reason: 'Age-restricted content cannot be downloaded.' };
    }
    return { restricted: false, reason: '' };
  }

  function isProfilePage() {
    return /tiktok\.com\/@[^/]+\/?(\?.*)?$/.test(window.location.href);
  }

  function isVideoPage() {
    return /tiktok\.com\/@[^/]+\/video\/\d+/.test(window.location.href);
  }

  // ─── Video Discovery ─────────────────────────────────────────────────

  function getVideoSource(videoEl) {
    // Skip blob URLs — they're MSE streams, useless for downloading
    if (videoEl.src && videoEl.src.startsWith('http') && !videoEl.src.startsWith('blob:')) {
      return videoEl.src;
    }
    const sourceEl = videoEl.querySelector('source');
    if (sourceEl?.src && sourceEl.src.startsWith('http') && !sourceEl.src.startsWith('blob:')) {
      return sourceEl.src;
    }
    if (videoEl.currentSrc && videoEl.currentSrc.startsWith('http') && !videoEl.currentSrc.startsWith('blob:')) {
      return videoEl.currentSrc;
    }
    return null;
  }

  function extractVideoFromCard(card) {
    const link = card.querySelector('a[href*="/video/"]') || card.closest('a[href*="/video/"]');
    if (!link) return null;
    const href = link.href;
    const videoId = TTDLUtils.extractVideoId(href);
    const username = TTDLUtils.extractUsername(href) || getPageUsername();
    if (!videoId) return null;
    return {
      url: href,
      videoUrl: null, // Will be resolved by background
      videoId,
      username,
      hash: TTDLUtils.hashString(href),
    };
  }

  function getPageUsername() {
    for (const sel of ['[data-e2e="user-title"]', '[data-e2e="user-subtitle"]', 'h1[data-e2e="user-title"]']) {
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
    const accessCheck = checkAccessRestrictions();
    if (accessCheck.restricted) {
      showNotification(accessCheck.reason, 'warning');
      return;
    }
    if (isVideoPage()) scanSingleVideoPage();
    else if (isProfilePage()) scanProfilePage();
  }

  function scanSingleVideoPage() {
    const url = window.location.href;
    const videoId = TTDLUtils.extractVideoId(url);
    const username = getPageUsername();

    // Try hydration data first (most reliable)
    let videoSource = getVideoUrlFromHydration(videoId);

    // Fallback to DOM <video> element
    if (!videoSource) {
      const videoEl = document.querySelector('video');
      if (videoEl) videoSource = getVideoSource(videoEl);
    }

    const videoData = {
      url,
      videoUrl: videoSource || null, // null is OK — background will resolve
      videoId: videoId || 'unknown',
      username,
      hash: TTDLUtils.hashString(url),
    };

    foundVideos = [videoData];

    // Inject button on the video element
    const videoEl = document.querySelector('video');
    if (videoEl && !videoEl.hasAttribute(PROCESSED_ATTR)) {
      videoEl.setAttribute(PROCESSED_ATTR, 'true');
      injectSingleDownloadButton(videoEl, videoData);
    }
  }

  function scanProfilePage() {
    // First, try to get videos from hydration data
    const hydrationVideos = getProfileVideosFromHydration();
    const hydrationMap = new Map();
    hydrationVideos.forEach(v => hydrationMap.set(v.videoId, v));

    // Then scan DOM for video cards (catches dynamically loaded ones too)
    const cards = document.querySelectorAll(TTDL.SELECTORS.VIDEO_CARD);
    const newVideos = [];

    cards.forEach(card => {
      if (card.hasAttribute(PROCESSED_ATTR)) return;
      card.setAttribute(PROCESSED_ATTR, 'true');

      const videoData = extractVideoFromCard(card);
      if (!videoData) return;

      // Merge with hydration data if available
      const hydrationMatch = hydrationMap.get(videoData.videoId);
      if (hydrationMatch?.videoUrl) {
        videoData.videoUrl = hydrationMatch.videoUrl;
      }

      newVideos.push(videoData);
      injectCardDownloadButton(card, videoData);
    });

    // Also scan for video links not inside cards
    const allLinks = document.querySelectorAll('a[href*="/video/"]');
    allLinks.forEach(link => {
      if (link.hasAttribute(PROCESSED_ATTR)) return;
      const videoId = TTDLUtils.extractVideoId(link.href);
      if (!videoId) return;
      // Check if already found
      if (foundVideos.some(v => v.videoId === videoId) || newVideos.some(v => v.videoId === videoId)) return;
      link.setAttribute(PROCESSED_ATTR, 'true');
      const hydrationMatch = hydrationMap.get(videoId);
      newVideos.push({
        url: link.href,
        videoUrl: hydrationMatch?.videoUrl || null,
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
        seen.add(v.hash);
        return true;
      });
    }

    if (foundVideos.length > 0) injectBatchDownloadButton();
  }

  // ─── UI Injection ────────────────────────────────────────────────────

  function injectSingleDownloadButton(videoEl, videoData) {
    const container = videoEl.closest('[class*="DivVideoContainer"], [class*="video-card"], div') || videoEl.parentElement;
    if (!container || container.querySelector(`.${BUTTON_CLASS}`)) return;

    const btn = createDownloadButton('⬇ Download Video', () => downloadSingle(videoData));
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
        `⬇ Download All Permitted Videos (${foundVideos.length})`;
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
    btn.textContent = `⬇ Download All Permitted Videos (${foundVideos.length})`;
    btn.addEventListener('click', () => downloadBatch(foundVideos));

    wrapper.appendChild(disclaimer);
    wrapper.appendChild(btn);
    grid.parentElement.insertBefore(wrapper, grid);
  }

  function createDownloadButton(text, onClick, small = false) {
    const btn = document.createElement('button');
    btn.className = `${BUTTON_CLASS} ttdl-btn ${small ? 'ttdl-btn-small' : ''}`;
    btn.textContent = text;
    btn.title = 'Download this video (only if you have permission)';
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
    showNotification('Starting download...', 'info');
    chrome.runtime.sendMessage({ type: TTDL.MSG.DOWNLOAD_VIDEO, video: videoData }, (response) => {
      if (chrome.runtime.lastError) {
        showNotification('Failed to start download. Please try again.', 'error');
        return;
      }
      if (response?.success) showNotification('Download queued! Check popup for progress.', 'success');
      else showNotification(response?.error || 'Download failed.', 'error');
    });
  }

  function downloadBatch(videos) {
    if (videos.length === 0) { showNotification('No downloadable videos found.', 'warning'); return; }
    const ok = confirm(
      `Download ${videos.length} videos?\n\nNote: Only videos you have permission to download will be saved.`
    );
    if (!ok) return;

    showNotification(`Queuing ${videos.length} videos for download...`, 'info');
    chrome.runtime.sendMessage({ type: TTDL.MSG.DOWNLOAD_BATCH, videos }, (response) => {
      if (chrome.runtime.lastError) {
        showNotification('Failed to queue downloads.', 'error');
        return;
      }
      if (response?.success) {
        const msg = `Queued ${response.added} videos. ${response.duplicates > 0 ? `${response.duplicates} duplicates skipped.` : ''}`;
        showNotification(msg, 'success');
      } else showNotification(response?.error || 'Failed to queue downloads.', 'error');
    });
  }

  // ─── Message Listener ────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === TTDL.MSG.GET_PAGE_VIDEOS) {
      scanPage();
      sendResponse({ videos: foundVideos });
      return true;
    }
    if (message.type === TTDL.MSG.SCAN_PAGE) {
      scanPage();
      sendResponse({ count: foundVideos.length });
      return true;
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
              node.querySelector?.('a[href*="/video/"]')) {
            hasNew = true; break;
          }
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
    console.log('[TTDL] Content script loaded');
    setTimeout(() => requestAnimationFrame(scanPage), 2000);
    setupObserver();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
