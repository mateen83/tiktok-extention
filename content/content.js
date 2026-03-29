/**
 * TikTok Video Downloader — Content Script
 * Injected into TikTok pages to scan for videos and inject download buttons.
 */

(function () {
  'use strict';

  // Prevent double injection
  if (window.__ttdl_injected) return;
  window.__ttdl_injected = true;

  const SCAN_DEBOUNCE_MS = 1000;
  const BUTTON_CLASS = 'ttdl-download-btn';
  const BATCH_BUTTON_CLASS = 'ttdl-batch-btn';
  const PROCESSED_ATTR = 'data-ttdl-processed';

  let scanTimer = null;
  let observer = null;
  let foundVideos = [];

  // ─── Access Check Helpers ────────────────────────────────────────────

  /**
   * Check if the current page appears to have access restrictions.
   * @returns {{restricted: boolean, reason: string}}
   */
  function checkAccessRestrictions() {
    const selectors = TTDL.SELECTORS;

    // Check for login wall
    const loginModal = document.querySelector(selectors.LOGIN_WALL);
    if (loginModal && loginModal.offsetParent !== null) {
      return { restricted: true, reason: 'Login required to access this content.' };
    }

    // Check for private account indicator
    const privateIndicator = document.querySelector(selectors.PRIVATE_INDICATOR);
    if (privateIndicator) {
      return { restricted: true, reason: 'This account is private.' };
    }

    // Check for age gate
    const ageGate = document.querySelector(selectors.AGE_GATE);
    if (ageGate && ageGate.offsetParent !== null) {
      return { restricted: true, reason: 'Age-restricted content cannot be downloaded.' };
    }

    return { restricted: false, reason: '' };
  }

  /**
   * Check if the page is a profile/user page.
   * @returns {boolean}
   */
  function isProfilePage() {
    const url = window.location.href;
    // Profile pages match /@username pattern without /video/ in URL
    return /tiktok\.com\/@[^/]+\/?(\?.*)?$/.test(url);
  }

  /**
   * Check if the page is a single video page.
   * @returns {boolean}
   */
  function isVideoPage() {
    return /tiktok\.com\/@[^/]+\/video\/\d+/.test(window.location.href);
  }

  // ─── Video Discovery ─────────────────────────────────────────────────

  /**
   * Extract the direct video source URL from a video element.
   * @param {HTMLVideoElement} videoEl
   * @returns {string|null}
   */
  function getVideoSource(videoEl) {
    // Try direct src
    if (videoEl.src && videoEl.src.startsWith('http')) {
      return videoEl.src;
    }

    // Try source elements
    const sourceEl = videoEl.querySelector('source');
    if (sourceEl && sourceEl.src && sourceEl.src.startsWith('http')) {
      return sourceEl.src;
    }

    // Try currentSrc
    if (videoEl.currentSrc && videoEl.currentSrc.startsWith('http')) {
      return videoEl.currentSrc;
    }

    return null;
  }

  /**
   * Extract video metadata from a video card element.
   * @param {Element} card
   * @returns {object|null}
   */
  function extractVideoFromCard(card) {
    const link = card.querySelector('a[href*="/video/"]') || card.closest('a[href*="/video/"]');
    if (!link) return null;

    const href = link.href;
    const videoId = TTDLUtils.extractVideoId(href);
    const username = TTDLUtils.extractUsername(href) || getPageUsername();

    if (!videoId) return null;

    return {
      url: href,
      videoUrl: null, // Will be resolved when downloading
      videoId,
      username,
      hash: TTDLUtils.hashString(href),
    };
  }

  /**
   * Get the username from the current page.
   * @returns {string}
   */
  function getPageUsername() {
    // Try multiple selectors
    const selectors = [
      '[data-e2e="user-title"]',
      '[data-e2e="user-subtitle"]',
      'h1[data-e2e="user-title"]',
      'h2[data-e2e="user-subtitle"]',
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent.trim().replace('@', '');
        if (text) return text;
      }
    }

    // Fallback to URL
    return TTDLUtils.extractUsername(window.location.href) || 'unknown';
  }

  // ─── DOM Scanning ────────────────────────────────────────────────────

  /**
   * Scan the page for video elements and cards.
   * Uses requestAnimationFrame to avoid blocking.
   */
  function scanPage() {
    const accessCheck = checkAccessRestrictions();
    if (accessCheck.restricted) {
      console.log(`[TTDL] Access restricted: ${accessCheck.reason}`);
      showNotification(accessCheck.reason, 'warning');
      return;
    }

    if (isVideoPage()) {
      scanSingleVideoPage();
    } else if (isProfilePage()) {
      scanProfilePage();
    }
  }

  /**
   * Scan a single video page.
   */
  function scanSingleVideoPage() {
    const videoEl = document.querySelector('video');
    if (!videoEl || videoEl.hasAttribute(PROCESSED_ATTR)) return;

    const videoSource = getVideoSource(videoEl);
    const url = window.location.href;
    const videoId = TTDLUtils.extractVideoId(url);
    const username = getPageUsername();

    if (videoSource && videoId) {
      videoEl.setAttribute(PROCESSED_ATTR, 'true');

      const videoData = {
        url,
        videoUrl: videoSource,
        videoId,
        username,
        hash: TTDLUtils.hashString(url),
      };

      foundVideos = [videoData];
      injectSingleDownloadButton(videoEl, videoData);
    }
  }

  /**
   * Scan a profile page for video cards.
   */
  function scanProfilePage() {
    const cards = document.querySelectorAll(TTDL.SELECTORS.VIDEO_CARD);
    const newVideos = [];

    cards.forEach(card => {
      if (card.hasAttribute(PROCESSED_ATTR)) return;
      card.setAttribute(PROCESSED_ATTR, 'true');

      const videoData = extractVideoFromCard(card);
      if (videoData) {
        newVideos.push(videoData);
        injectCardDownloadButton(card, videoData);
      }
    });

    if (newVideos.length > 0) {
      foundVideos = [...foundVideos, ...newVideos];
      // Deduplicate by hash
      const seen = new Set();
      foundVideos = foundVideos.filter(v => {
        if (seen.has(v.hash)) return false;
        seen.add(v.hash);
        return true;
      });
    }

    // Inject batch download button if on profile and videos found
    if (foundVideos.length > 0) {
      injectBatchDownloadButton();
    }
  }

  // ─── UI Injection ────────────────────────────────────────────────────

  /**
   * Inject a download button next to a single video player.
   */
  function injectSingleDownloadButton(videoEl, videoData) {
    // Find a suitable container
    const container = videoEl.closest('[class*="DivVideoContainer"], [class*="video-card"], div') || videoEl.parentElement;
    if (!container || container.querySelector(`.${BUTTON_CLASS}`)) return;

    const btn = createDownloadButton('⬇ Download Video', () => {
      downloadSingle(videoData);
    });

    // Position relative to video container
    container.style.position = container.style.position || 'relative';
    btn.style.position = 'absolute';
    btn.style.bottom = '16px';
    btn.style.right = '16px';
    btn.style.zIndex = '9999';

    container.appendChild(btn);
  }

  /**
   * Inject a small download button on a video card in profile grid.
   */
  function injectCardDownloadButton(card, videoData) {
    if (card.querySelector(`.${BUTTON_CLASS}`)) return;

    const btn = createDownloadButton('⬇', () => {
      downloadSingle(videoData);
    }, true);

    card.style.position = card.style.position || 'relative';
    btn.style.position = 'absolute';
    btn.style.top = '8px';
    btn.style.right = '8px';
    btn.style.zIndex = '9999';

    card.appendChild(btn);
  }

  /**
   * Inject a batch download button at the top of the profile video grid.
   */
  function injectBatchDownloadButton() {
    if (document.querySelector(`.${BATCH_BUTTON_CLASS}`)) {
      // Update count
      const existing = document.querySelector(`.${BATCH_BUTTON_CLASS}`);
      existing.textContent = `⬇ Download All Permitted Videos (${foundVideos.length})`;
      return;
    }

    // Find the video grid container
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
    btn.addEventListener('click', () => {
      downloadBatch(foundVideos);
    });

    wrapper.appendChild(disclaimer);
    wrapper.appendChild(btn);

    grid.parentElement.insertBefore(wrapper, grid);
  }

  /**
   * Create a styled download button.
   */
  function createDownloadButton(text, onClick, small = false) {
    const btn = document.createElement('button');
    btn.className = `${BUTTON_CLASS} ttdl-btn ${small ? 'ttdl-btn-small' : ''}`;
    btn.textContent = text;
    btn.title = 'Download this video (only if you have permission)';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  /**
   * Show a notification toast on the page.
   */
  function showNotification(message, type = 'info') {
    const existing = document.querySelector('.ttdl-notification');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `ttdl-notification ttdl-notification-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Auto-remove after 5 seconds
    setTimeout(() => {
      toast.classList.add('ttdl-notification-hide');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // ─── Download Actions ────────────────────────────────────────────────

  /**
   * Download a single video.
   */
  function downloadSingle(videoData) {
    showNotification('Starting download...', 'info');

    chrome.runtime.sendMessage({
      type: TTDL.MSG.DOWNLOAD_VIDEO,
      video: videoData,
    }, (response) => {
      if (chrome.runtime.lastError) {
        showNotification('Failed to start download. Please try again.', 'error');
        return;
      }
      if (response && response.success) {
        showNotification('Download started!', 'success');
      } else {
        showNotification(response?.error || 'Download failed.', 'error');
      }
    });
  }

  /**
   * Download a batch of videos.
   */
  function downloadBatch(videos) {
    if (videos.length === 0) {
      showNotification('No downloadable videos found.', 'warning');
      return;
    }

    const confirmation = confirm(
      `Download ${videos.length} videos?\n\n` +
      'Note: Only videos you have permission to download will be saved. ' +
      'Videos behind login walls or from private accounts will be skipped.'
    );

    if (!confirmation) return;

    showNotification(`Queuing ${videos.length} videos for download...`, 'info');

    chrome.runtime.sendMessage({
      type: TTDL.MSG.DOWNLOAD_BATCH,
      videos: videos,
    }, (response) => {
      if (chrome.runtime.lastError) {
        showNotification('Failed to queue downloads. Please try again.', 'error');
        return;
      }
      if (response && response.success) {
        const msg = `Queued ${response.added} videos. ${response.duplicates > 0 ? `${response.duplicates} duplicates skipped.` : ''}`;
        showNotification(msg, 'success');
      } else {
        showNotification(response?.error || 'Failed to queue downloads.', 'error');
      }
    });
  }

  // ─── Message Listener ────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === TTDL.MSG.GET_PAGE_VIDEOS) {
      // Re-scan and return found videos
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

  // ─── MutationObserver for Dynamic Content ────────────────────────────

  function setupObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      let hasNewContent = false;

      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Check if new node contains video elements or video cards
              if (
                node.matches?.('video') ||
                node.querySelector?.('video') ||
                node.matches?.(TTDL.SELECTORS.VIDEO_CARD) ||
                node.querySelector?.(TTDL.SELECTORS.VIDEO_CARD)
              ) {
                hasNewContent = true;
                break;
              }
            }
          }
        }
        if (hasNewContent) break;
      }

      if (hasNewContent) {
        // Debounce rescanning
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
          requestAnimationFrame(scanPage);
        }, SCAN_DEBOUNCE_MS);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ─── URL Change Detection (SPA Navigation) ──────────────────────────

  let lastUrl = window.location.href;

  function detectUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      foundVideos = [];
      // Remove old injected elements
      document.querySelectorAll(`.${BUTTON_CLASS}, .${BATCH_BUTTON_CLASS}, .ttdl-batch-wrapper`).forEach(el => el.remove());
      // Reset processed attributes
      document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach(el => el.removeAttribute(PROCESSED_ATTR));
      // Re-scan after a short delay for DOM to update
      setTimeout(() => requestAnimationFrame(scanPage), 1500);
    }
  }

  // Poll for URL changes (SPA doesn't trigger full page loads)
  setInterval(detectUrlChange, 1000);

  // ─── Initialize ──────────────────────────────────────────────────────

  function init() {
    console.log('[TTDL] TikTok Video Downloader content script loaded');
    // Initial scan with delay for page to fully render
    setTimeout(() => {
      requestAnimationFrame(scanPage);
    }, 2000);

    setupObserver();
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
