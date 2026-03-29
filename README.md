# TikTok Video Downloader — Chrome Extension

A clean, fast, and compliant Chrome extension (Manifest V3) for downloading TikTok videos you have permission to save.

## ⚠️ Disclaimer

This extension **only** facilitates downloading videos that are:
- Publicly accessible without login
- Not protected by DRM or anti-download mechanisms  
- Your own content
- Content you have explicit permission to save

The extension does **NOT**:
- Bypass any platform protections or DRM
- Access private or restricted content
- Scrape data in violation of platform Terms of Service
- Collect or transmit any user data

---

## Features

- ✅ **Single video download** — One-click download button on video pages
- ✅ **Batch download** — Download all permitted videos on a profile page
- ✅ **Smart queue** — Pause, resume, cancel, retry failed downloads
- ✅ **Progress tracking** — Real-time progress with success/fail counts
- ✅ **Deduplication** — Prevents re-downloading the same video
- ✅ **Lazy loading** — Handles 200+ videos without UI freezing
- ✅ **Rate limiting** — Respects platform limits with configurable delays
- ✅ **Filename templates** — Customize with `{username}`, `{date}`, `{index}`, `{videoId}`
- ✅ **Failure logs** — Exportable log file for troubleshooting
- ✅ **Privacy-first** — Minimal permissions, no data collection, no tracking

---

## Installation (Development)

### Prerequisites
- Google Chrome (v88+)
- No build tools required — pure vanilla JavaScript

### Load as Unpacked Extension

1. **Clone or download** this project folder

2. **Open Chrome** and navigate to:
   ```
   chrome://extensions/
   ```

3. **Enable Developer Mode** (toggle in top-right corner)

4. Click **"Load unpacked"**

5. **Select the project folder** (`tiktok-video-downloader/`)

6. The extension icon should appear in your Chrome toolbar

7. **Pin the extension** for easy access (click the puzzle piece icon → pin)

---

## Usage

### Single Video Download
1. Navigate to a TikTok video page (e.g., `tiktok.com/@user/video/123`)
2. A download button (⬇) appears on the video
3. Click to download

### Batch Download
1. Navigate to a TikTok user's profile page (e.g., `tiktok.com/@user`)
2. Scroll to load videos you want to download
3. A "Download All Permitted Videos" button appears above the video grid
4. Click to queue all found videos for download
5. Use the popup to monitor progress

### Queue Management
- Open the popup by clicking the extension icon
- **Scan Page** — Re-scan current page for videos
- **Pause/Resume** — Control download flow
- **Cancel** — Stop all pending downloads
- **Retry Failed** — Retry all failed items
- **Export Log** — Download failure log as text file

### Settings
- Click the ⚙️ gear icon in the popup to open settings
- Configure filename templates, concurrency, retry behavior, and more

---

## Project Structure

```
tiktok-video-downloader/
├── manifest.json              # MV3 manifest configuration
├── README.md                  # This file
├── icons/                     # Extension icons (16, 48, 128px)
├── popup/                     # Popup UI
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── options/                   # Settings page
│   ├── options.html
│   ├── options.css
│   └── options.js
├── content/                   # Content script (injected into TikTok)
│   └── content.js
├── background/                # Service worker
│   └── background.js
├── styles/                    # Styles for injected elements
│   └── content.css
└── lib/                       # Shared libraries
    ├── constants.js
    ├── queue.js
    └── utils.js
```

---

## Permissions Explained

| Permission | Why? |
|---|---|
| `activeTab` | Access the current tab only when you click the extension icon |
| `downloads` | Save video files via Chrome's built-in download manager |
| `storage` | Store your settings and download history locally |
| `*://*.tiktok.com/*` | Run the content script on TikTok pages to detect videos |

**No** `cookies`, `tabs`, `webRequest`, `history`, or background network permissions.

---

## Packaging for Chrome Web Store

1. Make sure all files are clean and ready

2. Create icon files (16×16, 48×48, 128×128 PNG) in the `icons/` folder

3. Create a ZIP file of the entire project folder:
   ```bash
   # From the parent directory
   zip -r tiktok-video-downloader.zip tiktok-video-downloader/ -x "*.git*"
   ```

4. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)

5. Click "New Item" → Upload the ZIP

6. Fill in the listing details:
   - Description (include the disclaimer)
   - Screenshots
   - Category: Productivity
   - Privacy practices declaration

7. Submit for review

---

## Compliance & Limitations

- This extension operates within Chrome's Manifest V3 security model
- It only accesses publicly visible page content (HTML, video elements)
- It does **not** make any API calls to TikTok's internal APIs
- It does **not** bypass authentication, CAPTCHA, or age gates
- Videos behind private accounts, login walls, or content restrictions are skipped
- The extension displays clear disclaimers in both the popup UI and on-page elements
- Rate limiting is built in to avoid excessive API/network requests

---

## Troubleshooting

| Issue | Solution |
|---|---|
| No download button appears | Ensure you're on a TikTok video or profile page. Try refreshing. |
| Download fails immediately | The video may be protected or the URL expired. Try reloading the page. |
| "No direct URL" error | The video source couldn't be extracted. Try the on-page download button. |
| Extension not working after update | Disable and re-enable the extension in `chrome://extensions/` |
| Batch download is slow | Reduce concurrent downloads in Settings to avoid rate limiting |

---

## License

MIT License — Use responsibly and ethically.
