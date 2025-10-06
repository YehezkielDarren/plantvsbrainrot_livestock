const axios = require("axios");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

// Config
const API_URL =
  process.env.PVB_API_URL ||
  "https://plantsvsbrainrots.com/api/latest-message?channel=stock";
const OUTPUT_CSV = path.join(__dirname, "pvb_data.csv");

function ensureHeader() {
  if (!fs.existsSync(OUTPUT_CSV)) {
    fs.writeFileSync(
      OUTPUT_CSV,
      "timestamp,item,quantity,img_alt,img_src\n",
      "utf8"
    );
  }
}

// parse lines like '<:pumpkinseed:1423291532085035018> Pumpkin x2'
function parseEmbedDescription(desc) {
  const lines = desc
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const seeds = [];
  let inSeeds = false;
  for (const line of lines) {
    if (/^\*\*Seeds\*\*/i.test(line) || /^SEEDS/i.test(line)) {
      inSeeds = true;
      continue;
    }
    if (/^\*\*Gear\*\*/i.test(line) || /^GEAR/i.test(line)) {
      inSeeds = false;
    }
    if (!inSeeds) continue;
    // match custom emoji syntax <:name:id>
    const m = line.match(/<:([^:>]+):(\d+)>\s*(.+)$/);
    if (m) {
      const alt = m[1];
      const id = m[2];
      const rest = m[3];
      const pq = rest.match(/(.+?)\s*[x×]\s*(\d+)/i);
      if (pq) {
        const item = pq[1].trim();
        const qty = pq[2];
        const img = `https://cdn.discordapp.com/emojis/${id}.png`;
        seeds.push({ item, qty, img_alt: alt, img_src: img });
      }
    } else {
      // fallback: 'Pumpkin x2' plain
      const pq = line.match(/(.+?)\s*[x×]\s*(\d+)/i);
      if (pq) {
        seeds.push({
          item: pq[1].trim(),
          qty: pq[2],
          img_alt: "",
          img_src: "",
        });
      }
    }
  }
  return seeds;
}

async function fetchLatest() {
  const res = await axios.get(API_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (scraper)" },
    timeout: 15000,
  });
  return res.data;
}

async function scrapeOnce() {
  try {
    const data = await fetchLatest();
    if (!Array.isArray(data) || data.length === 0) {
      console.warn("API returned no messages");
      return;
    }
    // pick the message with the newest timestamp (robust against unsorted API)
    function getMsgDate(m) {
      if (!m) return null;

      // Prioritize createdAt fields first
      const priorityFields = [
        m.createdAt,
        m.created_at,
        m.timestamp,
        m.ts,
        m.created,
        m.published_at,
        m.time,
      ];

      // Check embeds for timestamp
      try {
        if (m.embeds && Array.isArray(m.embeds) && m.embeds.length) {
          priorityFields.unshift(m.embeds[0].createdAt);
          priorityFields.unshift(m.embeds[0].created_at);
          priorityFields.unshift(m.embeds[0].timestamp);
        }
      } catch (e) {}

      for (const raw of priorityFields) {
        if (raw === undefined || raw === null) continue;

        let d = null;
        if (typeof raw === "number" || /^[0-9]+$/.test(String(raw))) {
          const n = Number(raw);
          // Handle both milliseconds and seconds epoch
          d = new Date(n > 1e12 ? n : n * 1000);
        } else if (typeof raw === "string") {
          // Handle ISO string or other formats
          d = new Date(raw);
        }

        if (d instanceof Date && !isNaN(d.getTime())) {
          console.log(`Parsed timestamp: ${raw} -> ${d.toISOString()}`);
          return d;
        }
      }
      return null;
    }

    let msg = null;
    let maxTime = -Infinity;

    console.log(`Processing ${data.length} messages from API`);

    for (let i = 0; i < data.length; i++) {
      const m = data[i];
      const d = getMsgDate(m);

      if (d && d.getTime() > maxTime) {
        maxTime = d.getTime();
        msg = m;
        console.log(
          `New latest message found at index ${i}: ${d.toISOString()}`
        );
      }
    }

    // fallback to first element if none had parseable timestamp
    if (!msg) {
      msg = data[0];
      console.log("No parseable timestamps found, using first message");
    }

    // debug: log selection info
    try {
      const chosenDate = getMsgDate(msg) || new Date();
      console.log(
        `Final chosen message timestamp: ${chosenDate.toISOString()}`
      );
    } catch (e) {
      console.error("Error getting chosen date:", e.message);
    }
    if (
      !msg ||
      !msg.embeds ||
      !Array.isArray(msg.embeds) ||
      msg.embeds.length === 0
    ) {
      console.warn("No embeds in API message");
      return;
    }
    const desc = msg.embeds[0].description || "";
    const seeds = parseEmbedDescription(desc);
    if (!seeds || seeds.length === 0) {
      console.log("No seeds parsed from embed");
      return;
    }
    // Use the already determined msgDate from getMsgDate function
    const msgDate = getMsgDate(msg);
    if (!msgDate) {
      console.log("Could not determine message timestamp, using current time");
      msgDate = new Date();
    }
    const ts = msgDate.toISOString();

    console.log(`Processing message with timestamp: ${ts}`);

    // Read last saved timestamp from CSV (last non-header line)
    let lastSavedTs = null;
    if (fs.existsSync(OUTPUT_CSV)) {
      const existing = fs.readFileSync(OUTPUT_CSV, "utf8").trim();
      if (existing) {
        const lines = existing.split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i].trim();
          if (!l) continue;
          if (/^timestamp,/i.test(l)) continue; // header line
          const firstCol = l.split(",")[0].replace(/^"|"$/g, "");
          if (firstCol) {
            lastSavedTs = firstCol;
            break;
          }
        }
      }
    }

    if (lastSavedTs) {
      const lastDate = new Date(lastSavedTs);
      console.log(`Last saved timestamp: ${lastSavedTs}`);
      console.log(`Current message timestamp: ${ts}`);

      if (!isNaN(lastDate.getTime())) {
        const timeDiff = msgDate.getTime() - lastDate.getTime();
        console.log(`Time difference: ${timeDiff}ms (${timeDiff / 1000}s)`);

        if (timeDiff <= 0) {
          console.log(
            `Message timestamp ${ts} is not newer than last saved ${lastSavedTs}; skipping`
          );
          return;
        }
      }
    } else {
      console.log("No previous timestamp found, will save new data");
    }

    const esc = (s) => String(s || "").replace(/"/g, '""');
    const specialItems = [
      "Tomatrio",
      "Shroombino",
      "Mr Carrot",
      "Mango",
      "Carnivorous Plant",
      "Cocotank",
    ];

    const lines =
      seeds
        .map((s) => {
          if (specialItems.includes(s.item)) {
            // Special handling for specific items
            return `${ts},"${esc(s.item) + "@"}",${esc(s.qty)},"${esc(
              s.img_alt
            )}","${esc(s.img_src)}"`;
          } else {
            return `${ts},"${esc(s.item)}",${esc(s.qty)},"${esc(
              s.img_alt
            )}","${esc(s.img_src)}"`;
          }
        })
        .join("\n") + "\n";
    fs.appendFileSync(OUTPUT_CSV, lines, "utf8");
    console.log(
      `[${new Date().toLocaleString()}] Saved ${
        seeds.length
      } seed rows to ${OUTPUT_CSV} (ts=${ts})`
    );
  } catch (err) {
    console.error("Scrape failed:", err && err.message ? err.message : err);
  }
}

// Function to calculate next stock refresh time + 45 seconds
function getNextStockRefreshTime() {
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();

  // Stock refreshes every 5 minutes at :00, :05, :10, :15, etc.
  // We want to run 45 seconds after that: :00:45, :05:45, :10:45, :15:45, etc.
  const nextRefreshMinute = Math.floor(minutes / 5) * 5 + 5;
  const targetMinute = nextRefreshMinute % 60;

  const nextRun = new Date(now);
  nextRun.setMinutes(targetMinute, 10, 0); // Set to target minute, 45 seconds

  // If target time has passed in current hour, move to next hour
  if (nextRun <= now) {
    nextRun.setHours(nextRun.getHours() + 1);
  }

  return nextRun;
}

// Function to schedule next run dynamically
function scheduleNextRun() {
  const nextRun = getNextStockRefreshTime();
  const delay = nextRun.getTime() - Date.now();

  console.log(
    `Next stock refresh expected at: ${new Date(
      nextRun.getTime() - 10000
    ).toLocaleTimeString()}`
  );
  console.log(
    `Next API fetch scheduled at: ${nextRun.toLocaleTimeString()} (in ${Math.round(
      delay / 1000
    )}s)`
  );

  setTimeout(() => {
    console.log(
      `\n=== Running scheduled fetch at ${new Date().toLocaleTimeString()} ===`
    );
    scrapeOnce()
      .then(() => {
        // Schedule next run after this one completes
        scheduleNextRun();
      })
      .catch((err) => {
        console.error("Scheduled run failed:", err);
        // Still schedule next run even if this one failed
        scheduleNextRun();
      });
  }, delay);
}

// Start
ensureHeader();

// Run once immediately
console.log("=== Initial run ===");
scrapeOnce()
  .then(() => {
    // After initial run, start the dynamic scheduling
    scheduleNextRun();
  })
  .catch((err) => {
    console.error("Initial run failed:", err);
    // Still start scheduling even if initial run failed
    scheduleNextRun();
  });

console.log(
  "Script started - will fetch data 45 seconds after each stock refresh..."
);
