'use strict';
/*
 * HTML fixtures modelled on Literotica's real markup (observed November 2026):
 * the hashed CSS-module class names, the [itemprop=articleBody] > wrapper div
 * structure, two pagination navs (a truncated visible one and a print-only
 * one listing every page), the print-only "Page X of Y" counter, the
 * canonical link, sidebar/related-story links to other works, and Solid
 * hydration attributes (data-hk). All story text is placeholder text.
 */

const LABELS = {
  en: { pagination: 'Pagination', page: 'Page', of: 'of', prev: 'Previous Page', next: 'Next Page', by: 'by' },
  de: { pagination: 'Seitennummerierung', page: 'Seite', of: 'von', prev: 'Vorherige Seite', next: 'Nächste Seite', by: 'von' },
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function defaultParagraphs(slug, page, count = 6) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const style = i === 2 ? ' <em>with emphasis</em>' : i === 3 ? ' <strong>and bold text</strong>' : '';
    out.push(`<p>Paragraph ${i} of page ${page} of ${esc(slug)}. Placeholder story text for testing,${style} long enough to read like prose.</p>`);
  }
  return out;
}

function visiblePageNumbers(page, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  let from;
  let to;
  if (page <= 4) [from, to] = [1, 6];
  else if (page >= total - 3) [from, to] = [total - 5, total];
  else [from, to] = [page - 2, page + 2];
  const set = new Set([1, total]);
  for (let n = from; n <= to; n++) set.add(n);
  return [...set].sort((a, b) => a - b);
}

/**
 * Builds one page of a story.
 * @param {object} o
 *   host, kind ('s' | 'p'), slug, page, total, title, author, lang ('en' | 'de'),
 *   paragraphs        string[] of HTML for the story text (default: placeholder)
 *   counter           include the "Page X of Y" counter (default true when total > 1)
 *   counterTotal      override the counter's Y
 *   canonical         include <link rel=canonical> (default true)
 *   canonicalPage     override the canonical page number
 *   visibleNav        include the visible (truncated) pagination nav (default true)
 *   printNav          include the print-only nav listing every page (default true)
 *   duplicateNav      include the visible nav twice (duplicate pagination links)
 *   audio             include an audio player block
 *   layout            'wrapper' (real) | 'inline' (text directly in articleBody) | 'none' (no articleBody)
 *   twoBodies         include a second [itemprop=articleBody]
 *   headExtra, wrapperExtra   extra HTML
 */
function storyPage(o) {
  const host = o.host || 'www.literotica.com';
  const kind = o.kind || 's';
  const slug = o.slug || 'test-story';
  const page = o.page || 1;
  const total = o.total || 1;
  const title = o.title || 'Test Story';
  const author = o.author || 'TestAuthor';
  const lang = o.lang || 'en';
  const L = LABELS[lang];
  const origin = `https://${host}`;
  const rel = (n) => `/${kind}/${slug}${n > 1 ? `?page=${n}` : ''}`;
  const abs = (n) => origin + rel(n);
  const paragraphs = o.paragraphs || defaultParagraphs(slug, page);
  const showCounter = o.counter !== undefined ? o.counter : total > 1;
  const counterTotal = o.counterTotal || total;
  const canonicalPage = o.canonicalPage || page;
  const layout = o.layout || 'wrapper';

  const counter = showCounter
    ? `<p class="_page_counter_hst25_25">${L.page} ${page} ${L.of} ${counterTotal}</p>` : '';

  const item = 'class="_pagination__item_tl9pc_16"';
  const prev = page > 1
    ? `<a href="${rel(page - 1)}" class="_pagination__item_tl9pc_16 _pagination__item--prev_tl9pc_49" aria-label="${L.prev}"><i class="icon-angle-left _pagination__icon_tl9pc_170"></i></a>`
    : `<span class="_pagination__item_tl9pc_16 _pagination__item--disabled_tl9pc_149 _pagination__item--prev_tl9pc_49" aria-label="${L.prev}"><i class="icon-angle-left _pagination__icon_tl9pc_170"></i></span>`;
  const next = page < total
    ? `<a href="${rel(page + 1)}" class="_pagination__item_tl9pc_16 _pagination__item--next_tl9pc_50" aria-label="${L.next}"><i class="icon-angle-right _pagination__icon_tl9pc_170"></i></a>`
    : `<span class="_pagination__item_tl9pc_16 _pagination__item--disabled_tl9pc_149 _pagination__item--next_tl9pc_50" aria-label="${L.next}"><i class="icon-angle-right _pagination__icon_tl9pc_170"></i></span>`;
  let numbered = '';
  let last = 0;
  for (const n of visiblePageNumbers(page, total)) {
    if (n > last + 1) numbered += `<span ${item}>…</span>`;
    numbered += n === page
      ? `<span class="_pagination__item_tl9pc_16 _active_tl9pc_121" aria-label="${L.page} ${n}" aria-current="page">${n}</span>`
      : `<a href="${rel(n)}" ${item} aria-label="${L.page} ${n}">${n}</a>`;
    last = n;
  }
  const visibleNavHtml = `<div class="print-hidden"><nav class="panel _pagination_tl9pc_1" aria-label="${L.pagination}">${prev}${next}${numbered}<form class="_pagination__form_tl9pc_174"><label class="visually-hidden" for="go">Go to page number</label><input id="go" name="page" class="_pagination__input_tl9pc_212"><button class="visually-hidden">Go to page</button></form></nav></div>`;
  let printLinks = '';
  for (let n = 1; n <= total; n++) {
    printLinks += `<a href="${abs(n)}" class="_pages__link_hst25_43 ${n === page ? '_pages__link--current_hst25_48' : ''}" ${n === page ? 'aria-current="page"' : ''}>${L.page} ${n}</a>`;
  }
  const printNavHtml = `<footer class="print-only _footer_hst25_31"><p class="_line_hst25_19">Created: 10/02/2026</p><nav class="_pages_hst25_37" aria-label="${L.pagination}">${printLinks}</nav></footer>`;
  const paginationHtml = total > 1
    ? (o.visibleNav === false ? '' : visibleNavHtml) + (o.duplicateNav ? visibleNavHtml : '') + (o.printNav === false ? '' : printNavHtml)
    : '';

  const audio = o.audio
    ? `<div><div class="_audioPlayer_1w4ae_1"><audio controls="" src="https://uploads.literotica.com/audio/test.m4a"></audio></div></div>` : '';
  const report = `<a href="/${kind}/${slug}?dialog=report-work" rel="nofollow" class="_report_block_1kwe5_404 print-hidden" title="Report Story"><i class="icon icon-exclamation-circle _report_block__icon_1kwe5_423" aria-hidden="true"></i><span class="_report_block__title_1kwe5_419">Report</span></a>`;
  const text = paragraphs.join('') + (o.wrapperExtra || '');
  let body = '';
  if (layout === 'wrapper') {
    body = `<div class="panel article _article_1kwe5_1 "><div class="_article__content_1kwe5_118" itemprop="articleBody"><div data-hk="0000000000100000000100002000000300010004600000076501010" class="_introduction-wrap_sgvzk_1 _author_page_sgvzk_92 _introduction__text_sgvzk_42 _open_sgvzk_33" style="max-height:987px">${text}</div>${audio}${report}</div></div>`;
  } else if (layout === 'inline') {
    body = `<div class="panel article _article_1kwe5_1 "><div class="_article__content_1kwe5_118" itemprop="articleBody">${text}${audio}${report}</div></div>`;
  } else {
    body = `<div class="panel article"><p>This content is temporarily unavailable.</p></div>`;
  }
  if (o.twoBodies) body += `<div itemprop="articleBody"><p>Second body</p></div>`;

  const authorBox = `<div class="panel _author_jwrer_1 article"><a href="https://${host}/authors/${author}/works/stories" class="_author__image-wrapper_jwrer_21 inactive"><img class="_userpic_wzqc2_1" src="https://uploads.literotica.com/avatar.jpg" alt=""></a><div class="_author__info-wrapper_jwrer_35"><a class="_author__title_jwrer_59" href="https://${host}/authors/${author}/works/stories">${author}</a><a href="/${kind}/${slug}?dialog=log-in" class="_author__follow_jwrer_114">Follow</a></div></div>`;

  return `<!DOCTYPE html><html lang="${lang}" class="page nojs fallback"><head><meta charset="utf-8">
<title>${page > 1 ? `${L.page} ${page} - ` : ''}${esc(title)} - Mature - Literotica.com</title>
${o.canonical === false ? '' : `<link rel="canonical" href="${abs(canonicalPage)}">`}
<meta property="og:type" content="article">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"${esc(title)}","author":{"@type":"Person","name":"${author}"}}</script>
<script>window.__fixtureScriptRan = true;</script>
${o.headExtra || ''}
</head><body>
<header class="_wrapper_header"><nav aria-label="Superheader"><a href="${origin}/">Literotica</a><a href="${origin}/stories">Stories</a></nav></header>
<main class="main">
<nav class="_breadcrumbs_1i0e6_1" aria-label="Breadcrumb"><ol><li class="_item_1i0e6_60" itemprop="itemListElement"><a class="_link_1i0e6_111" href="/c/mature-sex"><span itemprop="name">Mature</span></a></li><li class="_item_1i0e6_60" itemprop="itemListElement"><span itemprop="name">${esc(title)}</span><meta itemprop="item" content="${abs(1)}"></li></ol></nav>
<article class="content space_sm"><div class="core core_custom">
<div class="print-hidden"><div class="_headline_rc893_9"><h1 class="_title_rc893_34">${esc(title)}</h1><a href="/${kind}/${slug}?dialog=log-in&amp;returnTo=%2F${kind}%2F${slug}" class="_bookmark_rc893_145"><i class=" icon-bookmark-o"></i><span class="visually-hidden">Bookmark Story</span></a></div></div>
<header class="print-only _header_hst25_1"><a href="${origin}/"><img class="_logo_hst25_7" src="https://speedy.literotica.com/logo.svg" alt="Literotica"></a><h1 class="_title_hst25_13"><a href="${abs(1)}">${esc(title)}</a></h1><p class="_line_hst25_19">${L.by} <a href="${origin}/authors/${author}">${author}</a></p>${counter}</header>
<div class="sidebar sidebar_custom print-hidden"><div class="panel _widget_spvht_1"><div class="head _widget__heading_spvht_24">Story Info</div>
<ul class="_similar"><li><a class="_widget_link_1cfnq_62" href="${origin}/s/another-story">Another Story</a></li><li><a class="_widget_link_1cfnq_62" href="${origin}/s/another-story?page=2">Another Story, page 2</a></li><li><a href="${origin}/s/${slug}-part-2">Next part in series</a></li></ul></div></div>
${authorBox}
${body}
<div class="print-hidden">${authorBox}</div>
${paginationHtml}
</div></article>
<section class="container_2025"><div class="_card_1ohpv_124"><a class="_card_link_1ohpv_305" href="${origin}/s/related-story-1?page=4">Related story</a></div><div class="_card_1ohpv_124"><a class="_card_link_1ohpv_305" href="/s/related-story-2">Related story 2</a></div></section>
</main>
<footer class="_wrapper_uqfd5_1"><nav aria-label="Footer"><a href="${origin}/">Home</a><a href="${origin}/stories">Stories</a></nav></footer>
</body></html>`;
}

function categoryPage(host = 'www.literotica.com') {
  return `<!DOCTYPE html><html><head><title>Mature - Literotica.com</title><link rel="canonical" href="https://${host}/c/mature-sex"></head><body>
<main><h1>Mature</h1><ul>
<li><a href="/s/story-one">Story One</a></li><li><a href="/s/story-two?page=2">Story Two</a></li>
</ul><nav aria-label="Pagination"><a href="/c/mature-sex/2-page">2</a></nav></main></body></html>`;
}

function authorPage(host = 'www.literotica.com') {
  return `<!DOCTYPE html><html><head><title>TestAuthor - Literotica.com</title></head><body>
<main><h1>TestAuthor</h1><div class="profile"><p>About me.</p></div>
<ul><li><a href="https://${host}/s/test-story">Test Story</a></li></ul></main></body></html>`;
}

function notFoundPage() {
  return `<!DOCTYPE html><html><head><title>Page not found - Literotica.com</title></head><body>
<main><h1>Oops! This page doesn't exist.</h1><a href="/">Home</a></main></body></html>`;
}

module.exports = { storyPage, categoryPage, authorPage, notFoundPage, defaultParagraphs, visiblePageNumbers, LABELS };
