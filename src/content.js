/*
 * Literotica Single-Page Reader: content script controller.
 *
 * Lifecycle for each story view:
 *   detect   parse the URL, wait until the DOM shows that story/page, and
 *            work out the page count from the page itself
 *   load     fetch the other pages (bounded concurrency, retries, validation)
 *   combine  once every page has arrived, insert one combined text container
 *            and hide (never delete) the original text and pagination
 *
 * Literotica is a client-side routed app: moving between pages and stories
 * changes the URL without reloading, and the site reuses the same DOM nodes.
 * The controller watches the URL, cancels stale work, and restores the
 * original DOM before handling a different story.
 */
(function (factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'), require('./loader.js'));
    return;
  }
  const api = factory(globalThis.LSPCore, globalThis.LSPLoader);
  // Guard against this script being evaluated twice in the same world.
  if (!globalThis.__lspController) {
    globalThis.__lspController = api.createController({ window });
    globalThis.__lspController.start();
  }
})(function (core, loader) {
  'use strict';

  const { ATTR } = core;
  const { PageLoadError } = loader;
  const LOG_PREFIX = '[Literotica Single-Page Reader]';
  const INSTANCE_ATTR = 'data-lsp-instance';
  const NO_ANCHOR_ATTR = 'data-lsp-noanchor';
  // Failures worth retrying with the pages already cached.
  const TRANSIENT_CODES = new Set(['network', 'timeout', 'http', 'not-found', 'forbidden']);

  const DEFAULTS = {
    concurrency: 3,
    timeoutMs: 20000,
    retries: 2,
    retryDelayMs: 600,
    pollMs: 750, // URL polling fallback for client-side navigation
    domWaitMs: 8000, // how long to wait for the DOM to show a newly navigated-to story
    domPollMs: 150,
    settleMs: 50, // pause after the load event before modifying the page
    cacheSize: 4, // stories kept in memory for back/forward navigation
    pageTopOffset: 16,
  };

  function describeError(err, total) {
    const page = err && err.page;
    const which = page && total ? `page ${page} of ${total}` : page ? `page ${page}` : 'a page';
    const Which = which.charAt(0).toUpperCase() + which.slice(1);
    let message;
    switch (err && err.code) {
      case 'not-found': message = `Couldn't find ${which}.`; break;
      case 'forbidden': message = `Literotica refused access to ${which}.`; break;
      case 'timeout': message = `Loading ${which} timed out.`; break;
      case 'network': message = `Network error while loading ${which}.`; break;
      case 'http': message = `Literotica returned an error (HTTP ${err.status}) for ${which}.`; break;
      case 'inconsistent-pagination': message = 'Couldn\'t reliably work out how many pages this story has.'; break;
      case 'duplicate-pages': message = 'Some pages of this story came back with identical content.'; break;
      default: message = `${Which} didn't look like part of this story.`;
    }
    return `${message} Showing the original pages.`;
  }

  /**
   * Reading position: the first element (in document order) whose bottom edge
   * is below the top of the viewport. If they're all above it (the reader has
   * scrolled past the story), the bottom edge of `fallback` is used instead.
   */
  function captureAnchor(elements, fallback) {
    for (let i = 0; i < elements.length; i++) {
      const rect = elements[i].getBoundingClientRect();
      if (rect.bottom > 0) return { index: i, el: elements[i], top: rect.top };
    }
    if (fallback) return { index: -1, el: fallback, bottom: fallback.getBoundingClientRect().bottom };
    return null;
  }

  /* ---------------------------------------------------------------- UI */

  function createUi(doc) {
    let root = null;

    function render(variant, children) {
      if (!root) {
        root = doc.createElement('div');
        root.setAttribute('data-lsp-ui', '');
      }
      if (!root.isConnected) (doc.body || doc.documentElement).appendChild(root);
      root.className = `lsp-ui lsp-ui--${variant}`;
      root.setAttribute('role', variant === 'error' ? 'alert' : 'status');
      root.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');
      root.replaceChildren(...children);
    }

    function text(value) {
      const span = doc.createElement('span');
      span.className = 'lsp-ui__text';
      span.textContent = value;
      return span;
    }

    function button(label, onClick, attrs) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'lsp-ui__button';
      b.textContent = label;
      for (const [k, v] of Object.entries(attrs || {})) b.setAttribute(k, v);
      b.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      return b;
    }

    function spinner() {
      const s = doc.createElement('span');
      s.className = 'lsp-ui__spinner';
      s.setAttribute('aria-hidden', 'true');
      return s;
    }

    return {
      loading(ready, total) {
        render('loading', [spinner(), text(`Combining pages… ${ready} of ${total}`)]);
      },
      combined(total, onRestore) {
        render('quiet', [
          text(`${total} pages combined`),
          button('Paged view', onRestore, { title: 'Restore Literotica\'s original page-by-page view' }),
        ]);
      },
      original(page, total, onCombine) {
        render('quiet', [
          text(`Page ${page} of ${total}`),
          button('Single page', onCombine, { title: 'Show every page of this story on one page' }),
        ]);
      },
      error(message, onRetry, onDismiss) {
        render('error', [
          text(message),
          button('Retry', onRetry),
          button('×', onDismiss, { 'aria-label': 'Dismiss', title: 'Dismiss' }),
        ]);
      },
      clear() {
        if (root) root.remove();
      },
      get element() {
        return root && root.isConnected ? root : null;
      },
    };
  }

  /* -------------------------------------------------------- Controller */

  function createController(env) {
    const win = env.window;
    const doc = win.document;
    const cfg = Object.assign({}, DEFAULTS, env.config);
    const fetchImpl = env.fetch || ((url, init) => win.fetch(url, init));
    const log = env.log || ((...args) => win.console.warn(LOG_PREFIX, ...args));
    // Sanitised page content lives in an inert document: nothing in it loads
    // or runs until it's copied into the live page.
    const inertDoc = doc.implementation.createHTMLDocument('');
    const cache = new Map(); // story id -> { total, pages: Map<page, { fragment, fingerprint }> }
    const ui = createUi(doc);

    let session = null;
    let started = false;
    let lastHref = null;
    let pollTimer = null;

    /* ---- lifecycle ---- */

    function start() {
      if (started) return false;
      const root = doc.documentElement;
      if (root.hasAttribute(INSTANCE_ATTR)) {
        log('another instance is already active on this page; not starting');
        return false;
      }
      root.setAttribute(INSTANCE_ATTR, '');
      started = true;
      lastHref = win.location.href;
      if (win.navigation && typeof win.navigation.addEventListener === 'function') {
        win.navigation.addEventListener('currententrychange', check);
      }
      win.addEventListener('popstate', check);
      pollTimer = win.setInterval(check, cfg.pollMs);
      handleLocation();
      return true;
    }

    function stop() {
      if (!started) return;
      started = false;
      if (win.navigation && typeof win.navigation.removeEventListener === 'function') {
        win.navigation.removeEventListener('currententrychange', check);
      }
      win.removeEventListener('popstate', check);
      win.clearInterval(pollTimer);
      teardown();
      doc.documentElement.removeAttribute(INSTANCE_ATTR);
    }

    /** Called on any possible URL change; cheap when nothing changed. */
    function check() {
      if (!started) return;
      const href = win.location.href;
      if (href === lastHref) return;
      lastHref = href;
      handleLocation();
    }

    function handleLocation() {
      const info = core.parseStoryUrl(win.location.href);
      if (session && info && info.id === session.story.id) {
        onSameStoryNavigation(session, info);
        return;
      }
      teardown();
      if (info) runSession(newSession(info));
    }

    function newSession(story) {
      return {
        story,
        livePage: story.page, // page the site itself is currently showing
        total: 0,
        status: 'detecting', // detecting | loading | combined | original | error | single | inactive
        abort: new AbortController(),
        analysis: null,
        combinedEl: null,
        hidden: [],
        observer: null,
        reconcileQueued: false,
        error: null,
      };
    }

    function isCurrent(s) {
      return s === session && !s.abort.signal.aborted;
    }

    /** Cancels the current session and puts the page back the way the site rendered it. */
    function teardown() {
      const s = session;
      session = null;
      if (s) {
        s.abort.abort();
        stopObserving(s);
        revertDom(s);
      }
      for (const el of doc.querySelectorAll(`[${ATTR.combined}]`)) el.remove();
      for (const el of doc.querySelectorAll(`[${ATTR.hidden}]`)) el.removeAttribute(ATTR.hidden);
      ui.clear();
    }

    function revertDom(s) {
      if (s.combinedEl) s.combinedEl.remove();
      for (const el of s.hidden) el.removeAttribute(ATTR.hidden);
      s.hidden = [];
    }

    /* ---- detection ---- */

    function analyzeLive(s, page) {
      const story = Object.assign({}, s.story, { page: page || s.livePage });
      return core.analyzeStoryDocument(doc, story, win.location.href);
    }

    /**
     * After client-side navigation the URL can change slightly before the
     * DOM does, so keep checking until the page shows the expected story.
     */
    async function waitForStoryDom(s, page) {
      const deadline = Date.now() + cfg.domWaitMs;
      for (;;) {
        const a = analyzeLive(s, page);
        if (a.ok || (a.reason !== 'mismatch' && a.reason !== 'not-story')) return a;
        if (Date.now() >= deadline || !isCurrent(s)) return a;
        await sleep(cfg.domPollMs);
      }
    }

    function sleep(ms) {
      return new Promise((resolve) => win.setTimeout(resolve, ms));
    }

    async function runSession(s) {
      session = s;
      const a = await waitForStoryDom(s, s.livePage);
      if (!isCurrent(s)) return;
      if (!a.ok) {
        const multiPage = a.total > 1 || a.reason === 'inconsistent-pagination';
        if (multiPage) failSession(s, new PageLoadError(a.reason, s.livePage, a.detail));
        else s.status = 'inactive'; // not a story page (or not one we recognise): leave it alone
        return;
      }
      if (a.total <= 1) {
        s.status = 'single';
        return;
      }
      s.total = a.total;
      await loadAndCombine(s);
    }

    /* ---- loading ---- */

    function cacheEntry(id, total) {
      let entry = cache.get(id);
      if (!entry || entry.total !== total) entry = { total, pages: new Map() };
      cache.delete(id);
      cache.set(id, entry); // most recently used last
      while (cache.size > cfg.cacheSize) cache.delete(cache.keys().next().value);
      return entry;
    }

    async function loadAndCombine(s) {
      s.status = 'loading';
      const entry = cacheEntry(s.story.id, s.total);
      const needed = [];
      for (let n = 1; n <= s.total; n++) {
        if (n !== s.livePage && !entry.pages.has(n)) needed.push(n);
      }
      const showProgress = () => {
        let ready = 0;
        for (let n = 1; n <= s.total; n++) if (n === s.livePage || entry.pages.has(n)) ready++;
        ui.loading(ready, s.total);
      };
      showProgress();

      try {
        await loader.loadPages(needed, {
          fetchImpl,
          signal: s.abort.signal,
          buildUrl: (n) => core.buildPageUrl(s.story, n),
          processPage: (response, n) => processFetchedPage(s, response, n),
          onPageLoaded: (n, value) => {
            entry.pages.set(n, value);
            if (isCurrent(s)) showProgress();
          },
          concurrency: cfg.concurrency,
          timeoutMs: cfg.timeoutMs,
          retries: cfg.retries,
          retryDelayMs: cfg.retryDelayMs,
        });
        await whenDocumentLoaded();
        if (!isCurrent(s)) return;
        combine(s, entry);
      } catch (err) {
        if (!isCurrent(s) || (err && err.code === 'aborted')) return;
        failSession(s, err);
      }
    }

    /** Validates a fetched page and extracts its sanitised story content. */
    function processFetchedPage(s, response, n) {
      const final = core.parseStoryUrl(response.finalUrl);
      if (!final || final.id !== s.story.id || final.page !== n) {
        throw new PageLoadError('redirected', n, `ended up at ${response.finalUrl}`);
      }
      const parsed = new win.DOMParser().parseFromString(response.text, 'text/html');
      const a = core.analyzeStoryDocument(parsed, Object.assign({}, s.story, { page: n }), response.finalUrl);
      if (!a.ok) {
        throw new PageLoadError(a.reason === 'not-story' ? 'unexpected-structure' : a.reason, n, a.detail);
      }
      if (a.total !== s.total) {
        throw new PageLoadError('inconsistent-pagination', n, `page ${n} reports ${a.total} pages, expected ${s.total}`);
      }
      const fragment = core.extractContent(a, response.finalUrl, inertDoc);
      if (!core.hasContent(fragment)) throw new PageLoadError('empty-page', n);
      return { fragment, fingerprint: core.fingerprint(fragment) };
    }

    /**
     * Resolves once the page has fully loaded, so the site's own scripts have
     * hydrated the DOM before it gets modified.
     */
    function whenDocumentLoaded() {
      return new Promise((resolve) => {
        const settle = () => win.setTimeout(resolve, cfg.settleMs);
        if (doc.readyState === 'complete') settle();
        else win.addEventListener('load', settle, { once: true });
      });
    }

    /* ---- combining ---- */

    function combine(s, entry) {
      const a = analyzeLive(s);
      if (!a.ok) throw new PageLoadError(a.reason === 'not-story' ? 'unexpected-structure' : a.reason, s.livePage, a.detail);
      if (a.total !== s.total) {
        throw new PageLoadError('inconsistent-pagination', s.livePage, `page count changed to ${a.total}`);
      }
      const liveFragment = core.extractContent(a, win.location.href, inertDoc);
      if (!core.hasContent(liveFragment)) throw new PageLoadError('empty-page', s.livePage);
      entry.pages.set(s.livePage, { fragment: liveFragment, fingerprint: core.fingerprint(liveFragment) });

      const pages = [];
      for (let n = 1; n <= s.total; n++) {
        const page = entry.pages.get(n);
        if (!page) throw new PageLoadError('missing-page', n);
        pages.push({ page: n, fragment: page.fragment, fingerprint: page.fingerprint });
      }
      const duplicate = core.findDuplicatePages(pages);
      if (duplicate) {
        throw new PageLoadError('duplicate-pages', duplicate[1], `pages ${duplicate[0]} and ${duplicate[1]} are identical`);
      }
      s.combinedEl = core.buildCombined(doc, a, pages);
      showCombined(s, a);
    }

    /** The original elements that data-lsp-src indexes refer to. */
    function originalElements(a) {
      return a.mode === 'wrapper' ? [...a.container.children] : a.originals;
    }

    function combinedElementFor(s, page, srcIndex) {
      const scope = s.combinedEl;
      const exact = scope.querySelector(`:scope > [${ATTR.page}="${page}"][${ATTR.src}="${srcIndex}"]`);
      if (exact) return exact;
      // The original element was dropped during sanitising (an ad, say):
      // use the next element that survived.
      for (const el of scope.querySelectorAll(`:scope > [${ATTR.page}="${page}"]`)) {
        if (Number(el.getAttribute(ATTR.src)) > srcIndex) return el;
      }
      return scope.querySelector(`:scope > [${ATTR.page}="${page}"]`);
    }

    function scrollByInstant(delta) {
      if (Math.abs(delta) < 1 || typeof win.scrollBy !== 'function') return;
      try {
        win.scrollBy({ top: delta, left: 0, behavior: 'instant' });
      } catch (e) {
        win.scrollBy(0, delta);
      }
    }

    /**
     * Runs a DOM swap with the browser's own scroll anchoring off, so the
     * manual position correction below is the only adjustment made.
     */
    function swap(fn) {
      const root = doc.documentElement;
      root.setAttribute(NO_ANCHOR_ATTR, '');
      try {
        fn();
      } finally {
        const release = () => root.removeAttribute(NO_ANCHOR_ATTR);
        if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(() => win.requestAnimationFrame(release));
        else win.setTimeout(release, 50);
      }
    }

    function hide(s, el) {
      if (!el || el.hasAttribute(ATTR.hidden)) return;
      el.setAttribute(ATTR.hidden, '');
      s.hidden.push(el);
    }

    function hideOriginals(s, a) {
      a.originals.forEach((el) => hide(s, el));
      a.paginationContainers.forEach((el) => hide(s, el));
      hide(s, a.counterElement);
    }

    function showCombined(s, analysis) {
      const a = analysis || analyzeLive(s);
      if (!a.ok) {
        failSession(s, new PageLoadError(a.reason, s.livePage, a.detail));
        return;
      }
      if (doc.querySelector(`[${ATTR.combined}]`) && !s.combinedEl.isConnected) {
        log('story is already combined on this page; not combining again');
        s.status = 'inactive';
        ui.clear();
        return;
      }
      s.analysis = a;
      // Keep the paragraph the reader is looking at exactly where it is on screen.
      const anchor = captureAnchor(originalElements(a), a.articleBody);
      swap(() => {
        a.originals[0].parentNode.insertBefore(s.combinedEl, a.originals[0]);
        hideOriginals(s, a);
        if (anchor && anchor.index >= 0) {
          const target = combinedElementFor(s, s.livePage, anchor.index);
          if (target) scrollByInstant(target.getBoundingClientRect().top - anchor.top);
        } else if (anchor) {
          scrollByInstant(anchor.el.getBoundingClientRect().bottom - anchor.bottom);
        }
      });
      s.status = 'combined';
      ui.combined(s.total, () => showOriginal(s));
      observe(s, a.articleBody);
    }

    /** Switches back to the site's own paginated view (content stays cached). */
    function showOriginal(s) {
      if (!isCurrent(s) || s.status !== 'combined') return;
      const a = s.analysis;
      const anchor = captureAnchor([...s.combinedEl.children], a.articleBody);
      stopObserving(s);
      swap(() => {
        revertDom(s);
        if (anchor && anchor.index >= 0) {
          const page = Number(anchor.el.getAttribute(ATTR.page));
          const src = Number(anchor.el.getAttribute(ATTR.src));
          const originals = originalElements(a);
          const exact = page === s.livePage ? originals[src] : null;
          if (exact) {
            scrollByInstant(exact.getBoundingClientRect().top - anchor.top);
          } else if (originals[0]) {
            // The reader was on another page of the story: show the start of the page the site has open.
            const top = originals[0].getBoundingClientRect().top;
            if (top < 0 || top > (win.innerHeight || 0)) scrollByInstant(top - cfg.pageTopOffset);
          }
        } else if (anchor) {
          scrollByInstant(anchor.el.getBoundingClientRect().bottom - anchor.bottom);
        }
      });
      s.status = 'original';
      ui.original(s.livePage, s.total, () => recombine(s));
    }

    function recombine(s) {
      if (!isCurrent(s) || s.status !== 'original') return;
      const a = analyzeLive(s);
      if (!a.ok || a.total !== s.total) {
        failSession(s, new PageLoadError(a.ok ? 'inconsistent-pagination' : a.reason, s.livePage, a.detail));
        return;
      }
      showCombined(s, a);
    }

    function failSession(s, err) {
      if (!isCurrent(s)) return;
      const error = err instanceof PageLoadError ? err : new PageLoadError('unexpected-structure', null, err && err.message);
      s.status = 'error';
      s.error = error;
      stopObserving(s);
      revertDom(s); // the original page stays (or becomes again) exactly as the site rendered it
      if (!TRANSIENT_CODES.has(error.code)) cache.delete(s.story.id);
      log(error.message);
      ui.error(describeError(error, s.total), () => retry(s), () => ui.clear());
    }

    function retry(s) {
      if (!isCurrent(s)) return;
      const story = Object.assign({}, s.story, { page: s.livePage });
      teardown();
      runSession(newSession(story));
    }

    /* ---- staying in sync with the site ---- */

    function onSameStoryNavigation(s, info) {
      // Extra parameters (e.g. "?dialog=log-in") open overlays rather than pages.
      if (info.otherParams.length) return;
      if (info.page === s.livePage) {
        scheduleReconcile(s);
        return;
      }
      if (s.status === 'detecting' || s.status === 'loading') {
        // The page the site shows changed mid-load: start over, reusing whatever is cached.
        teardown();
        runSession(newSession(Object.assign({}, s.story, { page: info.page })));
        return;
      }
      waitForStoryDom(s, info.page).then((a) => {
        if (!isCurrent(s) || !a.ok) return;
        s.livePage = info.page;
        if (s.status === 'combined') {
          reconcile(s, a);
          // The site may reset the scroll position after it navigates; scroll afterwards.
          win.setTimeout(() => {
            if (isCurrent(s) && s.status === 'combined') scrollToPage(s, info.page);
          }, 0);
        } else if (s.status === 'original') {
          s.analysis = a;
          ui.original(s.livePage, s.total, () => recombine(s));
        }
      });
    }

    function scrollToPage(s, page) {
      const first = s.combinedEl.querySelector(`:scope > [${ATTR.page}="${page}"]`);
      if (first) scrollByInstant(first.getBoundingClientRect().top - cfg.pageTopOffset);
    }

    /** Re-applies the combined view if the site re-rendered parts of the page. */
    function reconcile(s, analysis) {
      if (!isCurrent(s) || s.status !== 'combined') return;
      const a = analysis || analyzeLive(s);
      if (!a.ok) return;
      s.analysis = a;
      if (!s.combinedEl.isConnected) a.originals[0].parentNode.insertBefore(s.combinedEl, a.originals[0]);
      hideOriginals(s, a);
      if (!ui.element) ui.combined(s.total, () => showOriginal(s));
    }

    function scheduleReconcile(s) {
      if (s.reconcileQueued) return;
      s.reconcileQueued = true;
      win.setTimeout(() => {
        s.reconcileQueued = false;
        reconcile(s);
      }, 0);
    }

    function observe(s, target) {
      stopObserving(s);
      if (typeof win.MutationObserver !== 'function') return;
      s.observer = new win.MutationObserver(() => scheduleReconcile(s));
      s.observer.observe(target, { childList: true });
    }

    function stopObserving(s) {
      if (s.observer) s.observer.disconnect();
      s.observer = null;
    }

    return {
      start,
      stop,
      check,
      get session() {
        return session;
      },
      get cache() {
        return cache;
      },
      // Exposed for tests.
      _showOriginal: () => session && showOriginal(session),
      _recombine: () => session && recombine(session),
      _retry: () => session && retry(session),
    };
  }

  return { createController, describeError, captureAnchor, DEFAULTS };
});
