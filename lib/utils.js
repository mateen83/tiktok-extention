/**
 * TikTok Video Downloader — Shared Utilities
 */

const TTDLUtils = {
  /**
   * Generate a simple hash from a string for deduplication.
   * @param {string} str
   * @returns {string}
   */
  hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  },

  /**
   * Sanitize a filename by removing illegal characters.
   * @param {string} name
   * @returns {string}
   */
  sanitizeFilename(name) {
    return name
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 200); // Max reasonable filename length
  },

  /**
   * Build filename from template.
   * @param {string} template - e.g. '{username}_{date}_{index}'
   * @param {object} data - { username, date, index, videoId }
   * @returns {string}
   */
  buildFilename(template, data) {
    const now = new Date();
    const dateStr = data.date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

    let filename = template
      .replace(/\{username\}/gi, data.username || 'unknown')
      .replace(/\{date\}/gi, dateStr)
      .replace(/\{time\}/gi, timeStr)
      .replace(/\{index\}/gi, String(data.index || 0).padStart(3, '0'))
      .replace(/\{videoId\}/gi, data.videoId || 'video');

    return TTDLUtils.sanitizeFilename(filename) + '.mp4';
  },

  /**
   * Extract video ID from a TikTok URL.
   * @param {string} url
   * @returns {string|null}
   */
  extractVideoId(url) {
    try {
      const match = url.match(/\/video\/(\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  },

  /**
   * Extract username from a TikTok URL.
   * @param {string} url
   * @returns {string|null}
   */
  extractUsername(url) {
    try {
      const match = url.match(/@([^/?#]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  },

  /**
   * Delay helper for rate limiting.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  /**
   * Check if a URL looks like a valid TikTok video URL.
   * @param {string} url
   * @returns {boolean}
   */
  isValidTikTokVideoUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.includes('tiktok.com') && url.includes('/video/');
    } catch {
      return false;
    }
  },

  /**
   * Format bytes into human-readable string.
   * @param {number} bytes
   * @returns {string}
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  },

  /**
   * Create a timestamp string for logging.
   * @returns {string}
   */
  timestamp() {
    return new Date().toISOString();
  },

  /**
   * Chunk an array into smaller arrays.
   * @param {Array} array
   * @param {number} size
   * @returns {Array<Array>}
   */
  chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  },
};

// Make available globally
if (typeof globalThis !== 'undefined') {
  globalThis.TTDLUtils = TTDLUtils;
}
