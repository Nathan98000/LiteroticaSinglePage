'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPages, fetchText, PageLoadError, parseRetryAfter } = require('../src/loader.js');
const { createSite } = require('./helpers.js');

const urlFor = (n) => `https://www.literotica.com/s/x${n > 1 ? `?page=${n}` : ''}`;

function opts(site, extra) {
  return Object.assign({
    fetchImpl: site.fetch,
    buildUrl: urlFor,
    processPage: (res, n) => `${n}:${res.text}`,
    concurrency: 3,
    timeoutMs: 300,
    retries: 2,
    retryDelayMs: 1,
  }, extra);
}

test('loads every page and keys results by page number', async () => {
  const site = createSite();
  for (let n = 2; n <= 6; n++) site.route(urlFor(n), { html: `p${n}`, delay: (7 - n) * 3 });
  const results = await loadPages([2, 3, 4, 5, 6], opts(site));
  assert.deepEqual([...results.keys()].sort(), [2, 3, 4, 5, 6]);
  assert.equal(results.get(4), '4:p4');
});

test('never exceeds the concurrency limit', async () => {
  const site = createSite();
  const pages = [];
  for (let n = 2; n <= 30; n++) {
    pages.push(n);
    site.route(urlFor(n), { html: 'x', delay: 2 + (n % 4) });
  }
  await loadPages(pages, opts(site, { concurrency: 3 }));
  assert.equal(site.requests.length, 29);
  assert.ok(site.maxInFlight <= 3, `max in flight ${site.maxInFlight}`);
  assert.equal(site.maxInFlight, 3);
});

test('requests each page once even if listed twice', async () => {
  const site = createSite();
  site.route(urlFor(2), { html: 'a' });
  await loadPages([2, 2, 2], opts(site));
  assert.deepEqual(site.requests, [urlFor(2)]);
});

test('retries transient failures, then succeeds', async () => {
  const site = createSite();
  site.route(urlFor(2), (attempt) => (attempt < 3 ? { status: 503 } : { html: 'ok' }));
  site.route(urlFor(3), (attempt) => (attempt < 2 ? { networkError: true } : { html: 'ok' }));
  const results = await loadPages([2, 3], opts(site));
  assert.equal(results.size, 2);
  assert.equal(site.attemptsFor(urlFor(2)), 3);
  assert.equal(site.attemptsFor(urlFor(3)), 2);
});

test('does not retry a missing page, and reports it', async () => {
  const site = createSite();
  site.route(urlFor(2), { html: 'ok' });
  site.route(urlFor(3), { status: 404, html: 'nope' });
  await assert.rejects(loadPages([2, 3], opts(site)), (err) => {
    assert.ok(err instanceof PageLoadError);
    assert.equal(err.code, 'not-found');
    assert.equal(err.page, 3);
    assert.ok(err.loaded instanceof Map);
    return true;
  });
  assert.equal(site.attemptsFor(urlFor(3)), 1);
});

test('gives up after the configured retries on persistent network errors', async () => {
  const site = createSite();
  site.route(urlFor(2), { networkError: true });
  await assert.rejects(loadPages([2], opts(site, { retries: 2 })), { code: 'network', page: 2 });
  assert.equal(site.attemptsFor(urlFor(2)), 3);
});

test('times out hung requests', async () => {
  const site = createSite();
  site.route(urlFor(2), { hang: true });
  const started = Date.now();
  await assert.rejects(loadPages([2], opts(site, { timeoutMs: 40, retries: 1 })), { code: 'timeout', page: 2 });
  assert.equal(site.attemptsFor(urlFor(2)), 2);
  assert.ok(Date.now() - started < 1000);
});

test('stops starting new requests after a permanent failure', async () => {
  const site = createSite();
  site.route(urlFor(2), { status: 403 });
  for (let n = 3; n <= 20; n++) site.route(urlFor(n), { html: 'x', delay: 20 });
  await assert.rejects(loadPages(Array.from({ length: 19 }, (_, i) => i + 2), opts(site, { concurrency: 2 })), { code: 'forbidden' });
  assert.ok(site.requests.length <= 3, `made ${site.requests.length} requests`);
});

test('aborting cancels in-flight requests', async () => {
  const site = createSite();
  for (let n = 2; n <= 5; n++) site.route(urlFor(n), { hang: true });
  const controller = new AbortController();
  const promise = loadPages([2, 3, 4, 5], opts(site, { signal: controller.signal, timeoutMs: 10000 }));
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, { code: 'aborted' });
});

test('rejects non-HTML responses', async () => {
  const site = createSite();
  site.route(urlFor(2), { html: '{}', headers: { 'content-type': 'application/json' } });
  await assert.rejects(loadPages([2], opts(site)), { code: 'unexpected-response' });
});

test('a processPage rejection is permanent and carries the page number', async () => {
  const site = createSite();
  site.route(urlFor(2), { html: 'x' });
  await assert.rejects(loadPages([2], opts(site, {
    processPage: () => { throw new PageLoadError('unexpected-structure'); },
  })), { code: 'unexpected-structure', page: 2 });
  assert.equal(site.attemptsFor(urlFor(2)), 1);
});

test('fetchText sends same-origin credentials and reports the final URL', async () => {
  let seen;
  const res = await fetchText(urlFor(2), {
    fetchImpl: async (url, init) => {
      seen = init;
      return { ok: true, status: 200, url: urlFor(1), headers: { get: () => 'text/html' }, text: async () => 'body' };
    },
    timeoutMs: 100,
    page: 2,
  });
  assert.equal(seen.credentials, 'same-origin');
  assert.equal(seen.method, 'GET');
  assert.equal(res.finalUrl, urlFor(1));
  assert.equal(res.text, 'body');
});

test('parseRetryAfter handles seconds and dates', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter(null), null);
  assert.ok(parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) > 3000);
});
