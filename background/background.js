/**
 * TikTok Video Downloader — Background Service Worker
 * Manages download queue, settings, and message routing.
 */

// Import shared modules (MV3 classic service worker)
importScripts('/lib/constants.js', '/lib/utils.js', '/lib/queue.js');

// ─── Initialize Queue ──────────────────────────────────────────────────

const queue = new DownloadQueue();

// Initialize on service worker start
(async () => {
  await queue.init();
  console.log('[TTDL] Background service worker initialized');
})();

// ─── Message Handler ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender, sendResponse) {
  try {
    switch (message.type) {

      // ── Single Video Download ──────────────────────────────────────
      case TTDL.MSG.DOWNLOAD_VIDEO: {
        const video = message.video;
        if (!video || !video.url) {
          sendResponse({ success: false, error: 'No video data provided.' });
          return;
        }

        // Queue the video — URL will be resolved during download if missing
        const result = await queue.addItems([video]);
        await queue.start();

        sendResponse({
          success: true,
          added: result.added,
          duplicates: result.duplicates,
        });
        break;
      }

      // ── Batch Video Download ───────────────────────────────────────
      case TTDL.MSG.DOWNLOAD_BATCH: {
        const videos = message.videos;
        if (!videos || videos.length === 0) {
          sendResponse({ success: false, error: 'No videos provided.' });
          return;
        }

        const result = await queue.addItems(videos);
        await queue.start();

        sendResponse({
          success: true,
          added: result.added,
          duplicates: result.duplicates,
        });
        break;
      }

      // ── Queue Status ───────────────────────────────────────────────
      case TTDL.MSG.GET_QUEUE_STATUS: {
        const status = queue.getStatus();
        sendResponse({ success: true, ...status });
        break;
      }

      // ── Pause Queue ────────────────────────────────────────────────
      case TTDL.MSG.PAUSE_QUEUE: {
        await queue.pause();
        sendResponse({ success: true });
        break;
      }

      // ── Resume Queue ───────────────────────────────────────────────
      case TTDL.MSG.RESUME_QUEUE: {
        await queue.resume();
        sendResponse({ success: true });
        break;
      }

      // ── Cancel Queue ───────────────────────────────────────────────
      case TTDL.MSG.CANCEL_QUEUE: {
        await queue.cancel();
        sendResponse({ success: true });
        break;
      }

      // ── Retry Failed ──────────────────────────────────────────────
      case TTDL.MSG.RETRY_FAILED: {
        const count = await queue.retryFailed();
        sendResponse({ success: true, retried: count });
        break;
      }

      // ── Get Settings ───────────────────────────────────────────────
      case TTDL.MSG.GET_SETTINGS: {
        const data = await chrome.storage.local.get(TTDL.STORAGE.SETTINGS);
        const settings = { ...TTDL.DEFAULTS, ...(data[TTDL.STORAGE.SETTINGS] || {}) };
        sendResponse({ success: true, settings });
        break;
      }

      // ── Save Settings ──────────────────────────────────────────────
      case TTDL.MSG.SAVE_SETTINGS: {
        const newSettings = message.settings;
        if (!newSettings) {
          sendResponse({ success: false, error: 'No settings provided.' });
          return;
        }

        await chrome.storage.local.set({ [TTDL.STORAGE.SETTINGS]: newSettings });
        queue.settings = { ...TTDL.DEFAULTS, ...newSettings };
        sendResponse({ success: true });
        break;
      }

      // ── Get Failure Log ────────────────────────────────────────────
      case TTDL.MSG.GET_FAILURE_LOG: {
        const logData = await chrome.storage.local.get(TTDL.STORAGE.FAILURE_LOG);
        sendResponse({
          success: true,
          log: logData[TTDL.STORAGE.FAILURE_LOG] || [],
        });
        break;
      }

      // ── Clear Failure Log ──────────────────────────────────────────
      case TTDL.MSG.CLEAR_FAILURE_LOG: {
        await chrome.storage.local.set({ [TTDL.STORAGE.FAILURE_LOG]: [] });
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown message type: ${message.type}` });
    }
  } catch (err) {
    console.error('[TTDL] Message handler error:', err);
    sendResponse({ success: false, error: err.message });
  }
}

// ─── Badge Updates ──────────────────────────────────────────────────────

// Periodically update the badge with queue status
setInterval(async () => {
  const status = queue.getStatus();
  const pendingCount = status.stats.pending + status.stats.downloading;

  if (pendingCount > 0) {
    chrome.action.setBadgeText({ text: String(pendingCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#25f4ee' });
  } else if (status.stats.failed > 0) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}, 2000);

// ─── Install / Update Handler ───────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Set default settings
    chrome.storage.local.set({
      [TTDL.STORAGE.SETTINGS]: { ...TTDL.DEFAULTS },
      [TTDL.STORAGE.DOWNLOAD_HISTORY]: [],
      [TTDL.STORAGE.FAILURE_LOG]: [],
    });

    console.log('[TTDL] Extension installed successfully');
  } else if (details.reason === 'update') {
    console.log(`[TTDL] Extension updated to version ${TTDL.VERSION}`);
  }
});
