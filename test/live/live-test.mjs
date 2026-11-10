/*
 * Real-world check against the live Literotica site.
 *
 * Loads the unpacked extension into Chrome for Testing / Chromium (branded
 * Chrome ignores --load-extension) and checks real stories end to end.
 * Not part of `npm test` because it needs the network and live content.
 *
 *   npm run test:live                    # headless
 *   HEADED=1 npm run test:live           # watch it run
 *   CHROME_PATH=/path/to/chromium npm run test:live
 *
 * Story URLs can be overridden with environment variables (see STORIES).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const STORIES = {
  multi: process.env.LSP_MULTI || 'https://www.literotica.com/s/parallel-tracks', // 5 pages
  long: process.env.LSP_LONG || 'https://www.literotica.com/s/druid-please-threefold-julie', // 25 pages
  single: process.env.LSP_SINGLE || 'https://www.literotica.com/s/borrowed-plumes-the-stories', // 1 page, images
  language: process.env.LSP_LANGUAGE || 'https://german.literotica.com/s/das-filmarchiv-teil-05', // 3 pages, German UI
  spaTarget: process.env.LSP_SPA_TARGET || 'https://www.literotica.com/s/gwendolyn-1', // 8 pages
};

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const caches = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
  ];
  const candidates = [];
  for (const dir of caches) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      candidates.push(
        path.join(dir, entry, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        path.join(dir, entry, 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        path.join(dir, entry, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        path.join(dir, entry, 'chrome-linux/chrome'),
        path.join(dir, entry, 'chrome-linux64/chrome'),
      );
    }
  }
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chromium found. Set CHROME_PATH or run `npx playwright install chromium`.');
  return found;
}

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, detail: err.message });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** Text of every page fetched independently (ground truth), via the page's own origin. */
async function groundTruth(page, storyUrl, total) {
  return page.evaluate(async ({ storyUrl, total }) => {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const out = [];
    for (let n = 1; n <= total; n++) {
      const res = await fetch(n > 1 ? `${storyUrl}?page=${n}` : storyUrl, { credentials: 'same-origin' });
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const wrapper = doc.querySelector('[itemprop="articleBody"] > div');
      out.push(...[...wrapper.children].map((el) => norm(el.textContent)).filter(Boolean));
    }
    return out;
  }, { storyUrl, total });
}

async function combinedState(page) {
  return page.evaluate(() => {
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    const combined = document.querySelector('[data-lsp-combined]');
    const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    const pagers = [...document.querySelectorAll('nav')].filter((n) => n.querySelector('a[href*="page="]'));
    return {
      combined: !!combined,
      texts: combined ? [...combined.children].map((el) => norm(el.textContent)).filter(Boolean) : [],
      pages: combined ? [...new Set([...combined.children].map((el) => el.getAttribute('data-lsp-page')))] : [],
      originalVisible: visible(document.querySelector('[itemprop="articleBody"] > div:not([data-lsp-combined])')),
      combinedVisible: visible(combined),
      pagersVisible: pagers.filter(visible).length,
      pagers: pagers.length,
      titleVisible: [...document.querySelectorAll('h1')].some(visible),
      ui: document.querySelector('[data-lsp-ui]')?.textContent || '',
      hidden: document.querySelectorAll('[data-lsp-hidden]').length,
      scripts: combined ? combined.querySelectorAll('script, iframe, [onclick], [onerror], [data-hk]').length : 0,
    };
  });
}

async function main() {
  const executablePath = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-e2e-'));
  console.log(`Chrome: ${executablePath}\nExtension: ${ROOT}\n`);
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });
  const page = context.pages()[0] || (await context.newPage());
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  const storyRequests = [];
  page.on('request', (req) => {
    if (/literotica\.com\/[sp]\//.test(req.url()) && req.resourceType() === 'fetch') storyRequests.push(req.url());
  });

  // Resolves when the story is combined; fails with the extension's own message if it reports an error.
  const waitCombined = async (timeout = 45000) => {
    await page.waitForSelector('[data-lsp-combined], [data-lsp-ui][role="alert"]', { state: 'attached', timeout });
    const alert = await page.$('[data-lsp-ui][role="alert"]');
    if (alert) throw new Error(`extension reported: ${await alert.textContent()}`);
  };

  try {
    await check('extension content script is injected', async () => {
      await page.goto(STORIES.multi, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('html[data-lsp-instance]', { state: 'attached', timeout: 15000 });
    });

    await check('multi-page story (page 1) is combined in order with exactly the original text', async () => {
      await waitCombined();
      const total = Number((await page.textContent('[class*="page_counter"]')).match(/(\d+)\D+(\d+)/)[2]);
      const state = await combinedState(page);
      const truth = await groundTruth(page, STORIES.multi, total);
      assert(state.combinedVisible && !state.originalVisible, 'combined text should replace the original on screen');
      assert(state.pages.join() === Array.from({ length: total }, (_, i) => i + 1).join(), `page order ${state.pages}`);
      assert(state.texts.length === truth.length, `paragraphs: combined ${state.texts.length} vs original ${truth.length}`);
      const firstDiff = state.texts.findIndex((t, i) => t !== truth[i]);
      assert(firstDiff === -1, `paragraph ${firstDiff} differs`);
      assert(state.pagersVisible === 0 && state.pagers >= 1, `pagination still visible (${state.pagersVisible}/${state.pagers})`);
      assert(state.titleVisible, 'title should stay visible');
      assert(state.scripts === 0, 'combined content must not contain scripts/handlers/hydration keys');
      assert(/pages combined/.test(state.ui), `UI says "${state.ui}"`);
      return `${total} pages, ${state.texts.length} paragraphs`;
    });

    await check('restore control shows the original pages, and switches back without refetching', async () => {
      const before = storyRequests.length;
      await page.click('[data-lsp-ui] button');
      let state = await combinedState(page);
      assert(!state.combined && state.originalVisible && state.pagersVisible >= 1 && state.hidden === 0, 'original view not restored');
      assert(/Page 1 of/.test(state.ui), `UI says "${state.ui}"`);
      await page.click('[data-lsp-ui] button');
      state = await combinedState(page);
      assert(state.combinedVisible && !state.originalVisible, 'not combined again');
      assert(storyRequests.length === before, 'pages were refetched');
    });

    await check('opening page 3 directly: all pages in order, page 3 stays where the reader is', async () => {
      await page.goto(`${STORIES.multi}?page=3`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[itemprop="articleBody"] p');
      await page.evaluate(() => window.scrollTo(0, 400));
      const before = await page.evaluate(() => {
        const ps = [...document.querySelectorAll('[itemprop="articleBody"] > div > *')];
        const i = ps.findIndex((p) => p.getBoundingClientRect().bottom > 0);
        return { i, top: ps[i].getBoundingClientRect().top, text: ps[i].textContent.slice(0, 60) };
      });
      await waitCombined();
      await page.waitForTimeout(300);
      const after = await page.evaluate((i) => {
        const el = document.querySelector(`[data-lsp-combined] > [data-lsp-page="3"][data-lsp-src="${i}"]`);
        return { top: el.getBoundingClientRect().top, text: el.textContent.slice(0, 60), scrollY };
      }, before.i);
      const state = await combinedState(page);
      assert(state.pages.join() === '1,2,3,4,5', `page order ${state.pages}`);
      assert(after.text === before.text, 'anchor paragraph mismatch');
      assert(Math.abs(after.top - before.top) <= 4, `reading position moved by ${Math.round(after.top - before.top)}px`);
      return `anchor moved ${Math.round(after.top - before.top)}px, scrollY ${Math.round(after.scrollY)}`;
    });

    await check('long story (many pages) is combined', async () => {
      storyRequests.length = 0;
      const t0 = Date.now();
      await page.goto(STORIES.long, { waitUntil: 'domcontentloaded' });
      await waitCombined(90000);
      const state = await combinedState(page);
      const total = state.pages.length;
      assert(total >= 10, `only ${total} pages`);
      assert(new Set(storyRequests).size === storyRequests.length, 'a page was requested twice');
      assert(storyRequests.length === total - 1, `${storyRequests.length} requests for ${total} pages`);
      return `${total} pages, ${state.texts.length} paragraphs in ${((Date.now() - t0) / 1000).toFixed(1)} s`;
    });

    await check('single-page story is left unchanged', async () => {
      await page.goto(STORIES.single, { waitUntil: 'load' });
      await page.waitForTimeout(2500);
      const state = await combinedState(page);
      assert(!state.combined && state.hidden === 0 && !state.ui, 'single-page story was modified');
      assert(state.originalVisible, 'story text should be visible');
    });

    await check('language subdomain with localised UI is combined', async () => {
      await page.goto(STORIES.language, { waitUntil: 'domcontentloaded' });
      await waitCombined();
      const state = await combinedState(page);
      const truth = await groundTruth(page, STORIES.language, state.pages.length);
      assert(state.texts.join('\n') === truth.join('\n'), 'text differs from the original pages');
      assert(state.pagersVisible === 0, 'pagination still visible');
      return `${state.pages.length} pages`;
    });

    await check('a failing page keeps the original, reports it, and Retry recovers', async () => {
      const failing = `${STORIES.multi}?page=4`;
      await page.route(failing, (route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' }));
      await page.goto(STORIES.multi, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-lsp-ui][role="alert"]', { timeout: 30000 });
      let state = await combinedState(page);
      assert(!state.combined && state.hidden === 0 && state.originalVisible && state.pagersVisible >= 1, 'original not intact');
      assert(/page 4 of 5/.test(state.ui), `UI says "${state.ui}"`);
      await page.unroute(failing);
      await page.click('[data-lsp-ui] button:has-text("Retry")');
      await waitCombined();
      state = await combinedState(page);
      assert(state.pages.join() === '1,2,3,4,5', `page order ${state.pages}`);
      return `message: "${state.ui ? 'combined after retry' : ''}"`;
    });

    await check('client-side navigation to another story resets and re-runs cleanly', async () => {
      await page.goto(STORIES.multi, { waitUntil: 'domcontentloaded' });
      await waitCombined();
      await page.evaluate(() => { window.__lspNoReload = true; });
      // Related-story widgets render lazily further down the page.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      const href = await page.evaluate(() => {
        const body = document.querySelector('[itemprop="articleBody"]');
        const own = location.pathname;
        const candidates = [...document.querySelectorAll('a[href*="/s/"]')].filter((a) => !body.contains(a)
          && (!a.target || a.target === '_self') && new URL(a.href).pathname !== own && /^\/s\/[^/]+$/.test(new URL(a.href).pathname)
          && !new URL(a.href).search && !a.closest('[data-lsp-hidden]'));
        // Links without a target attribute are handled by the site's client-side router.
        const link = candidates.find((a) => !a.hasAttribute('target')) || candidates[0];
        if (!link) return null;
        link.click(); // same as a user click: the site's router handles it
        return link.href;
      });
      assert(href, 'no related-story link found');
      await page.waitForFunction((h) => location.href === h, href, { timeout: 15000 });
      await page.waitForFunction(() => {
        const s = document.querySelector('link[rel=canonical]');
        return s && s.href === location.href;
      }, null, { timeout: 15000 });
      await page.waitForTimeout(4000);
      const noReload = await page.evaluate(() => window.__lspNoReload === true);
      const state = await combinedState(page);
      const multi = await page.evaluate(() => !!document.querySelector('nav a[href*="page="]') || /\d+\D+\d+/.test(document.querySelector('[class*="page_counter"]')?.textContent || ''));
      const leftovers = await page.evaluate((oldSlug) => document.querySelector('[data-lsp-combined]')?.textContent.includes(oldSlug), 'parallel-tracks');
      assert(!leftovers, 'old story content left behind');
      if (multi) assert(state.combinedVisible && !state.originalVisible, 'new multi-page story not combined');
      else assert(!state.combined && state.hidden === 0 && state.originalVisible, 'new single-page story was modified');
      return `${noReload ? 'client-side' : 'full'} navigation to ${new URL(href).pathname} (${multi ? `${state.pages.length} pages, combined` : 'single page, untouched'})`;
    });

    await check('client-side story → story navigation and Back reuse the page cleanly', async () => {
      await page.goto(STORIES.multi, { waitUntil: 'domcontentloaded' });
      await waitCombined();
      await page.evaluate(() => { window.__lspNoReload = true; });
      // Click a link to another multi-page story; the site's router handles it without reloading.
      await page.evaluate((url) => {
        const a = document.createElement('a');
        a.href = url;
        a.textContent = 'next story';
        document.querySelector('main, body').appendChild(a);
        a.click();
        a.remove();
      }, STORIES.spaTarget);
      await page.waitForFunction((u) => location.href === u, STORIES.spaTarget, { timeout: 15000 });
      await page.waitForFunction(() => {
        const c = document.querySelector('[data-lsp-combined]');
        const canon = document.querySelector('link[rel=canonical]');
        return c && canon && canon.href === location.href && c.isConnected;
      }, null, { timeout: 45000 });
      await page.waitForTimeout(500);
      assert(await page.evaluate(() => window.__lspNoReload === true), 'the page reloaded; client-side navigation not exercised');
      let state = await combinedState(page);
      const truth = await groundTruth(page, STORIES.spaTarget, state.pages.length);
      assert(state.texts.join('\n') === truth.join('\n'), 'combined text is not exactly the new story');
      assert(await page.evaluate(() => document.querySelectorAll('[data-lsp-combined]').length === 1), 'more than one combined container');
      assert(state.pagersVisible === 0 && !state.originalVisible, 'new story not cleanly combined');

      const before = storyRequests.length;
      await page.goBack();
      await page.waitForFunction((u) => location.href === u, STORIES.multi, { timeout: 15000 });
      await page.waitForFunction(() => {
        const c = document.querySelector('[data-lsp-combined]');
        return c && /parallel-tracks/.test(document.querySelector('link[rel=canonical]')?.href || '') && c.getAttribute('data-lsp-combined') !== null;
      }, null, { timeout: 45000 });
      await page.waitForTimeout(500);
      const refetched = storyRequests.length - before; // the extension's own requests only
      state = await combinedState(page);
      const truthA = await groundTruth(page, STORIES.multi, state.pages.length);
      assert(state.texts.join('\n') === truthA.join('\n'), 'after Back, combined text is not the original story');
      assert(refetched === 0, `${refetched} pages refetched after Back`);
      return `${truth.length} paragraphs in the new story; Back restored the first story from cache with 0 requests`;
    });

    await check('no page errors were thrown during the run', async () => {
      const ours = pageErrors.filter((m) => /lsp|LSP|Single-Page Reader/.test(m));
      assert(ours.length === 0, ours.join(' | '));
      return pageErrors.length ? `${pageErrors.length} unrelated site errors` : '';
    });
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
