/**
 * TikTok Video Downloader — Shared Constants
 * Used by content scripts, background worker, and popup.
 */

const TTDL = {
  // Extension identity
  NAME: 'TikTok Video Downloader',
  VERSION: '1.0.0',

  // Message types between content script ↔ background ↔ popup
  MSG: {
    // Content → Background
    DOWNLOAD_VIDEO: 'DOWNLOAD_VIDEO',
    DOWNLOAD_BATCH: 'DOWNLOAD_BATCH',
    SCAN_PAGE: 'SCAN_PAGE',

    // Popup → Background
    GET_QUEUE_STATUS: 'GET_QUEUE_STATUS',
    PAUSE_QUEUE: 'PAUSE_QUEUE',
    RESUME_QUEUE: 'RESUME_QUEUE',
    CANCEL_QUEUE: 'CANCEL_QUEUE',
    RETRY_FAILED: 'RETRY_FAILED',
    GET_SETTINGS: 'GET_SETTINGS',
    SAVE_SETTINGS: 'SAVE_SETTINGS',
    GET_FAILURE_LOG: 'GET_FAILURE_LOG',
    CLEAR_FAILURE_LOG: 'CLEAR_FAILURE_LOG',
    CLEAR_HISTORY: 'CLEAR_HISTORY',

    // Background → Popup (via storage change or response)
    QUEUE_UPDATED: 'QUEUE_UPDATED',
    DOWNLOAD_COMPLETE: 'DOWNLOAD_COMPLETE',
    DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',

    // Content script messages
    VIDEOS_FOUND: 'VIDEOS_FOUND',
    GET_PAGE_VIDEOS: 'GET_PAGE_VIDEOS',
    RESOLVE_VIDEO_URL: 'RESOLVE_VIDEO_URL',
  },

  // Download states
  STATE: {
    PENDING: 'pending',
    DOWNLOADING: 'downloading',
    COMPLETE: 'complete',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    PAUSED: 'paused',
  },

  // Queue states
  QUEUE_STATE: {
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    CANCELLED: 'cancelled',
  },

  // Default settings
  DEFAULTS: {
    MAX_CONCURRENT: 3,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 2000,
    BATCH_CHUNK_SIZE: 20,
    INTER_DOWNLOAD_DELAY_MS: 500,
    FILENAME_TEMPLATE: '{username}_{date}_{index}',
    DARK_MODE: false,
  },

  // Storage keys
  STORAGE: {
    SETTINGS: 'ttdl_settings',
    QUEUE: 'ttdl_queue',
    DOWNLOAD_HISTORY: 'ttdl_history',
    FAILURE_LOG: 'ttdl_failures',
  },

  // Selectors for TikTok DOM scanning
  SELECTORS: {
    VIDEO_ELEMENT: 'video',
    VIDEO_CARD: '[data-e2e="user-post-item"], [class*="DivItemContainer"], [class*="video-feed-item"]',
    VIDEO_LINK: 'a[href*="/video/"]',
    USERNAME: '[data-e2e="user-title"], [data-e2e="user-subtitle"], h1[data-e2e="user-title"], h2[data-e2e="user-subtitle"]',
    PRIVATE_INDICATOR: '[data-e2e="user-lock-icon"], [class*="private"], [class*="PrivateAccount"]',
    LOGIN_WALL: '[class*="LoginModal"], [data-e2e="modal-close-inner-button"], [class*="login-modal"]',
    AGE_GATE: '[class*="age-gate"], [class*="AgeGate"]',
    PROFILE_PAGE: '[data-e2e="user-page"], [class*="UserPage"]',
  },

  // Disclaimer text
  DISCLAIMER: '⚠️ This extension only downloads videos you have permission to save. It does not bypass any platform protections, DRM, login walls, or access controls. Only use this for your own content or content you are explicitly permitted to download.',
};

// Make available in both content script and module contexts
if (typeof globalThis !== 'undefined') {
  globalThis.TTDL = TTDL;
}
