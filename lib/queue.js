/**
 * TikTok Video Downloader — Download Queue Manager
 * Runs inside the background service worker.
 *
 * Uses tikwm.com public API to resolve video download URLs.
 * This is the standard approach used by production TikTok downloaders.
 */

class DownloadQueue {
  constructor() {
    this.items = [];
    this.state = TTDL.QUEUE_STATE.IDLE;
    this.activeDownloads = 0;
    this.stats = { total: 0, completed: 0, failed: 0, cancelled: 0 };
    this.settings = { ...TTDL.DEFAULTS };
    this._processing = false;
    this._downloadIds = new Map();
  }

  async init() {
    const data = await chrome.storage.local.get([TTDL.STORAGE.SETTINGS, TTDL.STORAGE.QUEUE]);
    if (data[TTDL.STORAGE.SETTINGS]) {
      this.settings = { ...TTDL.DEFAULTS, ...data[TTDL.STORAGE.SETTINGS] };
    }
    if (data[TTDL.STORAGE.QUEUE]) {
      const saved = data[TTDL.STORAGE.QUEUE];
      this.items = saved.items || [];
      this.stats = saved.stats || this.stats;
      this.items.forEach(item => {
        if (item.state === TTDL.STATE.DOWNLOADING) {
          item.state = TTDL.STATE.PENDING;
        }
      });
    }
  }

  async _persist() {
    await chrome.storage.local.set({
      [TTDL.STORAGE.QUEUE]: {
        items: this.items,
        stats: this.stats,
        state: this.state,
      },
    });
  }

  async addItems(videos) {
    const historyData = await chrome.storage.local.get(TTDL.STORAGE.DOWNLOAD_HISTORY);
    const history = new Set(historyData[TTDL.STORAGE.DOWNLOAD_HISTORY] || []);
    const existingHashes = new Set(this.items.map(i => i.hash));
    let added = 0, duplicates = 0;

    for (const video of videos) {
      const hash = TTDLUtils.hashString(video.videoUrl || video.url);
      if (history.has(hash) || existingHashes.has(hash)) { duplicates++; continue; }

      this.items.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        hash,
        url: video.url,
        videoUrl: video.videoUrl || null,
        username: video.username || TTDLUtils.extractUsername(video.url) || 'unknown',
        videoId: video.videoId || TTDLUtils.extractVideoId(video.url) || 'unknown',
        state: TTDL.STATE.PENDING,
        retryCount: 0,
        error: null,
        addedAt: TTDLUtils.timestamp(),
        completedAt: null,
      });
      existingHashes.add(hash);
      added++;
    }

    this.stats.total = this.items.filter(i => i.state !== TTDL.STATE.CANCELLED).length;
    await this._persist();
    return { added, duplicates };
  }

  async start() {
    if (this._processing) return;
    this.state = TTDL.QUEUE_STATE.RUNNING;
    this._processing = true;
    await this._processNext();
  }

  async _processNext() {
    if (this.state !== TTDL.QUEUE_STATE.RUNNING) { this._processing = false; return; }
    const pendingItems = this.items.filter(i => i.state === TTDL.STATE.PENDING);
    if (pendingItems.length === 0 && this.activeDownloads === 0) {
      this.state = TTDL.QUEUE_STATE.IDLE;
      this._processing = false;
      await this._persist();
      return;
    }

    while (this.activeDownloads < this.settings.MAX_CONCURRENT && this.state === TTDL.QUEUE_STATE.RUNNING) {
      const nextItem = this.items.find(i => i.state === TTDL.STATE.PENDING);
      if (!nextItem) break;
      this.activeDownloads++;
      nextItem.state = TTDL.STATE.DOWNLOADING;
      await this._persist();
      this._downloadItem(nextItem).catch(() => {});
      if (this.settings.INTER_DOWNLOAD_DELAY_MS > 0) {
        await TTDLUtils.delay(this.settings.INTER_DOWNLOAD_DELAY_MS);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // VIDEO URL RESOLUTION via tikwm.com API
  // ═══════════════════════════════════════════════════════════════════

  async resolveVideoUrl(pageUrl) {
    const API_BASE = 'https://tikwm.com/api/';

    try {
      console.log('[TTDL] Resolving via API:', pageUrl);

      const response = await fetch(API_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `url=${encodeURIComponent(pageUrl)}&hd=1`,
      });

      if (!response.ok) {
        throw new Error(`API returned HTTP ${response.status}`);
      }

      const json = await response.json();

      if (json.code !== 0 || !json.data) {
        throw new Error(json.msg || 'API returned an error');
      }

      const data = json.data;

      // Use H.264 'play' URL for universal compatibility
      // (hdplay uses HEVC/H.265 which needs a paid codec on Windows)
      const videoUrl = data.play || data.hdplay;

      if (!videoUrl) {
        throw new Error('API did not return a video URL');
      }

      console.log('[TTDL] Resolved HD video URL for', data.id);
      return videoUrl;
    } catch (err) {
      console.error('[TTDL] API resolution failed:', err.message);

      // Fallback: try GET method
      try {
        const fallbackUrl = `${API_BASE}?url=${encodeURIComponent(pageUrl)}&hd=1`;
        const resp = await fetch(fallbackUrl);
        const json = await resp.json();
        if (json.code === 0 && json.data) {
          return json.data.play || json.data.hdplay || null;
        }
      } catch (_) {}

      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════

  async _downloadItem(item) {
    try {
      // ── Resolve video URL if missing ─────────────────────────────
      if (!item.videoUrl) {
        console.log('[TTDL] Resolving video URL for:', item.url);
        const resolved = await this.resolveVideoUrl(item.url);
        if (resolved) {
          item.videoUrl = resolved;
          await this._persist();
        } else {
          throw new Error(
            'Could not find a downloadable video URL. The video may be protected, removed, or require login.'
          );
        }
      }

      const filename = TTDLUtils.buildFilename(this.settings.FILENAME_TEMPLATE, {
        username: item.username,
        videoId: item.videoId,
        index: this.items.indexOf(item) + 1,
      });

      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url: item.videoUrl, filename: `TikTok/${filename}`, conflictAction: 'uniquify' },
          (id) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (id === undefined) reject(new Error('Download failed to start'));
            else resolve(id);
          }
        );
      });

      this._downloadIds.set(downloadId, item.id);
      await this._waitForDownload(downloadId, item);
    } catch (err) {
      await this._handleItemFailure(item, err.message);
    }
  }

  _waitForDownload(downloadId, item) {
    return new Promise((resolve, reject) => {
      const listener = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state) {
          if (delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            this._handleItemSuccess(item).then(resolve);
          } else if (delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            this._handleItemFailure(item, delta.error?.current || 'Download interrupted').then(reject);
          }
        }
      };
      chrome.downloads.onChanged.addListener(listener);
      setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        this._handleItemFailure(item, 'Download timed out').then(reject);
      }, 5 * 60 * 1000);
    });
  }

  async _handleItemSuccess(item) {
    item.state = TTDL.STATE.COMPLETE;
    item.completedAt = TTDLUtils.timestamp();
    this.stats.completed++;
    this.activeDownloads = Math.max(0, this.activeDownloads - 1);

    const historyData = await chrome.storage.local.get(TTDL.STORAGE.DOWNLOAD_HISTORY);
    const history = historyData[TTDL.STORAGE.DOWNLOAD_HISTORY] || [];
    history.push(item.hash);
    if (history.length > 5000) history.splice(0, history.length - 5000);
    await chrome.storage.local.set({ [TTDL.STORAGE.DOWNLOAD_HISTORY]: history });

    await this._persist();
    this._processNext();
  }

  async _handleItemFailure(item, errorMsg) {
    item.retryCount = (item.retryCount || 0) + 1;
    if (item.retryCount < this.settings.RETRY_ATTEMPTS) {
      const delay = this.settings.RETRY_DELAY_MS * Math.pow(2, item.retryCount - 1);
      item.state = TTDL.STATE.PENDING;
      item.error = `Retry ${item.retryCount}/${this.settings.RETRY_ATTEMPTS}: ${errorMsg}`;
      item.videoUrl = null;
      this.activeDownloads = Math.max(0, this.activeDownloads - 1);
      await this._persist();
      await TTDLUtils.delay(delay);
      this._processNext();
    } else {
      item.state = TTDL.STATE.FAILED;
      item.error = errorMsg;
      item.completedAt = TTDLUtils.timestamp();
      this.stats.failed++;
      this.activeDownloads = Math.max(0, this.activeDownloads - 1);
      await this._logFailure(item);
      await this._persist();
      this._processNext();
    }
  }

  async _logFailure(item) {
    const data = await chrome.storage.local.get(TTDL.STORAGE.FAILURE_LOG);
    const log = data[TTDL.STORAGE.FAILURE_LOG] || [];
    log.push({
      url: item.url, videoUrl: item.videoUrl, username: item.username,
      videoId: item.videoId, error: item.error,
      timestamp: TTDLUtils.timestamp(), retryCount: item.retryCount,
    });
    if (log.length > 500) log.splice(0, log.length - 500);
    await chrome.storage.local.set({ [TTDL.STORAGE.FAILURE_LOG]: log });
  }

  async pause() {
    this.state = TTDL.QUEUE_STATE.PAUSED;
    this._processing = false;
    await this._persist();
  }

  async resume() {
    if (this.state === TTDL.QUEUE_STATE.PAUSED) {
      this.state = TTDL.QUEUE_STATE.RUNNING;
      this._processing = true;
      await this._processNext();
    }
  }

  async cancel() {
    this.state = TTDL.QUEUE_STATE.CANCELLED;
    this._processing = false;
    let cancelledCount = 0;
    this.items.forEach(item => {
      if (item.state === TTDL.STATE.PENDING || item.state === TTDL.STATE.DOWNLOADING) {
        item.state = TTDL.STATE.CANCELLED;
        cancelledCount++;
      }
    });
    this.stats.cancelled += cancelledCount;
    this.activeDownloads = 0;
    await this._persist();
  }

  async retryFailed() {
    let retriedCount = 0;
    this.items.forEach(item => {
      if (item.state === TTDL.STATE.FAILED) {
        item.state = TTDL.STATE.PENDING;
        item.retryCount = 0;
        item.error = null;
        item.videoUrl = null;
        this.stats.failed = Math.max(0, this.stats.failed - 1);
        retriedCount++;
      }
    });
    if (retriedCount > 0) {
      await this._persist();
      if (this.state !== TTDL.QUEUE_STATE.RUNNING) await this.start();
    }
    return retriedCount;
  }

  getStatus() {
    return {
      state: this.state,
      items: this.items.map(i => ({
        id: i.id, username: i.username, videoId: i.videoId,
        state: i.state, error: i.error, retryCount: i.retryCount,
      })),
      stats: {
        total: this.items.filter(i => i.state !== TTDL.STATE.CANCELLED).length,
        pending: this.items.filter(i => i.state === TTDL.STATE.PENDING).length,
        downloading: this.items.filter(i => i.state === TTDL.STATE.DOWNLOADING).length,
        completed: this.items.filter(i => i.state === TTDL.STATE.COMPLETE).length,
        failed: this.items.filter(i => i.state === TTDL.STATE.FAILED).length,
        cancelled: this.items.filter(i => i.state === TTDL.STATE.CANCELLED).length,
      },
      activeDownloads: this.activeDownloads,
    };
  }

  async clearHistory() {
    this.items = this.items.filter(i =>
      i.state !== TTDL.STATE.COMPLETE && 
      i.state !== TTDL.STATE.CANCELLED &&
      i.state !== TTDL.STATE.FAILED
    );
    this.stats = {
      total: this.items.length,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    await this._persist();
  }
}
