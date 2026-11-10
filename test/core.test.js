'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const core = require('../src/core.js');
const fx = require('./fixtures/literotica.js');

const parse = (html) => new JSDOM(html).window.document;
const story = (url) => core.parseStoryUrl(url);
const inert = () => new JSDOM('').window.document.implementation.createHTMLDocument('');

function analyze(opts, url) {
  const page = opts.page || 1;
  const host = opts.host || 'www.literotica.com';
  const kind = opts.kind || 's';
  const slug = opts.slug || 'test-story';
  const pageUrl = url || `https://${host}/${kind}/${slug}${page > 1 ? `?page=${page}` : ''}`;
  return core.analyzeStoryDocument(parse(fx.storyPage(opts)), story(pageUrl), pageUrl);
}

test.describe('parseStoryUrl', () => {
  test('parses story and poem URLs with and without a page number', () => {
    assert.deepEqual(
      story('https://www.literotica.com/s/parallel-tracks'),
      { origin: 'https://www.literotica.com', kind: 's', slug: 'parallel-tracks', page: 1, id: 'https://www.literotica.com/s/parallel-tracks', otherParams: [] },
    );
    assert.equal(story('https://www.literotica.com/s/parallel-tracks?page=3').page, 3);
    assert.equal(story('https://www.literotica.com/p/a-poem?page=2').kind, 'p');
    assert.equal(story('https://german.literotica.com/s/das-urteil-1?page=2').origin, 'https://german.literotica.com');
    assert.equal(story('https://www.literotica.com/s/slug/').slug, 'slug');
    assert.deepEqual(story('https://www.literotica.com/s/slug?page=2&dialog=log-in#x').otherParams, ['dialog']);
  });

  test('story identity ignores page, query and slug case', () => {
    assert.equal(story('https://www.literotica.com/s/Slug?page=2').id, story('https://www.literotica.com/s/slug').id);
    assert.notEqual(story('https://www.literotica.com/s/slug').id, story('https://www.literotica.com/p/slug').id);
    assert.notEqual(story('https://www.literotica.com/s/slug').id, story('https://german.literotica.com/s/slug').id);
  });

  test('rejects non-story pages, other hosts and malformed page numbers', () => {
    for (const url of [
      'https://www.literotica.com/',
      'https://www.literotica.com/c/mature-sex',
      'https://www.literotica.com/authors/someone/works/stories',
      'https://www.literotica.com/s/',
      'https://www.literotica.com/s/a/b',
      'http://www.literotica.com/s/slug',
      'https://www.literotica.com:8443/s/slug',
      'https://user:pw@www.literotica.com/s/slug',
      'https://literotica.com.evil.example/s/slug',
      'https://evil-literotica.com/s/slug',
      'https://forum.literotica.com/s/slug',
      'https://www.literotica.com/s/slug?page=0',
      'https://www.literotica.com/s/slug?page=-1',
      'https://www.literotica.com/s/slug?page=2.5',
      'https://www.literotica.com/s/slug?page=abc',
      'https://www.literotica.com/s/slug?page=2&page=3',
      'javascript:alert(1)',
      'not a url',
    ]) {
      assert.equal(story(url), null, url);
    }
  });

  test('buildPageUrl uses the bare URL for page 1 and ?page=N otherwise', () => {
    const s = story('https://www.literotica.com/s/slug?page=4&dialog=x');
    assert.equal(core.buildPageUrl(s, 1), 'https://www.literotica.com/s/slug');
    assert.equal(core.buildPageUrl(s, 2), 'https://www.literotica.com/s/slug?page=2');
    assert.throws(() => core.buildPageUrl(s, 0));
    assert.throws(() => core.buildPageUrl(s, 1.5));
  });

  test('pageLinkTarget only accepts plain links to the same story on the same origin', () => {
    const s = story('https://www.literotica.com/s/slug');
    const base = 'https://www.literotica.com/s/slug';
    assert.equal(core.pageLinkTarget(s, '/s/slug?page=3', base), 3);
    assert.equal(core.pageLinkTarget(s, '/s/slug', base), 1);
    assert.equal(core.pageLinkTarget(s, 'https://www.literotica.com/s/slug?page=2', base), 2);
    assert.equal(core.pageLinkTarget(s, '/s/slug?dialog=report-work', base), null);
    assert.equal(core.pageLinkTarget(s, '/s/other?page=2', base), null);
    assert.equal(core.pageLinkTarget(s, 'https://german.literotica.com/s/slug?page=2', base), null);
  });
});

test.describe('analyzeStoryDocument', () => {
  test('a single-page story has one page', () => {
    const a = analyze({ total: 1 });
    assert.equal(a.ok, true);
    assert.equal(a.total, 1);
    assert.equal(a.mode, 'wrapper');
    assert.deepEqual(a.paginationContainers, []);
  });

  test('finds the page count, text wrapper and both pagination navs', () => {
    const a = analyze({ total: 5, page: 2 });
    assert.equal(a.ok, true);
    assert.equal(a.total, 5);
    assert.match(a.container.className, /_introduction-wrap_/);
    assert.equal(a.paginationContainers.length, 2);
    assert.ok(a.paginationContainers.every((el) => el.localName === 'nav'));
    assert.match(a.counterElement.textContent, /Page 2 of 5/);
  });

  test('the truncated visible nav still yields the full count (25 pages)', () => {
    assert.deepEqual(fx.visiblePageNumbers(1, 25), [1, 2, 3, 4, 5, 6, 25]);
    for (const opts of [{}, { counter: false }, { counter: false, printNav: false }]) {
      const a = analyze(Object.assign({ total: 25, page: 1 }, opts));
      assert.equal(a.total, 25, JSON.stringify(opts));
    }
    const last = analyze({ total: 25, page: 25, counter: false, printNav: false });
    assert.equal(last.total, 25);
  });

  test('works with localised labels (German subdomain)', () => {
    const a = analyze({ host: 'german.literotica.com', lang: 'de', total: 3, page: 1 });
    assert.equal(a.ok, true);
    assert.equal(a.total, 3);
    assert.equal(a.paginationContainers.length, 2);
  });

  test('ignores links to other stories, including their ?page links', () => {
    const a = analyze({ total: 2, page: 1, counter: false });
    assert.equal(a.total, 2);
  });

  test('breadcrumb and linked title are not treated as pagination', () => {
    const a = analyze({ total: 3, page: 2 });
    for (const el of a.paginationContainers) {
      assert.notEqual(el.getAttribute('aria-label'), 'Breadcrumb');
      assert.equal(el.querySelector('h1'), null);
    }
  });

  test('ignores the audio player and report link when locating the text', () => {
    const a = analyze({ total: 2, audio: true });
    assert.match(a.container.className, /_introduction-wrap_/);
  });

  test('handles story text placed directly in articleBody', () => {
    const a = analyze({ total: 2, layout: 'inline' });
    assert.equal(a.ok, true);
    assert.equal(a.mode, 'inline');
    assert.ok(a.originals.every((el) => el.localName === 'p'));
  });

  test('pages that are not stories are rejected', () => {
    const url = 'https://www.literotica.com/s/test-story';
    for (const html of [fx.categoryPage(), fx.authorPage(), fx.notFoundPage(), fx.storyPage({ layout: 'none', total: 3 })]) {
      assert.equal(core.analyzeStoryDocument(parse(html), story(url), url).reason, 'not-story');
    }
  });

  test('detects a page showing a different page or story than expected', () => {
    const url = 'https://www.literotica.com/s/test-story?page=2';
    const page3 = parse(fx.storyPage({ total: 5, page: 3 }));
    assert.equal(core.analyzeStoryDocument(page3, story(url), url).reason, 'mismatch');
    const other = parse(fx.storyPage({ slug: 'other', total: 5, page: 2 }));
    assert.equal(core.analyzeStoryDocument(other, story(url), url).reason, 'mismatch');
  });

  test('contradictory page counts fail instead of guessing', () => {
    const a = analyze({ total: 6, counterTotal: 4 });
    assert.equal(a.ok, false);
    assert.equal(a.reason, 'inconsistent-pagination');
  });

  test('unexpected structures fail cleanly', () => {
    assert.equal(analyze({ total: 2, twoBodies: true }).reason, 'unexpected-structure');
    const empty = analyze({ total: 2, paragraphs: [] });
    assert.equal(empty.reason, 'unexpected-structure');
    assert.equal(empty.total, 2);
  });
});

test.describe('extractContent / sanitising', () => {
  const nasty = [
    '<p>Hello <em>italic</em>, <strong>bold</strong>, <b>b</b>, <i>i</i>, <u>u</u> <a href="/s/other">a link</a>.</p>',
    '<h2>Chapter Two</h2>',
    '<p onclick="steal()" style="text-align: center; position: fixed; background-image: url(https://evil.example/x)">centered</p>',
    '<script>window.__pwned = 1</script>',
    '<p><img src="/images/pic.jpg" onerror="steal()" width="810" height="532" alt="pic"></p>',
    '<p><a href="javascript:steal()">js link</a> <a href="data:text/html,x">data link</a> <a href="mailto:a@b.c">mail</a> <a href="#note">note</a></p>',
    '<iframe src="https://ads.example/"></iframe>',
    '<svg><script>steal()</script><circle r="5"/></svg>',
    '<ins class="adsbygoogle" data-ad-slot="1"></ins>',
    '<p><custom-tag>unknown tag text</custom-tag></p>',
    '<form action="/x"><input name="a"><button>Go</button></form>',
    '<hr>',
    '<blockquote><p>quoted</p></blockquote>',
    '<p><a href="https://example.com/" target="_blank">ext</a> <a href="/x" target="_top">top</a></p>',
    '<!-- a comment -->',
    '<p data-hk="123" id="para">with attributes</p>',
  ];

  function extract(paragraphs) {
    const url = 'https://www.literotica.com/s/test-story?page=2';
    const doc = parse(fx.storyPage({ total: 3, page: 2, paragraphs }));
    const a = core.analyzeStoryDocument(doc, story(url), url);
    assert.equal(a.ok, true);
    const target = inert();
    const fragment = core.extractContent(a, url, target);
    const box = target.createElement('div');
    box.appendChild(fragment);
    return box;
  }

  test('keeps meaningful formatting, links and media', () => {
    const box = extract(nasty);
    assert.ok(box.querySelector('em') && box.querySelector('strong') && box.querySelector('b'));
    assert.equal(box.querySelector('h2').textContent, 'Chapter Two');
    assert.equal(box.querySelector('a').getAttribute('href'), 'https://www.literotica.com/s/other');
    const img = box.querySelector('img');
    assert.equal(img.getAttribute('src'), 'https://www.literotica.com/images/pic.jpg');
    assert.equal(img.getAttribute('width'), '810');
    assert.equal(img.getAttribute('loading'), 'lazy');
    assert.ok(box.querySelector('hr'));
    assert.ok(box.querySelector('blockquote > p'));
    assert.match(box.textContent, /unknown tag text/);
    assert.equal(box.querySelector('a[href="#note"]').textContent, 'note');
    assert.equal(box.querySelector('a[href^="mailto:"]').textContent, 'mail');
    assert.equal(box.querySelector('#para').textContent, 'with attributes');
  });

  test('strips scripts, handlers, frames, forms, ads, SVG and unsafe URLs', () => {
    const box = extract(nasty);
    const html = box.innerHTML;
    assert.equal(box.querySelector('script, iframe, svg, form, input, button, ins, custom-tag'), null);
    assert.doesNotMatch(html, /onclick|onerror|steal|javascript:|data:text|data-hk|<!--/);
    const centered = [...box.querySelectorAll('p')].find((p) => p.textContent === 'centered');
    assert.equal(centered.getAttribute('style'), 'text-align: center');
    const jsLink = [...box.querySelectorAll('a')].find((a) => a.textContent === 'js link');
    assert.equal(jsLink.hasAttribute('href'), false);
    const ext = [...box.querySelectorAll('a')].find((a) => a.textContent === 'ext');
    assert.equal(ext.getAttribute('rel'), 'noopener');
    const top = [...box.querySelectorAll('a')].find((a) => a.textContent === 'top');
    assert.equal(top.hasAttribute('target'), false);
  });

  test('records where each top-level element came from', () => {
    const box = extract(['<p>a</p>', '<script>x</script>', '<p>b</p>']);
    assert.deepEqual([...box.children].map((el) => el.getAttribute('data-lsp-src')), ['0', '2']);
  });

  test('excludes the report link and audio player that sit next to the text', () => {
    const url = 'https://www.literotica.com/s/test-story';
    const doc = parse(fx.storyPage({ total: 2, audio: true }));
    const a = core.analyzeStoryDocument(doc, story(url), url);
    const fragment = core.extractContent(a, url, inert());
    assert.doesNotMatch(fragment.textContent, /Report/);
    assert.equal(fragment.querySelector('audio'), null);
  });

  test('safeUrl allows only http(s), mailto (links) and inline images', () => {
    const base = 'https://www.literotica.com/s/x';
    assert.equal(core.safeUrl('/a', base, 'href', 'a'), 'https://www.literotica.com/a');
    assert.equal(core.safeUrl(' JaVaScRiPt:alert(1)', base, 'href', 'a'), null);
    assert.equal(core.safeUrl('java\nscript:alert(1)', base, 'href', 'a'), null);
    assert.equal(core.safeUrl('vbscript:x', base, 'href', 'a'), null);
    assert.equal(core.safeUrl('mailto:x@y.z', base, 'src', 'img'), null);
    assert.equal(core.safeUrl('data:image/png;base64,AAAA', base, 'src', 'img'), 'data:image/png;base64,AAAA');
    assert.equal(core.safeUrl('data:image/svg+xml;base64,AAAA', base, 'src', 'img'), null);
  });
});

test.describe('combination helpers', () => {
  function fragmentOf(doc, html) {
    const t = doc.createElement('template');
    t.innerHTML = html;
    return t.content;
  }

  test('trimBoundaryOverlap removes a long paragraph repeated across a page boundary', () => {
    const doc = inert();
    const long = 'This paragraph is repeated at the end of one page and again at the start of the next page, word for word.';
    assert.ok(long.length >= 100);
    const prev = fragmentOf(doc, `<p>one</p><p>${long}</p>`);
    const next = fragmentOf(doc, `<p>${long}</p><p>two</p>`);
    assert.equal(core.trimBoundaryOverlap(prev, next), 1);
    assert.deepEqual([...next.children].map((p) => p.textContent), ['two']);
  });

  test('trimBoundaryOverlap leaves short repeated lines such as scene breaks', () => {
    const doc = inert();
    const prev = fragmentOf(doc, '<p>one</p><p>* * *</p>');
    const next = fragmentOf(doc, '<p>* * *</p><p>two</p>');
    assert.equal(core.trimBoundaryOverlap(prev, next), 0);
    assert.equal(next.children.length, 2);
  });

  test('findDuplicatePages spots identical pages', () => {
    assert.deepEqual(core.findDuplicatePages([
      { page: 1, fingerprint: 'a' }, { page: 2, fingerprint: 'b' }, { page: 3, fingerprint: 'a' },
    ]), [1, 3]);
    assert.equal(core.findDuplicatePages([{ page: 1, fingerprint: 'a' }, { page: 2, fingerprint: 'b' }]), null);
  });

  test('buildCombined concatenates pages in order inside a copy of the wrapper', () => {
    const live = parse(fx.storyPage({ total: 3, page: 2 }));
    const url = 'https://www.literotica.com/s/test-story?page=2';
    const a = core.analyzeStoryDocument(live, story(url), url);
    const doc2 = inert();
    const pages = [1, 2, 3].map((n) => ({ page: n, fragment: fragmentOf(doc2, `<p id="dup">p${n}a</p><p>p${n}b</p>`) }));
    const combined = core.buildCombined(live, a, pages);
    assert.equal(combined.getAttribute('class'), a.container.getAttribute('class'));
    assert.equal(combined.hasAttribute('style'), false);
    assert.equal(combined.hasAttribute('data-hk'), false);
    assert.deepEqual([...combined.children].map((p) => p.textContent), ['p1a', 'p1b', 'p2a', 'p2b', 'p3a', 'p3b']);
    assert.deepEqual([...combined.children].map((p) => p.getAttribute('data-lsp-page')), ['1', '1', '2', '2', '3', '3']);
    assert.equal(combined.querySelectorAll('[id="dup"]').length, 1);
    // Cached fragments are not consumed.
    assert.equal(pages[0].fragment.children.length, 2);
  });
});
