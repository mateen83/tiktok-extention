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
  // VIDEO URL RESOLUTION — fetches the TikTok page to find the real
  // video CDN URL from the embedded hydration data.
  // ═══════════════════════════════════════════════════════════════════

  async resolveVideoUrl(pageUrl) {
    try {
      const response = await fetch(pageUrl, {
        credentials: 'include',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();

      // Pattern 1: __UNIVERSAL_DATA_FOR_REHYDRATION__ (modern TikTok 2024+)
      const universalMatch = html.match(
        /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
      );
      if (universalMatch) {
        try {
          const data = JSON.parse(universalMatch[1]);
          const scope = data?.__DEFAULT_SCOPE__ || {};
          const itemStruct = scope['webapp.video-detail']?.itemInfo?.itemStruct;
          if (itemStruct?.video) {
            const v = itemStruct.video;
            const url = v.downloadAddr || v.playAddr
              || v.bitrateInfo?.[0]?.PlayAddr?.UrlList?.[0];
            if (url) return this._decodeVideoUrl(url);
          }
        } catch (_) { /* continue */ }
      }

      // Pattern 2: SIGI_STATE (older TikTok)
      const sigiMatch = html.match(
        /<script\s+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/
      );
      if (sigiMatch) {
        try {
          const data = JSON.parse(sigiMatch[1]);
          const videoId = TTDLUtils.extractVideoId(pageUrl);
          const item = data?.ItemModule?.[videoId];
          if (item?.video) {
            const url = item.video.downloadAddr || item.video.playAddr;
            if (url) return this._decodeVideoUrl(url);
          }
        } catch (_) { /* continue */ }
      }

      // Pattern 3: Regex scan for playAddr / downloadAddr in any JSON block
      const addrMatch = html.match(/"(?:downloadAddr|playAddr)"\s*:\s*"(https?:[^"]+)"/);
      if (addrMatch?.[1]) return this._decodeVideoUrl(addrMatch[1]);

      // Pattern 4: Direct CDN URL match
      const cdnPatterns = [
        /https?:\/\/v\d+-webapp[^"'\s\\]*\.mp4[^"'\s\\]*/,
        /https?:\/\/[^"'\s\\]*tiktokcdn\.com[^"'\s\\]*\.mp4[^"'\s\\]*/,
      ];
      for (const p of cdnPatterns) {
        const m = html.match(p);
        if (m?.[0]) return this._decodeVideoUrl(m[0]);
      }

      return null;
    } catch (err) {
      console.error('[TTDL] resolveVideoUrl error:', err);
      return null;
    }
  }

  _decodeVideoUrl(url) {
    if (!url) return null;
    url = url.replace(/\\u([\dA-Fa-f]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
    url = url.replace(/&amp;/g, '&');
    url = url.replace(/\\\//g, '/');
    return url;
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
      item.videoUrl = null; // Clear so it resolves again on retry
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
        item.videoUrl = null; // Re-resolve on retry
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

  async clearCompleted() {
    this.items = this.items.filter(i =>
      i.state !== TTDL.STATE.COMPLETE && i.state !== TTDL.STATE.CANCELLED
    );
    this.stats = {
      total: this.items.length, completed: 0,
      failed: this.items.filter(i => i.state === TTDL.STATE.FAILED).length,
      cancelled: 0,
    };
    await this._persist();
  }
}
