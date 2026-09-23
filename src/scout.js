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
  // ⚠️ Your Walmart entry went here — add it back, e.g.:
  // { name: 'Walmart', url: 'https://www.walmart.com/ip/...' },
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

// Retailer pages routinely include "you might also like" style carousels
// further down the page, each with their own Add to Cart buttons for
// completely unrelated products. Scanning the whole page's text would
// pick those up as false positives. Instead, we only check the text that
// comes before the first such section — that's reliably where the real
// buy box (price, stock status, actual buy button) for the item we care
// about lives on every retailer page seen so far.
const RECOMMENDATION_BOUNDARY_PHRASES = [
  'discover more options',
  'consider these accessories',
  'guests also viewed',
  'customers also viewed',
  'customers also bought',
  'frequently bought together',
  'you may also like',
  'similar items',
  'related products',
  'recommended for you',
  'shop similar items',
  'more like this',
];

function primarySectionOnly(pageText) {
  let cutoff = pageText.length;
  for (const phrase of RECOMMENDATION_BOUNDARY_PHRASES) {
    const idx = pageText.indexOf(phrase);
    if (idx !== -1 && idx < cutoff) cutoff = idx;
  }
  return pageText.slice(0, cutoff);
}

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

    // Only check the part of the page before any cross-sell/recommendation
    // carousel — those sections are full of unrelated products' own
    // "Add to Cart" buttons and would otherwise cause false positives.
    const primaryText = primarySectionOnly(pageText);

    const hasOutOfStockPhrase = OUT_OF_STOCK_PHRASES.some((p) => primaryText.includes(p));
    const hasInStockPhrase = IN_STOCK_PHRASES.some((p) => primaryText.includes(p));

    // An explicit out-of-stock phrase wins even when a buy/pre-order phrase
    // also appears nearby — some retailers (Target, at least) leave a
    // "Pre-order"/"Add to Cart" button in the page markup and just disable
    // it while showing "Out of Stock" as the real status, so buy-phrase
    // text alone isn't proof of availability. We still alert when neither
    // kind of phrase is found at all, since an unrecognized page state is
    // worth a manual look rather than assumed to be fine.
    const shouldAlert = !hasOutOfStockPhrase;

    let detail;
    if (hasOutOfStockPhrase) {
      detail = 'Out-of-stock phrase detected (takes priority over any buy-phrase text also on the page).';
    } else if (hasInStockPhrase) {
      detail = 'A buy/pre-order phrase was detected with no out-of-stock phrase present.';
    } else {
      detail = 'No known status phrase was found on the page — worth a manual look.';
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