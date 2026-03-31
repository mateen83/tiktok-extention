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
    return /tiktok\.com\/@[^/]+\/(video|photo)\/\d+/.test(window.location.href);
  }
  function isFeedPage() {
    const p = window.location.pathname;
    return p === '/' || p.startsWith('/foryou') || p.startsWith('/following') || p.startsWith('/explore');
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
    
    // Always scan For You feed reels first (URL changes to /video/ while scrolling)
    scanForYouReels();
    
    // Scan browse/detail video view (expanded video player with search bar)
    scanBrowseVideoView();
    
    if (isVideoPage()) return;
    
    scanAllVideos();
    
    if (foundVideos.length > 0) injectBatchDownloadButton();
  }

  function scanAllVideos() {
    let hasNew = false;
    
    // 1. Profile / Search Page Video Cards
    const cards = document.querySelectorAll(TTDL.SELECTORS.VIDEO_CARD);
    cards.forEach(card => {
      if (card.hasAttribute(PROCESSED_ATTR)) return;
      card.setAttribute(PROCESSED_ATTR, 'true');
      const vd = extractVideoFromCard(card);
      if (!vd) return;
      
      if (!foundVideos.some(v => v.videoId === vd.videoId)) {
        foundVideos.push(vd);
        hasNew = true;
      }
      injectCardDownloadButton(card, vd);
    });

    // 2. All <video> elements (Feed, Single Video, Explore)
    const videos = document.querySelectorAll('video');
    videos.forEach(videoEl => {
      if (videoEl.hasAttribute('data-ttdl-video-processed')) return;
      videoEl.setAttribute('data-ttdl-video-processed', 'true');

      let container = videoEl.closest('[data-e2e="recommend-list-item-container"]') || 
                      videoEl.closest('[class*="DivItemContainerFeed"]') || 
                      videoEl.closest('[class*="VideoContainer"]') ||
                      videoEl.closest('[class*="swiper-slide"]') ||
                      videoEl.parentElement;

      if (!container) return;

      let link = container.querySelector('a[href*="/video/"]');
      let url = link ? link.href : null;

      if (!url) {
        const currentUrl = window.location.href;
        if (TTDLUtils.extractVideoId(currentUrl)) {
          url = currentUrl;
        }
      }

      const videoId = TTDLUtils.extractVideoId(url || '');
      if (!url || !videoId) return;

      const vd = {
        url,
        videoUrl: null,
        videoId,
        username: TTDLUtils.extractUsername(url) || getPageUsername(),
        hash: TTDLUtils.hashString(url)
      };

      if (!foundVideos.some(v => v.videoId === vd.videoId)) {
        foundVideos.push(vd);
        hasNew = true;
      }

      injectReelDownloadButton(container, vd);
    });
  }

  // ─── For You Feed Reel Download ───────────────────────────────────────

  function scanForYouReels() {
    // Target the For You feed video players by their actual container class
    // DOM: <div class="...BasePlayerContainer...DivVideoPlayerContainer...">
    const playerContainers = document.querySelectorAll('[class*="DivVideoPlayerContainer"]');
    if (!playerContainers.length) return;

    playerContainers.forEach(pc => {
      if (pc.querySelector('.ttdl-feed-reel-btn')) return;

      // Extract video ID from xgplayer wrapper: <div id="xgwrapper-0-7616212003052473630">
      let videoId = null;
      const xgWrapper = pc.querySelector('[id^="xgwrapper-"]');
      if (xgWrapper) {
        const match = xgWrapper.id.match(/xgwrapper-\d+-(\d+)/);
        if (match) videoId = match[1];
      }
      // Fallback: try current URL
      if (!videoId) videoId = TTDLUtils.extractVideoId(window.location.href);
      if (!videoId) return;

      // Find username from the creator link inside the overlay: <a href="/@emmabbear">
      let username = 'unknown';
      const creatorLink = pc.querySelector('a[href*="/@"]');
      if (creatorLink) {
        const m = creatorLink.getAttribute('href').match(/@([^/]+)/);
        if (m) username = m[1];
      }
      if (username === 'unknown') {
        username = TTDLUtils.extractUsername(window.location.href) || 'unknown';
      }

      const url = `https://www.tiktok.com/@${username}/video/${videoId}`;
      const vd = {
        url, videoUrl: null, videoId, username,
        hash: TTDLUtils.hashString(url)
      };

      if (!foundVideos.some(v => v.videoId === vd.videoId)) {
        foundVideos.push(vd);
      }

      // Inject download button into the overlay top (alongside volume & menu buttons)
      const overlayTop = pc.querySelector('[class*="DivMediaCardOverlayTop"]');

      const btn = createDownloadButton('⬇', () => downloadSingle(vd), true);
      btn.classList.add('ttdl-feed-reel-btn');

      if (overlayTop) {
        btn.style.cssText = 'position:relative; z-index:2147483647; border: 1px solid #ff0000 !important;';
        overlayTop.appendChild(btn);
      } else {
        // Fallback: absolute position on the player container
        pc.style.position = pc.style.position || 'relative';
        btn.style.cssText = 'position:absolute;top:12px;right:12px;z-index:2147483647; border: 1px solid #ff0000 !important;';
        pc.appendChild(btn);
      }
    });
  }

  // ─── Browse/Detail Video View Download ─────────────────────────────────

  function scanBrowseVideoView() {
    // Target the browse video detail view: <div class="...DivVideoContainer...">
    // This has a search bar on top, close button, prev/next arrows
    const videoContainers = document.querySelectorAll('[class*="DivVideoContainer"]');
    if (!videoContainers.length) return;

    videoContainers.forEach(vc => {
      // Only target browse view (has search bar or close button)
      const searchBar = vc.querySelector('[class*="DivSearchBarContainer"]');
      const closeBtn = vc.querySelector('button[data-e2e="browse-close"]');
      if (!searchBar && !closeBtn) return;

      if (vc.querySelector('.ttdl-browse-dl-btn')) return;

      // Extract video ID from the xgplayer wrapper: <div id="xgwrapper-2-7619755989801241857">
      let videoId = null;
      const xgWrappers = vc.querySelectorAll('[id^="xgwrapper-"]');
      for (const xgw of xgWrappers) {
        const match = xgw.id.match(/xgwrapper-\d+-(\d+)/);
        if (match) { videoId = match[1]; break; }
      }
      if (!videoId) videoId = TTDLUtils.extractVideoId(window.location.href);
      if (!videoId) return;

      let username = TTDLUtils.extractUsername(window.location.href) || 'unknown';

      const url = `https://www.tiktok.com/@${username}/video/${videoId}`;
      const vd = {
        url, videoUrl: null, videoId, username,
        hash: TTDLUtils.hashString(url)
      };

      if (!foundVideos.some(v => v.videoId === vd.videoId)) {
        foundVideos.push(vd);
      }

      // Inject download button into the search bar area
      const btn = createDownloadButton('⬇', () => downloadSingle(vd), true);
      btn.classList.add('ttdl-browse-dl-btn');

      if (searchBar) {
        // Place it inside the search bar container, to the right
        btn.style.cssText = 'position: absolute; right: 12px; top: 50%; transform: translateY(-50%); z-index: 9999; border: 1px solid #ff0000 !important; background: rgba(37, 244, 238, 0.85) !important; color: #000 !important; border-radius: 8px; padding: 6px 10px;';
        searchBar.style.position = searchBar.style.position || 'relative';
        searchBar.appendChild(btn);
      } else {
        // Fallback: top-right of the video container
        vc.style.position = vc.style.position || 'relative';
        btn.style.cssText = 'position:absolute;top:12px;right:50px;z-index:9999; border: 1px solid #ff0000 !important;';
        vc.appendChild(btn);
      }
    });
  }

  function injectReelDownloadButton(container, videoData) {
     if (container.querySelector(`.${BUTTON_CLASS}`) || container.querySelector('.ttdl-reel-btn')) return;

     const btn = createDownloadButton('⬇ HD', () => downloadSingle(videoData));
     btn.classList.add('ttdl-reel-btn');

     const actionBar = container.querySelector('[class*="ActionItemContainer"], [class*="DivActionItemContainer"], [data-e2e="video-share-tooltip"]');
     
     if (actionBar && actionBar.parentElement) {
         actionBar.parentElement.appendChild(btn);
         btn.style.cssText = 'margin-top: 16px; transform: scale(1.1); font-size: 14px; padding: 10px; border-radius: 50%; width: 44px; height: 44px; display: flex; justify-content: center; align-items: center; background: rgba(37,244,238,0.9); color: black; box-shadow: 0 4px 12px rgba(0,0,0,0.5); cursor: pointer; border: none;';
         btn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
     } else {
         container.style.position = container.style.position || 'relative';
         btn.style.cssText = 'position: absolute; right: 20px; bottom: 120px; z-index: 2147483647; background: rgba(37,244,238,0.9); padding: 12px 16px; border-radius: 8px; font-weight: bold; color: black; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.5); border: none;';
         container.appendChild(btn);
     }
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
    if (!isProfilePage()) return; // ONLY show on Profile pages

    let wrapper = document.querySelector('.ttdl-batch-wrapper');
    if (wrapper) {
      if (wrapper.dataset.closed === 'true') return;
      const btn = wrapper.querySelector(`.${BATCH_BUTTON_CLASS}`);
      if (btn) btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:0px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>Download All (${foundVideos.length})`;
      return;
    }
    
    wrapper = document.createElement('div');
    wrapper.className = 'ttdl-batch-wrapper';
    
    const headerRow = document.createElement('div');
    headerRow.style.display = 'flex';
    headerRow.style.justifyContent = 'space-between';
    headerRow.style.width = '100%';
    headerRow.style.alignItems = 'flex-start';

    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    
    const closeBtn = document.createElement('div');
    closeBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.padding = '0px';
    closeBtn.style.color = 'rgba(255, 255, 255, 0.7)';
    closeBtn.style.transition = 'color 0.2s';
    closeBtn.setAttribute('title', 'Close');
    closeBtn.addEventListener('mouseenter', () => closeBtn.style.color = '#fff');
    closeBtn.addEventListener('mouseleave', () => closeBtn.style.color = 'rgba(255, 255, 255, 0.7)');
    closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        wrapper.style.display = 'none';
        wrapper.dataset.closed = 'true';
    });

    headerRow.appendChild(spacer);
    headerRow.appendChild(closeBtn);
    
    const controls = document.createElement('div');
    controls.className = 'ttdl-batch-controls';

    const btnScan = document.createElement('button');
    btnScan.className = 'ttdl-btn ttdl-btn-scan';
    const originalScanHtml = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:0px"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>Rescan Page`;
    btnScan.innerHTML = originalScanHtml;
    btnScan.style.display = 'flex';
    btnScan.style.alignItems = 'center';
    btnScan.addEventListener('click', (e) => {
        e.preventDefault();
        if (btnScan.disabled) return;
        btnScan.disabled = true;
        btnScan.innerHTML = `<svg class="ttdl-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>Scanning...`;
        btnScan.style.opacity = '0.7';
        
        if (!document.getElementById('ttdl-spin-style')) {
            const style = document.createElement('style');
            style.id = 'ttdl-spin-style';
            style.textContent = `@keyframes ttdl-spin { 100% { transform: rotate(360deg); } } .ttdl-spin { animation: ttdl-spin 1s linear infinite; margin-right: 4px; }`;
            document.head.appendChild(style);
        }

        setTimeout(() => {
            scanPage();
            btnScan.innerHTML = originalScanHtml;
            btnScan.style.opacity = '1';
            btnScan.disabled = false;
        }, 3000);
    });

    const btn = document.createElement('button');
    btn.className = `${BATCH_BUTTON_CLASS} ttdl-btn ttdl-btn-batch`;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:0px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>Download All (${foundVideos.length})`;
    btn.style.display = 'flex';
    btn.style.alignItems = 'center';
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        downloadBatch(foundVideos);
    });
    
    controls.appendChild(btnScan);
    controls.appendChild(btn);

    wrapper.appendChild(headerRow);
    wrapper.appendChild(controls);

    document.body.appendChild(wrapper);
  }

  function createDownloadButton(htmlContent, onClick, small = false) {
    const btn = document.createElement('button');
    btn.className = `${BUTTON_CLASS} ttdl-btn ${small ? 'ttdl-btn-small' : ''}`;
    
    if (htmlContent.includes('⬇')) {
        htmlContent = htmlContent.replace('⬇', `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:0px; vertical-align: middle;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`);
    }
    
    btn.innerHTML = htmlContent;
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
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
      document.querySelectorAll(`.${BUTTON_CLASS}, .${BATCH_BUTTON_CLASS}, .ttdl-batch-wrapper, .ttdl-feed-reel-btn, .ttdl-browse-dl-btn`)
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
