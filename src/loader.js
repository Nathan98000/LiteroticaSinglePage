/*
 * Literotica Single-Page Reader: page loading.
 *
 * Fetches story pages with bounded concurrency, a timeout per request and
 * retries for transient failures. The first permanent failure stops the whole
 * load, so a story is never presented with pages missing.
 */
(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.LSPLoader = globalThis.LSPLoader || api;
})(function () {
  'use strict';

  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_HTML_LENGTH = 20 * 1024 * 1024;

  class PageLoadError extends Error {
    /**
     * @param {string} code    machine-readable reason (see describeError in content.js)
     * @param {number} [page]  page number the failure relates to
     * @param {string} [detail]
     * @param {object} [extra] { retryable, status, retryAfterMs }
     */
    constructor(code, page, detail, extra) {
      super(`${code}${page ? ` (page ${page})` : ''}${detail ? `: ${detail}` : ''}`);
      this.name = 'PageLoadError';
      this.code = code;
      this.page = page || null;
      this.detail = detail || '';
      this.retryable = !!(extra && extra.retryable);
      this.status = extra && extra.status ? extra.status : null;
      this.retryAfterMs = extra && extra.retryAfterMs ? extra.retryAfterMs : null;
    }
  }

  function abortedError(page) {
    return new PageLoadError('aborted', page);
  }

  function parseRetryAfter(value) {
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortedError());
      const timer = setTimeout(done, ms);
      function done() {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }
      function onAbort() {
        clearTimeout(timer);
        reject(abortedError());
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Fetches one URL as text. Resolves with { text, finalUrl, status } or
   * rejects with a PageLoadError.
   */
  async function fetchText(url, options) {
    const { fetchImpl, signal, timeoutMs, page } = options;
    if (signal && signal.aborted) throw abortedError(page);

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const transportError = (err) => {
      if (signal && signal.aborted) return abortedError(page);
      if (timedOut) return new PageLoadError('timeout', page, `no response within ${timeoutMs} ms`, { retryable: true });
      return new PageLoadError('network', page, err && err.message, { retryable: true });
    };

    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          credentials: 'same-origin', // keeps the user's own Literotica session
          redirect: 'follow',
          signal: controller.signal,
          headers: { Accept: 'text/html' },
        });
      } catch (err) {
        throw transportError(err);
      }

      const headers = response.headers;
      const getHeader = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : null);
      if (!response.ok) {
        const status = response.status;
        const code = status === 404 || status === 410 ? 'not-found'
          : status === 401 || status === 403 ? 'forbidden'
            : 'http';
        throw new PageLoadError(code, page, `HTTP ${status}`, {
          status,
          retryable: RETRYABLE_STATUS.has(status),
          retryAfterMs: parseRetryAfter(getHeader('retry-after')),
        });
      }
      const contentType = getHeader('content-type');
      if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        throw new PageLoadError('unexpected-response', page, contentType);
      }

      let text;
      try {
        text = await response.text();
      } catch (err) {
        throw transportError(err);
      }
      if (text.length > MAX_HTML_LENGTH) throw new PageLoadError('unexpected-response', page, 'response too large');
      return { text, finalUrl: response.url || url, status: response.status };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  function toPageLoadError(err, page) {
    if (err instanceof PageLoadError) {
      if (!err.page) err.page = page;
      return err;
    }
    return new PageLoadError('unexpected-structure', page, err && err.message);
  }

  /**
   * Loads the given page numbers.
   *
   * @param {number[]} pageNumbers
   * @param {object} options
   *   fetchImpl     fetch-compatible function
   *   buildUrl      (n) => URL of page n
   *   processPage   (response, n) => value; throw a PageLoadError to reject a page
   *   signal        AbortSignal that cancels everything
   *   concurrency   max simultaneous requests (default 3)
   *   timeoutMs     per-request timeout (default 20 s)
   *   retries       extra attempts for transient failures (default 2)
   *   retryDelayMs  base back-off delay, doubled per attempt (default 600)
   *   onPageLoaded  (n, value, loadedCount) progress callback
   * @returns {Promise<Map<number, *>>} values by page number. On failure,
   *   rejects with a PageLoadError whose `loaded` property holds the pages
   *   that did succeed.
   */
  async function loadPages(pageNumbers, options) {
    const {
      fetchImpl, buildUrl, processPage, signal, onPageLoaded,
      concurrency = 3, timeoutMs = 20000, retries = 2, retryDelayMs = 600,
    } = options;

    const queue = [...new Set(pageNumbers)];
    const results = new Map();
    if (signal && signal.aborted) throw abortedError();
    if (!queue.length) return results;

    // Stops the remaining requests on the first permanent failure.
    const internal = new AbortController();
    const onAbort = () => internal.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let failure = null;

    async function loadOne(n) {
      const url = buildUrl(n);
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await fetchText(url, { fetchImpl, signal: internal.signal, timeoutMs, page: n });
          return await processPage(response, n);
        } catch (err) {
          const error = toPageLoadError(err, n);
          if (internal.signal.aborted) throw abortedError(n);
          if (!error.retryable || attempt >= retries) throw error;
          const backoff = retryDelayMs * 2 ** attempt;
          await delay(Math.min(Math.max(backoff, error.retryAfterMs || 0), 10000), internal.signal);
        }
      }
    }

    async function worker() {
      while (queue.length && !failure) {
        const n = queue.shift();
        try {
          const value = await loadOne(n);
          if (failure || internal.signal.aborted) return;
          results.set(n, value);
          if (onPageLoaded) onPageLoaded(n, value, results.size);
        } catch (err) {
          if (!failure) {
            failure = err;
            internal.abort();
          }
          return;
        }
      }
    }

    try {
      const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker);
      await Promise.all(workers);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (signal && signal.aborted) throw abortedError();
    if (failure) {
      // An abort caused by our own fail-fast isn't the real failure.
      failure.loaded = results;
      throw failure;
    }
    return results;
  }

  return { PageLoadError, fetchText, loadPages, parseRetryAfter, RETRYABLE_STATUS };
});
