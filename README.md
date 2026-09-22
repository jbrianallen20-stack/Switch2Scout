# Switch 2 Scout

Checks a handful of retailer product pages every 5 minutes for signs that the
**Nintendo Switch 2 — The Legend of Zelda 40th Anniversary Edition** has
become available, and pings a Discord channel when it looks like it has.

## How it decides to alert

For each page, the script pulls the visible text and checks it (case-insensitive)
against two phrase lists:

- **Out-of-stock phrases**: "out of stock", "sold out", "coming soon",
  "unavailable", "not in stock", "notify me when available", etc.
- **In-stock phrases**: "add to cart", "add to bag", "pre-order now", "buy now", etc.

It alerts if an in-stock phrase is found, **or** if *none* of the out-of-stock
phrases are found — on the theory that an ambiguous page is worth a human
glance, and a missed restock is worse than an occasional false alarm. It also
detects common bot-check / CAPTCHA pages and treats those as a failed check
rather than "in stock" (see [Things worth knowing](#things-worth-knowing) below).

Once a page is flagged as "alert," it won't re-notify every 5 minutes for the
same ongoing alert — it tracks state in `state.json` and only pings again when
the status actually changes.

## Setup

1. **Add these files to your repo.** Keep the folder structure as-is
   (`.github/workflows/stock-check.yml` has to live at that exact path).

2. **Add your Discord webhook as a secret** — don't put it directly in the
   code or commit it to the repo. In your repo:
   `Settings → Secrets and variables → Actions → New repository secret`
   - Name: `DISCORD_WEBHOOK_URL`
   - Value: your webhook URL

   > Since you pasted your webhook URL in a chat to build this, it's worth
   > treating it as at least mildly exposed. Anyone with the URL can post to
   > that channel (they can't read messages or take over the channel, but
   > they can spam it). If you want to be safe, you can regenerate it in
   > Discord (channel settings → Integrations → Webhooks) and use the new one
   > as the secret — it costs nothing and closes the loop.

3. **Allow the workflow to write to the repo.**
   `Settings → Actions → General → Workflow permissions` → select
   **"Read and write permissions."** This is what lets the job commit
   `state.json` back after each run.

4. **Make sure Actions are enabled** for the repo (they usually are by
   default): `Settings → Actions → General → Actions permissions`.

5. **Push, then test manually.** Go to the **Actions** tab →
   "Switch 2 Zelda Edition Stock Check" → **Run workflow**. Watch the run
   logs — you should see one status line per retailer
   (`status=quiet`, `status=alert`, `status=blocked`, or `status=error`).

6. Once a manual run looks right, the schedule takes over automatically.

### Local testing (optional)

```bash
npm install
DISCORD_WEBHOOK_URL="your-webhook-url" node src/scout.js
```

## Things worth knowing

I want to be upfront about a few things, since you said this is new territory:

**1. The three non-Nintendo retailers may block simple scrapers.** Target,
Best&nbsp;Buy, and GameStop — like most large e-commerce sites — run bot-mitigation
systems that can detect plain HTTP requests (no real browser, no JS execution)
and serve a CAPTCHA/"blocked" page instead of the real content, especially
from datacenter IP ranges like GitHub's own runners. This script detects the
common signs of that (`status=blocked` in the logs) so it won't accidentally
treat a block page as "in stock," but it also means those retailers might
just stop giving you usable data at some point with no warning. If you see
`blocked` consistently for one site, plain `axios` + `cheerio` isn't going to
get you reliable results there — the next step up is a headless browser
(Playwright) rendering the real page, or a paid scraping-proxy service. That's
a meaningfully bigger lift, so I'd start with this simple version and only
add that complexity where you actually see it's needed. Nintendo's own store
is the most likely to "just work" with this simple approach.

**2. "Every 5 minutes" is best-effort, not guaranteed.** 5 minutes is the
fastest interval GitHub Actions supports for scheduled workflows — you can't
go faster. GitHub is also explicit that scheduled runs can be delayed,
sometimes by several minutes, during periods of high platform load. For a
fast restock this mostly won't matter, but don't treat it as a hard real-time
guarantee.

**3. Keep the repo public if you can.** GitHub Actions minutes on standard
runners are unlimited and free for public repos. On private repos, the Free
plan only includes 2,000 minutes/month — running every 5 minutes, 24/7, adds
up fast and could exceed that allowance (or start costing money) depending on
how long each run takes. There's nothing sensitive in this repo as long as
the webhook stays in secrets and out of the code, so public is a reasonable
choice here.

**4. Scheduled workflows get silently disabled after 60 days with no commits
to the repo.** If your alert status never changes for two months straight,
GitHub will stop running the cron trigger until someone re-enables it in the
Actions tab (or pushes a commit). Worth a mental note to glance at the repo
every so often, especially in the off-season for restocks.

**5. Scraping and retailer Terms of Service.** Most retailers' ToS technically
prohibit automated access to their site. In practice, a handful of polite,
low-frequency GET requests to a public product page — the same page a human
would load by hand — is a common and low-risk pattern (this is exactly how
most hobbyist restock bots work), and the realistic consequence if a retailer
notices is just that your requests get rate-limited or blocked, not anything
more serious. It's not strictly "permitted," though, so it's worth knowing
going in.

## Possible additions (up to you)

- **Walmart and Costco** are the other retailers this specific edition has
  shown up at during past Switch 2 launches — worth adding as targets if you
  want broader coverage. Amazon is scrapeable in principle but has some of the
  most aggressive bot-detection of any major retailer, so I'd treat it as a
  "nice to have, expect it to break" addition rather than a priority.
- **Community stock trackers**: sites like nowinstock.net and various
  Discord/Twitter restock-alert communities already track hot electronics
  drops, including recent Nintendo hardware, across many retailers. Running
  your own tracker alongside one of those as a second signal isn't a bad
  idea — it costs nothing and catches you if this script's phrase-matching
  ever gets it wrong on a given page.
- If you want to fine-tune the phrase lists after seeing a few real runs
  (e.g. a retailer uses different wording than expected), they're the
  `OUT_OF_STOCK_PHRASES` / `IN_STOCK_PHRASES` arrays at the top of
  `src/scout.js`.
