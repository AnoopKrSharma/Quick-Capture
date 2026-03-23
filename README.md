# Quick Screenshot Capture Chrome Extension

React-based Chrome extension to quickly capture multiple screenshots and export them into a single file.

## Features

- `Start Capture`: starts a session and captures the first screenshot immediately.
- `Capture`: adds another screenshot to the same session.
- `End & Download`: generates and downloads one final file in Chrome.
- Export type selection:
  - Word (`.docx`)
  - PowerPoint (`.pptx`)

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Build extension:

   ```bash
   npm run build
   ```

3. Load extension in Chrome:
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked**
   - Select this project's `dist` folder

## Usage

1. Open the page you want to capture.
2. Click the extension icon.
3. Choose export format (`Word` or `PowerPoint`).
4. Click `Start Capture` (first screenshot is captured).
5. Click `Capture` for each additional screenshot.
6. Click `End & Download` to generate and download the final file.

## Notes

- The extension captures the visible area of the current tab.
- For best results, keep the target tab active while capturing.
