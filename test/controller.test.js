'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./fixtures/literotica.js');
const {
  createSite, createPage, startController, waitFor, waitForStatus, combinedTexts, isHidden, cleanup,
} = require('./helpers.js');
const { describeError } = require('../src/content.js');

const BASE = 'https://www.literotica.com/s/test-story';
const urlFor = (n, base = BASE) => `${base}${n > 1 ? `?page=${n}` : ''}`;

/**
 * Opens page `page` of a story served by `site`. `routes(story)` runs after
 * the story is registered, to override individual pages.
 */
function open(site, storyOpts, page = 1, config, routes) {
  const s = site.addStory(storyOpts);
  if (routes) routes(s);
  const view = createPage(s.urlFor(page), s.html(page));
  const controller = startController(view.window, site, config);
  return Object.assign(view, { controller, story: s });
}

function expectedTexts(slug, pages, perPage = 6) {
  const out = [];
  for (const page of pages) {
    for (const p of fx.defaultParagraphs(slug, page, perPage)) out.push(p.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  }
  return out;
}

function assertOriginalIntact(document) {
  assert.equal(document.querySelector('[data-lsp-combined]'), null, 'no combined container');
  assert.equal(document.querySelectorAll('[data-lsp-hidden]').length, 0, 'nothing hidden');
}

const pagination = (document) => [...document.querySelectorAll('nav')].filter((n) => /Pagination|Seitennummerierung/.test(n.getAttribute('aria-label')));

test.afterEach(cleanup);

test('1. a single-page story is left unchanged', async () => {
  const site = createSite();
  const { document, controller } = open(site, { total: 1 });
  await waitForStatus(controller, 'single');
  assert.equal(site.requests.length, 0);
  assertOriginalIntact(document);
  assert.equal(document.querySelector('[data-lsp-ui]'), null, 'no UI shown');
  controller.stop();
});

test('2. a two-page story is combined into one continuous text', async () => {
  const site = createSite();
  const { document, window, controller } = open(site, { total: 2 });
  await waitForStatus(controller, 'combined');
  assert.deepEqual(site.requests, [urlFor(2)]);
  assert.deepEqual(combinedTexts(document), expectedTexts('test-story', [1, 2]));

  // One container, styled like the original wrapper, placed where it was.
  const combined = document.querySelector('[data-lsp-combined]');
  const body = document.querySelector('[itemprop="articleBody"]');
  assert.equal(combined.parentElement, body);
  assert.equal(body.firstElementChild, combined);
  assert.match(combined.className, /_introduction-wrap_/);

  // Original text and pagination hidden; title, author and the rest of the page untouched.
  assert.ok(isHidden(document.querySelector('[data-hk]')));
  for (const nav of pagination(document)) assert.ok(isHidden(nav));
  assert.ok(isHidden(document.querySelector('[class*="page_counter"]')));
  assert.ok(!isHidden(document.querySelector('h1._title_rc893_34')));
  assert.ok(!isHidden(document.querySelector('._author__title_jwrer_59')));
  assert.ok(!isHidden(document.querySelector('nav[aria-label="Breadcrumb"]')));
  assert.ok(!isHidden(document.querySelector('a[href*="dialog=report-work"]')));

  // No separators between pages, and no page's content appears twice.
  assert.equal(combined.querySelectorAll('hr').length, 0);
  assert.equal(new Set(combinedTexts(document)).size, combinedTexts(document).length);

  const ui = document.querySelector('[data-lsp-ui]');
  assert.match(ui.textContent, /2 pages combined/);
  assert.equal(window.__fixtureScriptRan, undefined, 'fixture scripts never execute');
  controller.stop();
  assertOriginalIntact(document);
});

test('3. a 25-page story with truncated pagination loads every page with bounded concurrency', async () => {
  const site = createSite();
  const story = site.addStory({ total: 25 });
  // Vary response times so pages arrive out of order.
  for (let n = 2; n <= 25; n++) site.route(story.urlFor(n), { html: story.html(n), delay: (n * 7) % 11 });
  const { document, window } = createPage(story.urlFor(1), story.html(1));
  const controller = startController(window, site);
  await waitForStatus(controller, 'combined');
  assert.equal(site.requests.length, 24);
  assert.equal(new Set(site.requests).size, 24);
  assert.ok(site.maxInFlight <= 3);
  const pages = Array.from({ length: 25 }, (_, i) => i + 1);
  assert.deepEqual(combinedTexts(document), expectedTexts('test-story', pages));
  controller.stop();
});

test('4/5. opening page 3 of 5 fetches pages 1, 2, 4 and 5 and orders all five', async () => {
  const site = createSite();
  const story = site.addStory({ total: 5 });
  site.route(story.urlFor(1), { html: story.html(1), delay: 30 });
  site.route(story.urlFor(5), { html: story.html(5), delay: 1 });
  const { document, window } = createPage(story.urlFor(3), story.html(3));
  const controller = startController(window, site);
  await waitForStatus(controller, 'combined');
  assert.deepEqual([...site.requests].sort(), [story.urlFor(1), story.urlFor(2), story.urlFor(4), story.urlFor(5)].sort());
  assert.deepEqual(combinedTexts(document), expectedTexts('test-story', [1, 2, 3, 4, 5]));
  const pagesInOrder = [...document.querySelector('[data-lsp-combined]').children].map((el) => el.getAttribute('data-lsp-page'));
  assert.deepEqual([...new Set(pagesInOrder)], ['1', '2', '3', '4', '5']);
  controller.stop();
});

test('scroll position: the paragraph being read stays where it is on screen', async () => {
  const site = createSite();
  const story = site.addStory({ total: 3 });
  const { document, window } = createPage(story.urlFor(2), story.html(2));

  // Minimal fake layout: block elements stacked 100px apart in document order,
  // hidden ones taking no space; the viewport is scrolled to y = 450.
  let scrollY = 450;
  window.scrollBy = (o) => { scrollY += o.top; window.scrollCalls.push(o.top); };
  const proto = window.Element.prototype;
  proto.getBoundingClientRect = function () {
    const blocks = [...document.querySelectorAll('[itemprop="articleBody"] p')].filter((p) => {
      for (let n = p; n; n = n.parentElement) if (n.hasAttribute && n.hasAttribute('data-lsp-hidden')) return false;
      return true;
    });
    const i = blocks.indexOf(this);
    const top = i < 0 ? -10000 : i * 100 - scrollY;
    return { top, bottom: top + 100, height: 100, width: 600, left: 0, right: 600 };
  };

  // Before: page 2 paragraphs at 0..500; reading paragraph index 4 (top at 400 - 450 = -50).
  const controller = startController(window, site);
  await waitForStatus(controller, 'combined');
  // Page 1's six paragraphs (600px) were inserted above, so the page scrolled down by 600px.
  assert.deepEqual(window.scrollCalls, [600]);
  const reading = [...document.querySelectorAll('[data-lsp-combined] p')][6 + 4];
  assert.match(reading.textContent, /Paragraph 5 of page 2/);
  assert.equal(reading.getBoundingClientRect().top, -50);
  controller.stop();
});

test('6a. duplicate pagination links do not cause duplicate requests or content', async () => {
  const site = createSite();
  const { document, controller } = open(site, { total: 4, duplicateNav: true });
  await waitForStatus(controller, 'combined');
  assert.deepEqual([...site.requests].sort(), [urlFor(2), urlFor(3), urlFor(4)].sort());
  assert.deepEqual(combinedTexts(document), expectedTexts('test-story', [1, 2, 3, 4]));
  assert.equal(pagination(document).length, 3);
  assert.ok(pagination(document).every(isHidden));
  controller.stop();
});

test('6b. a server that ignores ?page (same text on every page) is detected', async () => {
  const site = createSite();
  const same = fx.defaultParagraphs('test-story', 1);
  const { document, controller } = open(site, { total: 3, paragraphsFor: () => same });
  const s = await waitForStatus(controller, 'error');
  assert.equal(s.error.code, 'duplicate-pages');
  assertOriginalIntact(document);
  controller.stop();
});

test('6c. a paragraph repeated across a page boundary appears once', async () => {
  const site = createSite();
  const repeated = '<p>This closing paragraph of page one is long enough to count, and page two repeats it word for word at the top.</p>';
  const { document, controller } = open(site, {
    total: 2,
    paragraphsFor: (n) => (n === 1 ? ['<p>Opening.</p>', repeated] : [repeated, '<p>Continuation.</p>']),
  });
  await waitForStatus(controller, 'combined');
  const texts = combinedTexts(document);
  assert.equal(texts.length, 3);
  assert.equal(texts.filter((t) => t.startsWith('This closing paragraph')).length, 1);
  controller.stop();
});

test('7. a missing page keeps the original page, explains why, and Retry recovers', async () => {
  const site = createSite();
  const story = site.addStory({ total: 5 });
  const page4 = story.html(4);
  site.route(story.urlFor(4), { status: 404, html: fx.notFoundPage() });
  const { document, window } = createPage(story.urlFor(1), story.html(1));
  const controller = startController(window, site);
  const s = await waitForStatus(controller, 'error');
  assert.equal(s.error.code, 'not-found');
  assertOriginalIntact(document);
  assert.ok(pagination(document).every((nav) => !isHidden(nav)), 'pagination still visible');
  const ui = document.querySelector('[data-lsp-ui]');
  assert.equal(ui.getAttribute('role'), 'alert');
  assert.match(ui.textContent, /Couldn't find page 4 of 5\. Showing the original pages\./);

  // The page comes back; Retry only fetches what's missing.
  site.route(story.urlFor(4), { html: page4 });
  const before = site.requests.length;
  [...ui.querySelectorAll('button')].find((b) => b.textContent === 'Retry').click();
  await waitForStatus(controller, 'combined');
  const retried = site.requests.slice(before);
  assert.ok(retried.includes(story.urlFor(4)));
  assert.ok(retried.length < 4, `refetched ${retried.length} pages`);
  assert.deepEqual(combinedTexts(document), expectedTexts('test-story', [1, 2, 3, 4, 5]));
  controller.stop();
});

test('7b. the error notice can be dismissed', async () => {
  const site = createSite();
  const { document, controller } = open(site, { total: 2 }, 1, {}, () => site.route(urlFor(2), { status: 403 }));
  const s = await waitForStatus(controller, 'error');
  assert.equal(s.error.code, 'forbidden');
  const ui = document.querySelector('[data-lsp-ui]');
  assert.match(ui.textContent, /refused access to page 2 of 2/);
  ui.querySelector('button[aria-label="Dismiss"]').click();
  assert.equal(document.querySelector('[data-lsp-ui]'), null);
  assertOriginalIntact(document);
  controller.stop();
});

test('8. pages that are not stories are ignored', async () => {
  for (const [url, html] of [
    ['https://www.literotica.com/c/mature-sex', fx.categoryPage()],
    ['https://www.literotica.com/authors/TestAuthor', fx.authorPage()],
    ['https://www.literotica.com/', fx.categoryPage()],
    ['https://www.literotica.com/s/does-not-exist', fx.notFoundPage()],
  ]) {
    const site = createSite();
    const { window, document } = createPage(url, html);
    const controller = startController(window, site);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(site.requests.length, 0, url);
    assertOriginalIntact(document);
    assert.equal(document.querySelector('[data-lsp-ui]'), null, url);
    controller.stop();
  }
});

test('9a. an unexpected page in the middle of the story fails safely', async () => {
  const site = createSite();
  const story = site.addStory({ total: 4 });
  site.route(story.urlFor(3), { html: fx.storyPage({ total: 4, page: 3, layout: 'none' }) });
  const { document, window } = createPage(story.urlFor(1), story.html(1));
  const controller = startController(window, site);
  const s = await waitForStatus(controller, 'error');
  assert.equal(s.error.code, 'unexpected-structure');
  assert.equal(s.error.page, 3);
  assertOriginalIntact(document);
  controller.stop();
});

test('9b. a fetched page reporting a different page count fails safely', async () => {
  const site = createSite();
  const story = site.addStory({ total: 3 });
  site.route(story.urlFor(2), { html: fx.storyPage({ total: 4, page: 2 }) });
  const { document, window } = createPage(story.urlFor(1), story.html(1));
  const controller = startController(window, site);
  const s = await waitForStatus(controller, 'error');
  assert.equal(s.error.code, 'inconsistent-pagination');
  assertOriginalIntact(document);
  controller.stop();
});

test('9c. contradictory pagination on the open page: nothing is fetched', async () => {
  const site = createSite();
  const { document, controller } = open(site, { total: 6, counterTotal: 4 });
  const s = await waitForStatus(controller, 'error');
  assert.equal(s.error.code, 'inconsistent-pagination');
  assert.equal(site.requests.length, 0);
  assertOriginalIntact(document);
  assert.match(document.querySelector('[data-lsp-ui]').textContent, /how many pages/);
  controller.stop();
});

test('9d. a fetched page that redirects elsewhere is rejected', async () => {
  const site = createSite();
  const story = site.addStory({ total: 3 });
  site.route(story.urlFor(3), { html: story.html(1), finalUrl: story.urlFor(1) });
  const { document, window } = createPage(story.urlFor(1), story.html(1));
  const controller = startController(window, site);
  const s = await waitForStatus(controller, 'error');
  assert.equal(s.error.code, 'redirected');
  assertOriginalIntact(document);
  controller.stop();
});

test('9e. story text placed directly in articleBody is still combined', async () => {
  const site = createSite();
  const { document, controller } = open(site, { total: 3, layout: 'inline' });
  await waitForStatus(controller, 'combined');
  assert.deepEqual(combinedTexts(document), expectedTexts('test-story', [1, 2, 3]));
  const body = document.querySelector('[itemprop="articleBody"]');
  assert.ok([...body.children].filter((el) => el.localName === 'p').every(isHidden));
  controller.stop();
});

test('10a. a persistent network failure is retried, then reported', async () => {
  const site = createSite();
  const { document, controller } = open(site, { total: 3 }, 1, { retries: 2 }, () => site.route(urlFor(3), { networkError: true }));
  const s = await waitForStatus(controller, 'error');
  assert.equal(s.error.code, 'network');
  assert.equal(site.attemptsFor(urlFor(3)), 3);
  assertOriginalIntact(document);
  assert.match(document.querySelector('[data-lsp-ui]').textContent, /Network error while loading page 3 of 3/);
  controller.stop();
});

test('10b. a transient failure recovers without the user noticing', async () => {
  const site = createSite();
  const story = site.addStory({ total: 3 });
  const html2 = story.html(2);
  site.route(story.urlFor(2), (attempt) => (attempt === 1 ? { status: 503 } : { html: html2 }));
  const { document, window } = createPage(story.urlFor(1), story.html(1));
  const controller = startController(window, site);
  await waitForStatus(controller, 'combined');
  assert.deepEqual(combinedTexts(document), expectedTexts('test-story', [1, 2, 3]));
  controller.stop();
});

test('10c. a request timeout is reported', async () => {
  const site = createSite();
  const { controller, document } = open(site, { total: 2 }, 1, { timeoutMs: 30, retries: 0 }, () => site.route(urlFor(2), { hang: true }));
  const s = await waitForStatus(controller, 'error');
  assert.equal(s.error.code, 'timeout');
  assertOriginalIntact(document);
  controller.stop();
});

test('11. navigating to another story mid-load cancels the old story', async () => {
  const site = createSite();
  const a = site.addStory({ slug: 'story-a', total: 3 });
  const b = site.addStory({ slug: 'story-b', total: 2 });
  site.route(a.urlFor(2), { html: a.html(2), delay: 80 });
  site.route(a.urlFor(3), { html: a.html(3), delay: 80 });
  const { document, window } = createPage(a.urlFor(1), a.html(1));
  const controller = startController(window, site);
  await waitForStatus(controller, 'loading');

  // Client-side navigation: the site swaps in story B's content and URL.
  const fresh = new window.DOMParser().parseFromString(b.html(1), 'text/html');
  document.head.replaceWith(document.adoptNode(fresh.head));
  document.body.replaceWith(document.adoptNode(fresh.body));
  window.history.pushState({}, '', b.urlFor(1));
  controller.check();

  await waitFor(() => controller.session && controller.session.story.slug === 'story-b' && controller.session.status === 'combined');
  assert.deepEqual(combinedTexts(document), expectedTexts('story-b', [1, 2]));
  await new Promise((r) => setTimeout(r, 120)); // let story A's slow responses arrive
  assert.doesNotMatch(document.body.textContent, /of page \d of story-a/);
  assert.equal(document.querySelectorAll('[data-lsp-combined]').length, 1);
  controller.stop();
});

test('navigating away from a combined story restores the original DOM first', async () => {
  const site = createSite();
  const { document, window, controller } = open(site, { total: 2 });
  await waitForStatus(controller, 'combined');
  window.history.pushState({}, '', 'https://www.literotica.com/c/mature-sex');
  controller.check();
  assertOriginalIntact(document);
  assert.equal(document.querySelector('[data-lsp-ui]'), null);
  assert.equal(controller.session, null);
  controller.stop();
});

test('same-story URL changes (dialogs, other pages) keep the combined view', async () => {
  const site = createSite();
  const { document, window, controller, story } = open(site, { total: 3 });
  await waitForStatus(controller, 'combined');
  const requests = site.requests.length;

  window.history.pushState({}, '', `${story.urlFor(1)}?dialog=log-in`);
  controller.check();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(controller.session.status, 'combined');

  // Back/forward to page 2: the site re-renders the (hidden) original text.
  const page2 = new window.DOMParser().parseFromString(story.html(2), 'text/html');
  const wrapper = document.querySelector('[data-hk]');
  wrapper.innerHTML = page2.querySelector('[data-hk]').innerHTML;
  document.querySelector('link[rel=canonical]').setAttribute('href', story.urlFor(2));
  document.querySelector('[class*="page_counter"]').textContent = 'Page 2 of 3';
  window.history.pushState({}, '', story.urlFor(2));
  controller.check();
  await waitFor(() => controller.session.livePage === 2);
  assert.equal(controller.session.status, 'combined');
  assert.ok(isHidden(wrapper));
  assert.equal(site.requests.length, requests, 'nothing refetched');
  assert.equal(document.querySelectorAll('[data-lsp-combined]').length, 1);
  controller.stop();
});

test('re-rendered pagination is hidden again', async () => {
  const site = createSite();
  const { document, controller } = open(site, { total: 3 });
  await waitForStatus(controller, 'combined');
  const nav = pagination(document)[0];
  const copy = nav.cloneNode(true);
  copy.removeAttribute('data-lsp-hidden');
  nav.parentElement.replaceChild(copy, nav);
  // The site re-renders the story body too, which triggers reconciliation.
  const body = document.querySelector('[itemprop="articleBody"]');
  body.appendChild(document.createElement('span'));
  await waitFor(() => isHidden(copy));
  controller.stop();
});

test('the restore control switches to the paged view and back without refetching', async () => {
  const site = createSite();
  const { document, controller } = open(site, { total: 3 }, 2);
  await waitForStatus(controller, 'combined');
  const requests = site.requests.length;
  const ui = () => document.querySelector('[data-lsp-ui]');

  ui().querySelector('button').click();
  assert.equal(controller.session.status, 'original');
  assertOriginalIntact(document);
  assert.match(ui().textContent, /Page 2 of 3/);
  assert.ok(pagination(document).every((n) => !isHidden(n)));

  ui().querySelector('button').click();
  assert.equal(controller.session.status, 'combined');
  assert.deepEqual(combinedTexts(document), expectedTexts('test-story', [1, 2, 3]));
  assert.equal(site.requests.length, requests);
  controller.stop();
});

test('long pages and many images are handled', async () => {
  const site = createSite();
  const long = (n) => Array.from({ length: 2000 }, (_, i) => `<p>Page ${n}, paragraph ${i}: ${'word '.repeat(30)}</p>`)
    .concat([`<p><img src="/images/illustratedstories/p${n}.jpg" width="810" height="532"></p>`, '<hr>']);
  const { document, controller } = open(site, { total: 3, paragraphsFor: long });
  const started = Date.now();
  await waitForStatus(controller, 'combined');
  const combined = document.querySelector('[data-lsp-combined]');
  assert.equal(combined.children.length, 3 * 2002);
  assert.equal(combined.querySelectorAll('img').length, 3);
  assert.equal(combined.querySelectorAll('hr').length, 3);
  assert.equal(combined.querySelector('img').getAttribute('src'), 'https://www.literotica.com/images/illustratedstories/p1.jpg');
  assert.ok(Date.now() - started < 5000);
  controller.stop();
});

test('a script injected into a fetched page never runs or survives', async () => {
  const site = createSite();
  const story = site.addStory({ total: 2 });
  site.route(story.urlFor(2), {
    html: fx.storyPage({
      total: 2,
      page: 2,
      paragraphs: ['<p>Safe text<img src="x" onerror="window.__pwned=1"></p>', '<script>window.__pwned=2</script>', '<p><a href="javascript:window.__pwned=3">x</a></p>'],
    }),
  });
  const { document, window } = createPage(story.urlFor(1), story.html(1));
  const controller = startController(window, site);
  await waitForStatus(controller, 'combined');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(window.__pwned, undefined);
  const html = document.querySelector('[data-lsp-combined]').innerHTML;
  assert.doesNotMatch(html, /onerror|<script|javascript:/);
  controller.stop();
});

test('poems (/p/) and language subdomains work', async () => {
  for (const opts of [
    { kind: 'p', slug: 'a-poem', total: 2 },
    { host: 'german.literotica.com', lang: 'de', slug: 'die-geschichte', total: 3 },
  ]) {
    const site = createSite();
    const { document, controller } = open(site, opts);
    await waitForStatus(controller, 'combined');
    const pages = Array.from({ length: opts.total }, (_, i) => i + 1);
    assert.deepEqual(combinedTexts(document), expectedTexts(opts.slug, pages));
    assert.ok(site.requests.every((u) => u.startsWith(`https://${opts.host || 'www.literotica.com'}/${opts.kind || 's'}/${opts.slug}`)));
    controller.stop();
  }
});

test('the extension never runs twice on the same page', async () => {
  const site = createSite();
  const { document, window, controller } = open(site, { total: 2 });
  await waitForStatus(controller, 'combined');
  const second = startController(window, site);
  assert.equal(second.session, null);
  assert.equal(document.querySelectorAll('[data-lsp-combined]').length, 1);
  assert.ok(controller.start() === false);
  second.stop();
  controller.stop();
});

test('error messages are specific', () => {
  assert.equal(describeError({ code: 'not-found', page: 4 }, 5), 'Couldn\'t find page 4 of 5. Showing the original pages.');
  assert.match(describeError({ code: 'http', page: 2, status: 500 }, 3), /HTTP 500/);
  assert.match(describeError({ code: 'timeout', page: 2 }, 3), /timed out/);
  assert.match(describeError({ code: 'redirected', page: 2 }, 3), /Page 2 of 3 didn't look like part of this story/);
});
