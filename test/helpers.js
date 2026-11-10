'use strict';
const { JSDOM } = require('jsdom');
const fixtures = require('./fixtures/literotica');
const { createController } = require('../src/content.js');

function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** Never resolves; rejects with an AbortError when `signal` aborts. */
function hang(signal) {
  return new Promise((resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(abortError());
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(abortError());
      }, { once: true });
    }
  });
}

/**
 * A fake Literotica server: serves fixture pages by URL through a
 * fetch-compatible function and records every request.
 */
function createSite() {
  const routes = new Map();
  const attempts = new Map();
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;

  function addStory(options) {
    const opts = Object.assign({ host: 'www.literotica.com', kind: 's', slug: 'test-story', total: 1 }, options);
    const urlFor = (n) => `https://${opts.host}/${opts.kind}/${opts.slug}${n > 1 ? `?page=${n}` : ''}`;
    for (let n = 1; n <= opts.total; n++) {
      const pageOpts = Object.assign({}, opts, { page: n });
      if (typeof opts.paragraphsFor === 'function') pageOpts.paragraphs = opts.paragraphsFor(n);
      routes.set(urlFor(n), { html: fixtures.storyPage(pageOpts) });
    }
    return { urlFor, html: (n) => routes.get(urlFor(n)).html };
  }

  /** Overrides a URL: `spec` is a response spec or (attempt) => spec. */
  function route(url, spec) {
    routes.set(url, spec);
  }

  async function fetch(url, init = {}) {
    requests.push(url);
    const attempt = (attempts.get(url) || 0) + 1;
    attempts.set(url, attempt);
    let spec = routes.get(url) || { status: 404, html: fixtures.notFoundPage() };
    if (typeof spec === 'function') spec = spec(attempt);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await wait(spec.delay || 0, init.signal);
      if (spec.hang) await hang(init.signal);
      if (spec.networkError) throw new TypeError('Failed to fetch');
      const status = spec.status || 200;
      const headers = Object.assign({ 'content-type': 'text/html; charset=utf-8' }, spec.headers);
      return {
        ok: status >= 200 && status < 300,
        status,
        url: spec.finalUrl || url,
        headers: { get: (name) => headers[name.toLowerCase()] || null },
        text: async () => spec.html || '',
      };
    } finally {
      inFlight--;
    }
  }

  return {
    fetch,
    addStory,
    route,
    requests,
    attemptsFor: (url) => attempts.get(url) || 0,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

// Everything created by a test, so it can be torn down even if the test fails
// (a leftover controller interval would otherwise keep Node running).
const live = { controllers: [], windows: [] };

function cleanup() {
  for (const c of live.controllers.splice(0)) c.stop();
  for (const w of live.windows.splice(0)) w.close();
}

/** A jsdom window showing `html` at `url`. scrollBy calls are recorded. */
function createPage(url, html) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;
  live.windows.push(window);
  window.scrollCalls = [];
  window.scrollBy = (arg, y) => {
    window.scrollCalls.push(typeof arg === 'object' ? arg.top : y);
  };
  return { dom, window, document: window.document };
}

const TEST_CONFIG = {
  settleMs: 0,
  domPollMs: 5,
  domWaitMs: 300,
  pollMs: 1e6, // tests trigger URL checks explicitly
  retryDelayMs: 1,
  timeoutMs: 500,
};

function startController(window, site, config) {
  const logs = [];
  const controller = createController({
    window,
    fetch: site.fetch,
    config: Object.assign({}, TEST_CONFIG, config),
    log: (...args) => logs.push(args.join(' ')),
  });
  live.controllers.push(controller);
  controller.start();
  controller.logs = logs;
  return controller;
}

async function waitFor(predicate, { timeout = 3000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${predicate}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function waitForStatus(controller, statuses) {
  const wanted = [].concat(statuses);
  await waitFor(() => controller.session && wanted.includes(controller.session.status));
  return controller.session;
}

/** Text of each top-level element of the combined story. */
function combinedTexts(document) {
  const combined = document.querySelector('[data-lsp-combined]');
  return combined ? [...combined.children].map((el) => el.textContent.replace(/\s+/g, ' ').trim()) : null;
}

function isHidden(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.hasAttribute('data-lsp-hidden')) return true;
  }
  return false;
}

module.exports = {
  createSite, createPage, startController, waitFor, waitForStatus, combinedTexts, isHidden, wait, cleanup, TEST_CONFIG,
};
