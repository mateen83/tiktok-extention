/**
 * TikTok Video Downloader — Download Queue Manager
 * Runs inside the background service worker.
 */

class DownloadQueue {
  constructor() {
    this.items = [];
    this.state = TTDL.QUEUE_STATE.IDLE;
    this.activeDownloads = 0;
    this.stats = { total: 0, completed: 0, failed: 0, cancelled: 0 };
    this.settings = { ...TTDL.DEFAULTS };
    this._processing = false;
    this._downloadIds = new Map(); // chrome download id → queue item id
  }

  /**
   * Initialize queue, loading persisted state and settings.
   */
  async init() {
    const data = await chrome.storage.local.get([TTDL.STORAGE.SETTINGS, TTDL.STORAGE.QUEUE]);

    if (data[TTDL.STORAGE.SETTINGS]) {
      this.settings = { ...TTDL.DEFAULTS, ...data[TTDL.STORAGE.SETTINGS] };
    }

    // Restore interrupted queue items
    if (data[TTDL.STORAGE.QUEUE]) {
      const saved = data[TTDL.STORAGE.QUEUE];
      this.items = saved.items || [];
      this.stats = saved.stats || this.stats;

      // Reset any items that were "downloading" (interrupted by SW restart)
      this.items.forEach(item => {
        if (item.state === TTDL.STATE.DOWNLOADING) {
          item.state = TTDL.STATE.PENDING;
          item.retryCount = (item.retryCount || 0);
        }
      });
    }
  }

  /**
   * Persist current queue state to storage.
   */
  async _persist() {
    await chrome.storage.local.set({
      [TTDL.STORAGE.QUEUE]: {
        items: this.items,
        stats: this.stats,
        state: this.state,
      },
    });
  }

  /**
   * Add items to the queue with deduplication.
   * @param {Array<{url: string, videoUrl: string, username: string, videoId: string}>} videos
   * @returns {{added: number, duplicates: number}}
   */
  async addItems(videos) {
    // Load download history for dedup
    const historyData = await chrome.storage.local.get(TTDL.STORAGE.DOWNLOAD_HISTORY);
    const history = new Set(historyData[TTDL.STORAGE.DOWNLOAD_HISTORY] || []);
    const existingHashes = new Set(this.items.map(i => i.hash));

    let added = 0;
    let duplicates = 0;

    for (const video of videos) {
      const hash = TTDLUtils.hashString(video.videoUrl || video.url);

      if (history.has(hash) || existingHashes.has(hash)) {
        duplicates++;
        continue;
      }

      this.items.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        hash,
        url: video.url,
        videoUrl: video.videoUrl,
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

    this.stats.total = this.items.filter(i =>
      i.state !== TTDL.STATE.CANCELLED
    ).length;

    await this._persist();
    return { added, duplicates };
  }

  /**
   * Start processing the queue.
   */
  async start() {
    if (this._processing) return;
    this.state = TTDL.QUEUE_STATE.RUNNING;
    this._processing = true;
    await this._processNext();
  }

  /**
   * Process pending items respecting concurrency limits.
   */
  async _processNext() {
    if (this.state !== TTDL.QUEUE_STATE.RUNNING) {
      this._processing = false;
      return;
    }

    const pendingItems = this.items.filter(i => i.state === TTDL.STATE.PENDING);

    if (pendingItems.length === 0 && this.activeDownloads === 0) {
      this.state = TTDL.QUEUE_STATE.IDLE;
      this._processing = false;
      await this._persist();
      return;
    }

    // Fill up to max concurrent slots
    while (
      this.activeDownloads < this.settings.MAX_CONCURRENT &&
      this.state === TTDL.QUEUE_STATE.RUNNING
    ) {
      const nextItem = this.items.find(i => i.state === TTDL.STATE.PENDING);
      if (!nextItem) break;

      this.activeDownloads++;
      nextItem.state = TTDL.STATE.DOWNLOADING;
      await this._persist();

      // Start download (don't await — runs concurrently)
      this._downloadItem(nextItem).catch(() => {});

      // Rate limiting delay between initiations
      if (this.settings.INTER_DOWNLOAD_DELAY_MS > 0) {
        await TTDLUtils.delay(this.settings.INTER_DOWNLOAD_DELAY_MS);
      }
    }
  }

  /**
   * Download a single item.
   * @param {object} item
   */
  async _downloadItem(item) {
    try {
      if (!item.videoUrl) {
        throw new Error('No video URL available. The video may be protected or unavailable.');
      }

      const filename = TTDLUtils.buildFilename(this.settings.FILENAME_TEMPLATE, {
        username: item.username,
        videoId: item.videoId,
        index: this.items.indexOf(item) + 1,
      });

      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          {
            url: item.videoUrl,
            filename: `TikTok/${filename}`,
            conflictAction: 'uniquify',
          },
          (id) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (id === undefined) {
              reject(new Error('Download failed to start'));
            } else {
              resolve(id);
            }
          }
        );
      });

      // Track the chrome download ID
      this._downloadIds.set(downloadId, item.id);

      // Wait for download completion
      await this._waitForDownload(downloadId, item);

    } catch (err) {
      await this._handleItemFailure(item, err.message);
    }
  }

  /**
   * Wait for a chrome download to complete.
   */
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
            const errorMsg = delta.error?.current || 'Download interrupted';
            this._handleItemFailure(item, errorMsg).then(reject);
          }
        }
      };

      chrome.downloads.onChanged.addListener(listener);

      // Timeout after 5 minutes
      setTimeout(() => {
        chrome.downloads.onChanged.removeListener(listener);
        this._handleItemFailure(item, 'Download timed out').then(reject);
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Handle successful download of an item.
   */
  async _handleItemSuccess(item) {
    item.state = TTDL.STATE.COMPLETE;
    item.completedAt = TTDLUtils.timestamp();
    this.stats.completed++;
    this.activeDownloads = Math.max(0, this.activeDownloads - 1);

    // Add to download history for dedup
    const historyData = await chrome.storage.local.get(TTDL.STORAGE.DOWNLOAD_HISTORY);
    const history = historyData[TTDL.STORAGE.DOWNLOAD_HISTORY] || [];
    history.push(item.hash);
    // Keep history manageable (last 5000 items)
    if (history.length > 5000) history.splice(0, history.length - 5000);
    await chrome.storage.local.set({ [TTDL.STORAGE.DOWNLOAD_HISTORY]: history });

    await this._persist();
    this._processNext();
  }

  /**
   * Handle failed download with retry logic.
   */
  async _handleItemFailure(item, errorMsg) {
    item.retryCount = (item.retryCount || 0) + 1;

    if (item.retryCount < this.settings.RETRY_ATTEMPTS) {
      // Retry with exponential backoff
      const delay = this.settings.RETRY_DELAY_MS * Math.pow(2, item.retryCount - 1);
      item.state = TTDL.STATE.PENDING;
      item.error = `Retry ${item.retryCount}/${this.settings.RETRY_ATTEMPTS}: ${errorMsg}`;
      this.activeDownloads = Math.max(0, this.activeDownloads - 1);
      await this._persist();
      await TTDLUtils.delay(delay);
      this._processNext();
    } else {
      // Exhausted retries
      item.state = TTDL.STATE.FAILED;
      item.error = errorMsg;
      item.completedAt = TTDLUtils.timestamp();
      this.stats.failed++;
      this.activeDownloads = Math.max(0, this.activeDownloads - 1);

      // Log failure
      await this._logFailure(item);
      await this._persist();
      this._processNext();
    }
  }

  /**
   * Log a failure for later retrieval.
   */
  async _logFailure(item) {
    const data = await chrome.storage.local.get(TTDL.STORAGE.FAILURE_LOG);
    const log = data[TTDL.STORAGE.FAILURE_LOG] || [];
    log.push({
      url: item.url,
      videoUrl: item.videoUrl,
      username: item.username,
      videoId: item.videoId,
      error: item.error,
      timestamp: TTDLUtils.timestamp(),
      retryCount: item.retryCount,
    });
    // Keep last 500 failures
    if (log.length > 500) log.splice(0, log.length - 500);
    await chrome.storage.local.set({ [TTDL.STORAGE.FAILURE_LOG]: log });
  }

  /**
   * Pause the queue.
   */
  async pause() {
    this.state = TTDL.QUEUE_STATE.PAUSED;
    this._processing = false;
    await this._persist();
  }

  /**
   * Resume the queue.
   */
  async resume() {
    if (this.state === TTDL.QUEUE_STATE.PAUSED) {
      this.state = TTDL.QUEUE_STATE.RUNNING;
      this._processing = true;
      await this._processNext();
    }
  }

  /**
   * Cancel all pending items in the queue.
   */
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

  /**
   * Retry all failed items.
   */
  async retryFailed() {
    let retriedCount = 0;

    this.items.forEach(item => {
      if (item.state === TTDL.STATE.FAILED) {
        item.state = TTDL.STATE.PENDING;
        item.retryCount = 0;
        item.error = null;
        this.stats.failed = Math.max(0, this.stats.failed - 1);
        retriedCount++;
      }
    });

    if (retriedCount > 0) {
      await this._persist();
      if (this.state !== TTDL.QUEUE_STATE.RUNNING) {
        await this.start();
      }
    }

    return retriedCount;
  }

  /**
   * Get current queue status for the popup.
   */
  getStatus() {
    return {
      state: this.state,
      items: this.items.map(i => ({
        id: i.id,
        username: i.username,
        videoId: i.videoId,
        state: i.state,
        error: i.error,
        retryCount: i.retryCount,
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

  /**
   * Clear completed and cancelled items from the queue.
   */
  async clearCompleted() {
    this.items = this.items.filter(i =>
      i.state !== TTDL.STATE.COMPLETE && i.state !== TTDL.STATE.CANCELLED
    );
    this.stats = {
      total: this.items.length,
      completed: 0,
      failed: this.items.filter(i => i.state === TTDL.STATE.FAILED).length,
      cancelled: 0,
    };
    await this._persist();
  }
}
