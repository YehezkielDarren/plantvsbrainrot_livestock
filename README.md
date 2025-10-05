# PVB Livestock Scraper

Small Node.js scraper that fetches the live page at `https://plantvsbrainrotstock.com/live`, extracts the list inside the container `<div class="space-y-2 ml-6">` and appends rows to `pvb_data.csv` every 5 minutes (minutes 00,05,10,...).

Prerequisites

- Node.js 18+ installed

Install

```pwsh
cd path\to\pvb_livestock
npm install
```

Run

```pwsh
npm start
```

Output

- `pvb_data.csv` (created next to `script.js`) with columns: timestamp,item,quantity,img_alt,img_src

Notes

- The script uses a simple HTTP GET. If the site requires authentication or heavy JS rendering, this approach may not work. For JS-rendered pages, consider using Playwright or Puppeteer.
- The script sets a basic User-Agent header to reduce being blocked.
