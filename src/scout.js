/**
 * Switch 2 Scout
 * Checks a list of retailer product pages for signs that the
 * Nintendo Switch 2 — The Legend of Zelda 40th Anniversary Edition
 * has become available, and posts an alert to Discord when it does.
 *
 * Designed to run as a GitHub Actions scheduled job. See ../README.md
 * for setup instructions.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'state.json');
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!DISCORD_WEBHOOK_URL) {
  console.error(
    'Missing DISCORD_WEBHOOK_URL environment variable. ' +
      'Set it as a GitHub Actions secret (see README.md).'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Targets — add/remove product pages here.
// ---------------------------------------------------------------------------
const TARGETS = [
  {
    name: 'Nintendo Official Store',
    url: 'https://www.nintendo.com/us/store/products/nintendo-switch-2-the-legend-of-zelda-40th-anniversary-edition-121642/',
  },
  {
    name: 'Walmart',
    url: 'https://www.walmart.com/ip/Nintendo-Switch-2-The-Legend-of-Zelda-40th-Anniversary-Edition/21002656445',
  },
  {
    name: 'GameStop',
    url: 'https://www.gamestop.com/consoles-hardware/nintendo-switch-2/products/nintendo-switch-2-the-legend-of-zelda-40th-anniversary-edition/20037854.html',
  },
  {
    name: 'Target',
    url: 'https://www.target.com/p/nintendo-8482-switch-2-the-legend-of-zelda-40th-anniversary-edition-console-system/-/A-1013322047',
  },
  {
    name: 'Best Buy',
    url: 'https://www.bestbuy.com/product/switch-2-the-legend-of-zelda-40th-anniversary-edition/J7GSL57HTY',
  },
];

// ---------------------------------------------------------------------------
// Phrase lists — tune these based on what you actually see in the logs.
// Everything is matched against lowercased, whitespace-collapsed page text.
// ---------------------------------------------------------------------------
const OUT_OF_STOCK_PHRASES = [
  'out of stock',
  'sold out',
  'currently sold out',
  'coming soon',
  'unavailable',
  'currently unavailable',
  'not available online',
  'not in stock',
  'temporarily out of stock',
  'notify me when available',
  'email me when available',
  'sign up for restock',
];

const IN_STOCK_PHRASES = [
  'add to cart',
  'add to bag',
  'pre-order now',
  'preorder now',
  'buy now',
  'ship it',
  'available online',
];

// Phrases that indicate we got a bot-check / block page instead of the
// real product page. We treat these as a failed check, never as "in stock".
const BLOCKED_PHRASES = [
  'captcha',
  'are you a human',
  'access denied',
  'pardon our interruption',
  'request blocked',
  'unusual traffic',
  'verify you are a human',
  'bot detection',
  'enable javascript and cookies',
];

const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ---------------------------------------------------------------------------
// State — used only to avoid re-notifying Discord every run once something
// is already flagged as available. Kept intentionally small.
// ---------------------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------
async function postToDiscord(payload) {
  await axios.post(DISCORD_WEBHOOK_URL, payload, { timeout: 10000 });
}

async function sendAvailableAlert(target, detail) {
  await postToDiscord({
    username: 'Switch 2 Scout',
    content: `🚨 **${target.name}** may have Zelda Edition Switch 2 available!`,
    embeds: [
      {
        title: target.name,
        url: target.url,
        description: detail,
        color: 0x2ecc71, // green
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

async function sendBackToQuietNote(target) {
  await postToDiscord({
    username: 'Switch 2 Scout',
    content: `↩️ **${target.name}** looks back to its normal out-of-stock state.`,
  });
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------
async function checkTarget(target) {
  try {
    const res = await axios.get(target.url, {
      headers: REQUEST_HEADERS,
      timeout: 15000,
      validateStatus: () => true, // we want to inspect non-2xx ourselves
    });

    if (res.status >= 400) {
      return { status: 'error', detail: `HTTP ${res.status}` };
    }

    const $ = cheerio.load(res.data);
    const pageText = $('body').text().replace(/\s+/g, ' ').toLowerCase();

    if (pageText.length < 200 || BLOCKED_PHRASES.some((p) => pageText.includes(p))) {
      return { status: 'blocked', detail: 'Page looked like a bot-check or was empty' };
    }

    const hasOutOfStockPhrase = OUT_OF_STOCK_PHRASES.some((p) => pageText.includes(p));
    const hasInStockPhrase = IN_STOCK_PHRASES.some((p) => pageText.includes(p));

    // Per spec: alert if a buy phrase is present, OR if none of the
    // out-of-stock phrases were found at all (better a false positive
    // you can dismiss in two seconds than a missed restock).
    const shouldAlert = hasInStockPhrase || !hasOutOfStockPhrase;

    let detail;
    if (hasInStockPhrase) {
      detail = 'A buy/pre-order phrase was detected on the page.';
    } else if (!hasOutOfStockPhrase) {
      detail = 'No known out-of-stock phrase was found on the page — worth a manual look.';
    } else {
      detail = 'Out-of-stock phrase detected.';
    }

    return { status: shouldAlert ? 'alert' : 'quiet', detail };
  } catch (err) {
    return { status: 'error', detail: err.message };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const state = loadState();
  const results = await Promise.all(TARGETS.map(checkTarget));

  let stateChanged = false;

  for (let i = 0; i < TARGETS.length; i++) {
    const target = TARGETS[i];
    const result = results[i];
    const prevAlert = state[target.url] === 'alert';

    console.log(`[${target.name}] status=${result.status} — ${result.detail}`);

    if (result.status === 'alert' && !prevAlert) {
      console.log(`[${target.name}] New alert — notifying Discord.`);
      await sendAvailableAlert(target, result.detail);
    } else if (result.status !== 'alert' && prevAlert) {
      console.log(`[${target.name}] No longer alerting — sending quiet note.`);
      await sendBackToQuietNote(target);
    }

    // Only "alert" is persisted as a distinct state; blocked/error/quiet
    // all collapse to "quiet" so a flaky fetch doesn't get stuck as an
    // open alert forever, and so state.json only changes on a real
    // transition (keeps the git history meaningful).
    const nextValue = result.status === 'alert' ? 'alert' : 'quiet';
    if (state[target.url] !== nextValue) {
      state[target.url] = nextValue;
      stateChanged = true;
    }
  }

  if (stateChanged) {
    saveState(state);
    console.log('state.json updated.');
  } else {
    console.log('No state change — state.json left untouched.');
  }
}

main().catch((err) => {
  console.error('Fatal error in scout run:', err);
  process.exit(1);
});
