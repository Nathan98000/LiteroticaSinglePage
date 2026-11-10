/*
 * Literotica Single-Page Reader: core logic.
 *
 * Pure DOM functions with no extension APIs and no network access, so they can
 * be unit tested against HTML fixtures. Everything here works on any Document,
 * either the live page or an inert document produced by DOMParser.
 *
 * Findings this is built on (see README, "How it works"):
 *  - Works live at /s/<slug> (stories, audio, illustrated) and /p/<slug> (poems)
 *    on www.literotica.com and the language subdomains (german., french., ...).
 *  - Page N > 1 is "?page=N"; page 1 is the bare URL.
 *  - The story text of a page is the main <div> inside [itemprop="articleBody"].
 *  - Pagination links live in <nav> elements (labels are localised, so they are
 *    identified by their hrefs, not their text). A print-only "Page X of Y"
 *    counter and <link rel="canonical"> describe the current page.
 */
(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.LSPCore = globalThis.LSPCore || api;
})(function () {
  'use strict';

  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const MAX_PAGES = 1000;

  // Subdomains of literotica.com that never host story pages.
  const NON_STORY_SUBDOMAINS = new Set(['forum', 'shop', 'speedy', 'vipcams', 'uploads', 'api']);

  const STORY_PATH = /^\/(s|p)\/([A-Za-z0-9][A-Za-z0-9_.~%-]{0,300})\/?$/;
  const PAGE_VALUE = /^[1-9][0-9]{0,3}$/;

  // Attribute names this extension adds to the live page.
  const ATTR = {
    combined: 'data-lsp-combined',
    hidden: 'data-lsp-hidden',
    page: 'data-lsp-page',
    src: 'data-lsp-src',
  };

  /* ------------------------------------------------------------------ URLs */

  function isLiteroticaHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (host === 'www.literotica.com') return true;
    const match = /^([a-z]{2,20})\.literotica\.com$/.exec(host);
    return !!match && !NON_STORY_SUBDOMAINS.has(match[1]);
  }

  /**
   * Parses a Literotica work URL. Returns null for anything that is not an
   * https URL of a story/poem page on a Literotica host, or whose page
   * parameter is not a plain positive integer.
   */
  function parseStoryUrl(href, base) {
    let url;
    try {
      url = new URL(href, base);
    } catch (e) {
      return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!isLiteroticaHost(url.hostname)) return null;
    const match = STORY_PATH.exec(url.pathname);
    if (!match) return null;

    const values = url.searchParams.getAll('page');
    if (values.length > 1) return null;
    let page = 1;
    if (values.length === 1) {
      if (!PAGE_VALUE.test(values[0])) return null;
      page = Number(values[0]);
    }
    const kind = match[1];
    const slug = match[2];
    const otherParams = [...new Set([...url.searchParams.keys()])].filter((k) => k !== 'page');
    return {
      origin: url.origin,
      kind,
      slug,
      page,
      id: `${url.origin}/${kind}/${slug.toLowerCase()}`,
      otherParams,
    };
  }

  function sameWork(a, b) {
    return !!a && !!b && a.kind === b.kind && a.slug.toLowerCase() === b.slug.toLowerCase();
  }

  /** Builds the URL of page `n` of a story, always on the story's own origin. */
  function buildPageUrl(story, n) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGES) throw new RangeError(`Invalid page number: ${n}`);
    return `${story.origin}/${story.kind}/${story.slug}${n > 1 ? `?page=${n}` : ''}`;
  }

  /**
   * Returns the page number an <a href> points to if it is a plain link to a
   * page of `story` on the same origin, otherwise null. Links carrying extra
   * query parameters (e.g. "?dialog=report-work") are not page links.
   */
  function pageLinkTarget(story, href, baseUrl) {
    if (!href) return null;
    const info = parseStoryUrl(href, baseUrl);
    if (!info || info.origin !== story.origin || !sameWork(info, story)) return null;
    if (info.otherParams.length) return null;
    return info.page;
  }

  /* -------------------------------------------------------- Page analysis */

  function fail(reason, detail, extra) {
    return Object.assign({ ok: false, reason, detail: detail || '' }, extra);
  }

  function isOurs(el) {
    return !!(el.closest && el.closest(`[${ATTR.combined}], [data-lsp-ui]`));
  }

  function readCanonical(doc, baseUrl) {
    const link = doc.querySelector('link[rel~="canonical"][href]');
    return link ? parseStoryUrl(link.getAttribute('href'), baseUrl) : null;
  }

  /** Reads the "Page X of Y" counter (any language, ASCII digits). */
  function readPageCounter(doc) {
    const nodes = doc.querySelectorAll('[class*="page_counter"], [class*="pageCounter"], [class*="page-counter"]');
    for (const el of nodes) {
      if (isOurs(el)) continue;
      const numbers = el.textContent.match(/[0-9]+/g) || [];
      if (numbers.length !== 2) continue;
      const current = Number(numbers[0]);
      const total = Number(numbers[1]);
      if (current >= 1 && total >= current) return { current, total, element: el };
    }
    return null;
  }

  /**
   * The element holding a pagination link: its <nav>, otherwise the outermost
   * ancestor with "pagination"/"pager" in its class. Items such as
   * "pagination__item" also match, which is why the outermost one is used.
   */
  function paginationContainerOf(a, articleBody) {
    const nav = a.closest('nav');
    if (nav) return articleBody && nav.contains(articleBody) ? null : nav;
    let found = null;
    for (let el = a.parentElement; el && el.localName !== 'body'; el = el.parentElement) {
      if (articleBody && el.contains(articleBody)) break;
      if (/pagination|pager/i.test(el.getAttribute('class') || '')) found = el;
    }
    return found;
  }

  /**
   * Collects links to pages of `story` outside the story text, plus the
   * elements that hold the pagination controls.
   */
  function collectPagination(doc, story, baseUrl, articleBody) {
    const pageLinks = [];
    for (const a of doc.querySelectorAll('a[href]')) {
      if ((articleBody && articleBody.contains(a)) || isOurs(a)) continue;
      const n = pageLinkTarget(story, a.getAttribute('href'), baseUrl);
      if (n !== null) pageLinks.push({ a, n });
    }

    // Group links by their pagination container (a <nav> or a "pagination"
    // classed element). A lone link back to page 1, like a linked title or a
    // breadcrumb, doesn't make its container a pagination control.
    const groups = new Map();
    for (const link of pageLinks) {
      const container = paginationContainerOf(link.a, articleBody);
      if (!container) continue;
      if (!groups.has(container)) groups.set(container, []);
      groups.get(container).push(link.n);
    }
    const containers = [];
    const pages = new Set();
    for (const [container, numbers] of groups) {
      if (numbers.length >= 2 || numbers.some((n) => n >= 2)) {
        containers.push(container);
        numbers.forEach((n) => pages.add(n));
      }
    }
    // Fallback for markup without recognisable containers: any same-story link.
    if (!containers.length) pageLinks.forEach((link) => pages.add(link.n));

    // Drop containers nested inside another container.
    const outer = containers.filter((c) => !containers.some((o) => o !== c && o.contains(c)));
    return { pages: [...pages].sort((x, y) => x - y), containers: outer };
  }

  const CHROME_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'form', 'nav', 'aside', 'button', 'iframe',
    '.print-hidden', '[class*="report" i]', 'a[href*="dialog="]',
    `[${ATTR.combined}]`, '[data-lsp-ui]',
  ].join(',');

  const CONTAINER_TAGS = new Set(['div', 'section', 'article', 'main']);

  function isChrome(el) {
    return el.nodeType === 1 && el.matches(CHROME_SELECTOR);
  }

  function textLength(node) {
    return normalizeText(node.textContent).length;
  }

  function mediaCount(el) {
    return el.querySelectorAll ? el.querySelectorAll('img, picture, video').length : 0;
  }

  /**
   * Finds the element holding the story text inside [itemprop=articleBody].
   * Normally that's the one wrapper <div> ("wrapper" mode). If the text sits
   * directly inside articleBody instead, the content elements themselves are
   * used ("inline" mode).
   */
  function findTextContainer(articleBody) {
    let best = null;
    let bestScore = 0;
    let inlineScore = 0;
    let looseText = 0;
    for (const node of articleBody.childNodes) {
      if (node.nodeType === 3) {
        looseText += normalizeText(node.data).length;
        continue;
      }
      if (node.nodeType !== 1 || isChrome(node)) continue;
      const score = textLength(node) + mediaCount(node) * 50;
      if (CONTAINER_TAGS.has(node.localName)) {
        if (score > bestScore) {
          best = node;
          bestScore = score;
        }
      } else {
        inlineScore += score;
      }
    }
    if (best && bestScore >= inlineScore + looseText) {
      return { mode: 'wrapper', container: best, originals: [best] };
    }
    if (inlineScore > 0) {
      if (looseText > 0) return null; // bare text nodes can't be hidden and restored cleanly
      const originals = [...articleBody.children].filter((el) => !isChrome(el));
      return { mode: 'inline', container: articleBody, originals };
    }
    return null;
  }

  /**
   * Analyses a document that should show page `story.page` of `story`.
   * On success, returns { ok: true, total, ... }. Otherwise returns
   * { ok: false, reason }, where reason is one of:
   *   not-story               no story body on the page
   *   mismatch                the page shows a different story or page than expected
   *   inconsistent-pagination the page-count signals contradict each other
   *   unexpected-structure    a story page whose text can't be located
   */
  function analyzeStoryDocument(doc, story, baseUrl) {
    const bodies = [...doc.querySelectorAll('[itemprop~="articleBody"]')].filter((el) => !isOurs(el));
    if (bodies.length === 0) return fail('not-story', 'no [itemprop=articleBody]');
    if (bodies.length > 1) return fail('unexpected-structure', 'multiple story bodies');
    const articleBody = bodies[0];

    const canonical = readCanonical(doc, baseUrl);
    if (canonical && (!sameWork(canonical, story) || canonical.page !== story.page)) {
      return fail('mismatch', `canonical is ${canonical.kind}/${canonical.slug} page ${canonical.page}`);
    }
    const counter = readPageCounter(doc);
    if (counter && counter.current !== story.page) {
      return fail('mismatch', `page counter says page ${counter.current}`);
    }

    const pagination = collectPagination(doc, story, baseUrl, articleBody);
    const linkMax = Math.max(story.page, ...pagination.pages);
    let total = linkMax;
    if (counter) {
      if (linkMax > counter.total) {
        return fail('inconsistent-pagination', `links reach page ${linkMax} but counter says ${counter.total}`);
      }
      total = counter.total;
    }
    if (total > MAX_PAGES) return fail('inconsistent-pagination', `implausible page count ${total}`);

    const text = findTextContainer(articleBody);
    if (!text) return fail('unexpected-structure', 'story text not found', { total });

    return {
      ok: true,
      page: story.page,
      total,
      articleBody,
      mode: text.mode,
      container: text.container,
      originals: text.originals,
      paginationContainers: pagination.containers,
      counterElement: counter ? counter.element : null,
    };
  }

  /* -------------------------------------------------------- Sanitisation */

  // Removed together with everything inside them.
  const DROP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed',
    'applet', 'param', 'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea',
    'link', 'meta', 'base', 'title', 'head', 'canvas', 'dialog', 'portal', 'slot', 'nav',
  ]);

  // Kept, with only their allowlisted attributes. Unknown elements are
  // unwrapped (their contents are kept).
  const ALLOWED_TAGS = new Set([
    'p', 'br', 'hr', 'div', 'span', 'section', 'article', 'header', 'footer', 'aside', 'main',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'q', 'cite', 'pre', 'code', 'kbd', 'samp',
    'var', 'em', 'i', 'strong', 'b', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'small',
    'big', 'mark', 'abbr', 'acronym', 'dfn', 'time', 'wbr', 'center', 'font', 'address', 'bdi',
    'bdo', 'ruby', 'rt', 'rp', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'caption', 'thead',
    'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col', 'figure', 'figcaption', 'picture',
    'img', 'audio', 'video', 'source', 'track', 'a', 'details', 'summary',
  ]);

  const GLOBAL_ATTRS = new Set(['class', 'style', 'title', 'lang', 'dir', 'id', 'align']);
  const TAG_ATTRS = {
    a: ['href', 'target', 'rel', 'name'],
    img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding'],
    audio: ['src', 'controls', 'loop', 'muted', 'preload'],
    video: ['src', 'controls', 'loop', 'muted', 'preload', 'poster', 'width', 'height', 'playsinline'],
    source: ['src', 'srcset', 'sizes', 'type', 'media'],
    track: ['src', 'kind', 'srclang', 'label', 'default'],
    ol: ['start', 'type', 'reversed'],
    ul: ['type'],
    li: ['value', 'type'],
    table: ['border', 'cellpadding', 'cellspacing', 'width', 'summary'],
    td: ['colspan', 'rowspan', 'headers', 'width', 'height', 'valign'],
    th: ['colspan', 'rowspan', 'headers', 'width', 'height', 'valign', 'scope', 'abbr'],
    col: ['span', 'width'],
    colgroup: ['span', 'width'],
    blockquote: ['cite'],
    q: ['cite'],
    del: ['cite', 'datetime'],
    ins: ['cite', 'datetime'],
    time: ['datetime'],
    font: ['color', 'face', 'size'],
    hr: ['size', 'width', 'noshade'],
    details: ['open'],
  };
  const URL_ATTRS = new Set(['href', 'src', 'poster', 'cite']);
  const SAFE_REL = new Set(['nofollow', 'noopener', 'noreferrer', 'ugc', 'external', 'sponsored', 'author', 'license', 'tag']);
  const SAFE_STYLE_PROPS = new Set([
    'text-align', 'font-style', 'font-weight', 'font-variant', 'font-size', 'font-family',
    'text-decoration', 'text-decoration-line', 'text-transform', 'text-indent', 'letter-spacing',
    'line-height', 'color', 'background-color', 'white-space', 'vertical-align', 'direction',
    'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'padding',
    'padding-left', 'padding-right', 'padding-top', 'padding-bottom', 'width', 'max-width',
    'height', 'border', 'border-collapse', 'list-style-type',
  ]);

  // Ad containers sometimes injected into the live story text.
  const AD_SELECTOR = [
    'ins.adsbygoogle', '[id^="div-gpt-ad"]', '[data-ad-slot]', '[data-google-query-id]',
    '[class*="advert" i]', '[class*="adslot" i]', '[class*="ad-container" i]',
  ].join(',');

  function safeUrl(value, baseUrl, attr, tag) {
    const raw = String(value).trim();
    if (!raw) return null;
    if (attr === 'href' && raw.startsWith('#')) return raw;
    if (tag === 'img' && attr === 'src' && /^data:image\/(png|gif|jpe?g|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(raw)) {
      return raw;
    }
    let url;
    try {
      url = new URL(raw, baseUrl);
    } catch (e) {
      return null;
    }
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    if (attr === 'href' && url.protocol === 'mailto:') return url.href;
    return null;
  }

  function safeSrcset(value, baseUrl) {
    const out = [];
    for (const candidate of String(value).split(',')) {
      const parts = candidate.trim().split(/\s+/);
      if (!parts[0]) continue;
      const url = safeUrl(parts[0], baseUrl, 'srcset', '');
      if (!url) return null;
      const descriptor = parts.slice(1).join(' ');
      if (descriptor && !/^\d+(\.\d+)?[wx]$/.test(descriptor)) return null;
      out.push(descriptor ? `${url} ${descriptor}` : url);
    }
    return out.length ? out.join(', ') : null;
  }

  function safeStyle(value) {
    const kept = [];
    for (const declaration of String(value).split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const prop = declaration.slice(0, colon).trim().toLowerCase();
      const val = declaration.slice(colon + 1).trim();
      if (!SAFE_STYLE_PROPS.has(prop) || !val) continue;
      if (/url\s*\(|expression\s*\(|javascript:|[\\<>@]/i.test(val)) continue;
      kept.push(`${prop}: ${val}`);
    }
    return kept.length ? kept.join('; ') : null;
  }

  function copyAttribute(out, tag, name, value, baseUrl) {
    const allowed = GLOBAL_ATTRS.has(name) || (TAG_ATTRS[tag] && TAG_ATTRS[tag].includes(name));
    if (!allowed) return;
    let clean = value;
    if (URL_ATTRS.has(name)) clean = safeUrl(value, baseUrl, name, tag);
    else if (name === 'srcset') clean = safeSrcset(value, baseUrl);
    else if (name === 'style') clean = safeStyle(value);
    else if (name === 'target') clean = value.trim().toLowerCase() === '_blank' ? '_blank' : null;
    else if (name === 'rel') {
      clean = value.toLowerCase().split(/\s+/).filter((t) => SAFE_REL.has(t)).join(' ') || null;
    } else if (name === 'loading') clean = /^(lazy|eager)$/i.test(value) ? value.toLowerCase() : null;
    if (clean !== null && clean !== undefined) out.setAttribute(name, clean);
  }

  function sanitizeNode(node, ctx, depth) {
    if (node.nodeType === 3) return ctx.doc.createTextNode(node.data);
    if (node.nodeType !== 1) return null; // comments, processing instructions
    if (node.namespaceURI !== HTML_NS) return null; // inline SVG / MathML
    const tag = node.localName;
    if (DROP_TAGS.has(tag) || depth > 64) return null;
    if (node.matches(AD_SELECTOR) || node.hasAttribute(ATTR.combined) || node.hasAttribute('data-lsp-ui')) {
      return null;
    }

    let out;
    if (ALLOWED_TAGS.has(tag)) {
      out = ctx.doc.createElement(tag);
      // Imported images load lazily: they aren't fetched until they're displayed.
      if (tag === 'img' && !node.hasAttribute('loading')) out.setAttribute('loading', 'lazy');
      for (const attr of node.attributes) {
        copyAttribute(out, tag, attr.name.toLowerCase(), attr.value, ctx.baseUrl);
      }
      if (tag === 'a' && out.getAttribute('target') === '_blank') {
        const rel = new Set((out.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
        rel.add('noopener');
        out.setAttribute('rel', [...rel].join(' '));
      }
    } else {
      out = ctx.doc.createDocumentFragment();
    }
    for (const child of node.childNodes) {
      const clean = sanitizeNode(child, ctx, depth + 1);
      if (clean) out.appendChild(clean);
    }
    return out;
  }

  /**
   * Returns a sanitised copy of a page's story content as a DocumentFragment
   * owned by `targetDoc` (normally an inert document, so nothing loads until
   * it's displayed). Top-level elements get a data-lsp-src attribute holding
   * the index of the original element they came from; restoring the scroll
   * position relies on it.
   */
  function extractContent(analysis, baseUrl, targetDoc) {
    const ctx = { doc: targetDoc, baseUrl };
    const fragment = targetDoc.createDocumentFragment();
    const sources = analysis.mode === 'wrapper'
      ? [...analysis.container.childNodes]
      : analysis.originals;
    let elementIndex = -1;
    for (const node of sources) {
      if (node.nodeType === 1) elementIndex += 1;
      if (node.nodeType === 1 && isChrome(node)) continue;
      const clean = sanitizeNode(node, ctx, 0);
      if (!clean) continue;
      const tops = clean.nodeType === 11 ? [...clean.childNodes] : [clean];
      for (const top of tops) {
        if (top.nodeType === 1) top.setAttribute(ATTR.src, String(elementIndex));
      }
      fragment.appendChild(clean);
    }
    return fragment;
  }

  /* -------------------------------------------------------- Combination */

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function hasContent(fragment) {
    return normalizeText(fragment.textContent).length > 0 || !!fragment.querySelector('img, picture, video, audio');
  }

  /** Text plus media sources: identical pages produce identical fingerprints. */
  function fingerprint(fragment) {
    const media = [...fragment.querySelectorAll('img[src], source[src], video[src], audio[src]')]
      .map((el) => el.getAttribute('src'));
    return `${normalizeText(fragment.textContent)}\u0000${media.join('\u0000')}`;
  }

  /**
   * Returns [a, b] for the first two pages with identical, non-empty
   * content, which usually means the site ignored the page parameter.
   */
  function findDuplicatePages(pages) {
    const seen = new Map();
    for (const { page, fingerprint: fp } of pages) {
      if (!fp || fp === '\u0000') continue;
      if (seen.has(fp)) return [seen.get(fp), page];
      seen.set(fp, page);
    }
    return null;
  }

  function isSignificant(n) {
    return (n.nodeType === 1 || n.nodeType === 3) && normalizeText(n.textContent) !== '';
  }

  function significantNodes(parent) {
    return [...parent.childNodes].filter(isSignificant);
  }

  /**
   * If `next` begins with the same paragraph(s) the previous page ends with,
   * removes them from `next`. `prev` is the previous page's container or an
   * array of its last top-level nodes. Matches must be exact and add up to at
   * least `minChars`, so short repeated lines such as scene breaks ("* * *")
   * are never touched. Returns the number of nodes removed.
   */
  function trimBoundaryOverlap(prev, next, options) {
    const { maxNodes = 3, minChars = 100 } = options || {};
    const tail = Array.isArray(prev) ? prev.filter(isSignificant) : significantNodes(prev);
    const head = significantNodes(next);
    for (let m = Math.min(maxNodes, tail.length, head.length); m >= 1; m--) {
      const tailText = tail.slice(-m).map((n) => normalizeText(n.textContent));
      const headText = head.slice(0, m).map((n) => normalizeText(n.textContent));
      if (tailText.every((t, i) => t === headText[i]) && tailText.join('').length >= minChars) {
        head.slice(0, m).forEach((n) => n.remove());
        return m;
      }
    }
    return 0;
  }

  /**
   * Builds the combined story element: one container like the original text
   * wrapper (same tag and classes, so the site's styling applies) holding every
   * page's content back to back, in order. Each page is cloned into the live
   * document, so the cached fragments stay untouched.
   *
   * @param {Document} doc       live document
   * @param {object}   analysis  analyzeStoryDocument() result for the live page
   * @param {Array}    pages     [{ page, fragment }] sorted by page number
   */
  function buildCombined(doc, analysis, pages) {
    const template = analysis.mode === 'wrapper' ? analysis.container : null;
    const combined = doc.createElement(template ? template.localName : 'div');
    if (template && template.getAttribute('class')) combined.setAttribute('class', template.getAttribute('class'));
    combined.setAttribute(ATTR.combined, '');

    const usedIds = new Set([...doc.querySelectorAll('[id]')].map((el) => el.id));
    let previousTail = null;
    for (const { page, fragment } of pages) {
      const copy = doc.importNode(fragment, true);
      if (previousTail) trimBoundaryOverlap(previousTail, copy);
      for (const el of copy.querySelectorAll('[id]')) {
        if (usedIds.has(el.id)) el.removeAttribute('id');
        else usedIds.add(el.id);
      }
      for (const node of copy.childNodes) {
        if (node.nodeType === 1) node.setAttribute(ATTR.page, String(page));
      }
      previousTail = significantNodes(copy).slice(-3);
      combined.appendChild(copy);
    }
    return combined;
  }

  return {
    ATTR,
    MAX_PAGES,
    isLiteroticaHost,
    parseStoryUrl,
    sameWork,
    buildPageUrl,
    pageLinkTarget,
    readCanonical,
    readPageCounter,
    collectPagination,
    findTextContainer,
    analyzeStoryDocument,
    extractContent,
    sanitizeNode,
    safeUrl,
    safeStyle,
    normalizeText,
    hasContent,
    fingerprint,
    findDuplicatePages,
    trimBoundaryOverlap,
    buildCombined,
  };
});
