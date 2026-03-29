/**
 * TikTok Video Downloader — Options Page Script
 */

(function () {
  'use strict';

  // ─── DOM References ──────────────────────────────────────────────────

  const form = document.getElementById('settings-form');
  const fields = {
    filenameTemplate: document.getElementById('filename-template'),
    maxConcurrent: document.getElementById('max-concurrent'),
    retryAttempts: document.getElementById('retry-attempts'),
    retryDelay: document.getElementById('retry-delay'),
    interDelay: document.getElementById('inter-delay'),
    batchChunk: document.getElementById('batch-chunk'),
  };
  const filenamePreview = document.getElementById('filename-preview');
  const saveStatus = document.getElementById('save-status');
  const btnClearHistory = document.getElementById('btn-clear-history');
  const btnClearFailures = document.getElementById('btn-clear-failures');

  // ─── Load Settings ───────────────────────────────────────────────────

  async function loadSettings() {
    const response = await sendMessage({ type: TTDL.MSG.GET_SETTINGS });

    if (response && response.success) {
      const s = response.settings;
      fields.filenameTemplate.value = s.FILENAME_TEMPLATE || TTDL.DEFAULTS.FILENAME_TEMPLATE;
      fields.maxConcurrent.value = s.MAX_CONCURRENT || TTDL.DEFAULTS.MAX_CONCURRENT;
      fields.retryAttempts.value = s.RETRY_ATTEMPTS || TTDL.DEFAULTS.RETRY_ATTEMPTS;
      fields.retryDelay.value = s.RETRY_DELAY_MS || TTDL.DEFAULTS.RETRY_DELAY_MS;
      fields.interDelay.value = s.INTER_DOWNLOAD_DELAY_MS || TTDL.DEFAULTS.INTER_DOWNLOAD_DELAY_MS;
      fields.batchChunk.value = s.BATCH_CHUNK_SIZE || TTDL.DEFAULTS.BATCH_CHUNK_SIZE;
    }

    updateFilenamePreview();
  }

  // ─── Save Settings ───────────────────────────────────────────────────

  async function saveSettings(e) {
    e.preventDefault();

    const settings = {
      FILENAME_TEMPLATE: fields.filenameTemplate.value.trim() || TTDL.DEFAULTS.FILENAME_TEMPLATE,
      MAX_CONCURRENT: clamp(parseInt(fields.maxConcurrent.value), 1, 5),
      RETRY_ATTEMPTS: clamp(parseInt(fields.retryAttempts.value), 0, 10),
      RETRY_DELAY_MS: clamp(parseInt(fields.retryDelay.value), 500, 10000),
      INTER_DOWNLOAD_DELAY_MS: clamp(parseInt(fields.interDelay.value), 0, 5000),
      BATCH_CHUNK_SIZE: clamp(parseInt(fields.batchChunk.value), 5, 100),
    };

    const response = await sendMessage({
      type: TTDL.MSG.SAVE_SETTINGS,
      settings,
    });

    if (response && response.success) {
      showSaveStatus('Settings saved!', 'success');
    } else {
      showSaveStatus('Failed to save settings.', 'error');
    }
  }

  // ─── Filename Preview ────────────────────────────────────────────────

  function updateFilenamePreview() {
    const template = fields.filenameTemplate.value || TTDL.DEFAULTS.FILENAME_TEMPLATE;
    const preview = TTDLUtils.buildFilename(template, {
      username: 'johndoe',
      videoId: '7399012345678',
      index: 1,
    });
    filenamePreview.textContent = preview;
  }

  // ─── Data Management ─────────────────────────────────────────────────

  async function clearHistory() {
    if (!confirm('Clear all download history? This will reset deduplication tracking.')) return;

    await chrome.storage.local.set({ [TTDL.STORAGE.DOWNLOAD_HISTORY]: [] });
    showSaveStatus('Download history cleared.', 'success');
  }

  async function clearFailures() {
    if (!confirm('Clear all failure logs?')) return;

    await sendMessage({ type: TTDL.MSG.CLEAR_FAILURE_LOG });
    showSaveStatus('Failure log cleared.', 'success');
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  function clamp(val, min, max) {
    return Math.min(Math.max(isNaN(val) ? min : val, min), max);
  }

  function showSaveStatus(message, type) {
    saveStatus.textContent = message;
    saveStatus.className = `save-status save-${type}`;
    setTimeout(() => {
      saveStatus.textContent = '';
      saveStatus.className = 'save-status';
    }, 3000);
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  }

  // ─── Event Listeners ─────────────────────────────────────────────────

  form.addEventListener('submit', saveSettings);
  fields.filenameTemplate.addEventListener('input', updateFilenamePreview);
  btnClearHistory.addEventListener('click', clearHistory);
  btnClearFailures.addEventListener('click', clearFailures);

  // ─── Initialize ──────────────────────────────────────────────────────

  loadSettings();
})();
