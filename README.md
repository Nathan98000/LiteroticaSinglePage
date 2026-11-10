# Literotica Single-Page Reader

A Chrome extension (Manifest V3) that automatically turns a multi-page Literotica story into one continuous page. You don't need to click anything: open any page of a story and the rest of the pages are fetched and joined into one seamless text, in reading order.

- Works whether you open page 1 or jump straight to a later page. Open page 3 of 5 and pages 1, 2, 4 and 5 are fetched and placed around it.
- Single-page stories are left exactly as they are.
- Keeps Literotica's layout, styling, title, author box, sidebar and everything else. Only the story text and its page controls change.
- A small pill in the bottom-right corner shows progress while pages load. Afterwards it offers **Paged view** to switch back to the site's original pages, and **Single page** to switch again. Both switches are instant and nothing is re-downloaded.
- If any page can't be loaded, the original page and its pagination stay untouched. The pill says which page failed and offers **Retry**. You never get a partly combined story.
- Works for stories (`/s/…`), poems (`/p/…`), illustrated and audio works, and on the language subdomains (`german.literotica.com`, `french.literotica.com`, …).
- No permissions, background worker, storage, analytics or third-party requests. The only network traffic is requests for the other pages of the story you're reading, on the same Literotica host, using your existing session.

## Installing (Load unpacked)

1. Download or clone this folder.
2. Open `chrome://extensions` in Chrome (or Edge, Brave or another Chromium browser).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
5. Open any multi-page story on literotica.com.

Chrome will say the extension can "read and change your data on literotica.com sites". That's the content script that rewrites story pages. It's the extension's only capability.

## How it works

### What the site looks like (investigated November 2026)

Before writing any code I inspected live story pages: multi-page stories (2, 3, 5, 8, 10, 17 and 25 pages), single-page stories, poems, illustrated and audio works, and a German-language story.

| What | Where it lives |
| --- | --- |
| Story URLs | `https://www.literotica.com/s/<slug>` for stories, `/p/<slug>` for poems. Language sites use the same paths on `<language>.literotica.com`. `literotica.com` and `m.literotica.com` redirect to `www`. |
| Pages | Page *N* > 1 is `?page=N`; page 1 is the bare URL. `?page=1`, `?page=0` and `?page=abc` redirect to the bare URL; out-of-range pages return 404. |
| Story text | `[itemprop="articleBody"]` contains one wrapper `<div>` holding the page's paragraphs, author notes included. Next to it sit an audio player (audio works only) and a "Report" link. |
| Page count | Two `<nav>`s link to the pages. The visible one is truncated for long stories (`1 2 3 4 5 6 … 25`) but always links the last page. A print-only one lists every page. There's also a print-only "Page X of Y" counter, and `<link rel="canonical">` gives the slug and page number. |
| Everything else | Title, author box, tags, related stories, comments link and ads are all outside `articleBody`. |
| Class names | CSS-module hashes (`_article__content_1kwe5_118`) that change between site builds, so the extension doesn't depend on them. |
| Localisation | UI text is translated (`Seite 1 von 3`, `aria-label="Seitennummerierung"`), so the extension doesn't match any UI text. |
| App behaviour | SolidStart: server-rendered HTML, then client-side routing. Moving between pages or stories changes the URL without a reload and reuses the same DOM nodes. |

### What the extension does

1. **Detect.** It parses the URL (`/s/<slug>` or `/p/<slug>`, optional `?page=N`) and checks that the DOM shows that same story and page, using the canonical link and the counter. After client-side navigation it waits until the DOM has caught up with the URL.
2. **Find all pages.** Page links are found by their `href`, not their text: same origin, same slug, only a `page` parameter. Links to other stories, series parts or related stories never match. The total is the counter's *Y* when present, otherwise the highest linked page. If the signals contradict each other, it stops and leaves the page alone. Duplicate links collapse into one.
3. **Fetch.** It uses `fetch()` with `credentials: 'same-origin'`, at most 3 requests at a time, a 20 s timeout per request, and 2 retries with back-off for network errors, timeouts, 429s and 5xx. Every fetched page is validated: its final URL after redirects, canonical link and counter must name the expected story, page and total, or the whole load fails. The first permanent failure (404, 403, an unexpected page) cancels the remaining requests.
4. **Extract and sanitise.** Each page is parsed with `DOMParser`, an inert document where nothing runs or loads. The story text is then rebuilt node by node through an allowlist, which keeps paragraphs, headings, emphasis, links, lists, tables, images and audio/video. Removed: `<script>`, `<style>`, `<iframe>`, forms, SVG, `on*` attributes, `javascript:` and `data:` URLs (except inline images), hydration attributes, and known ad containers. Relative URLs become absolute, and imported images load lazily.
5. **Combine.** Once every page has arrived, and the page itself has finished loading so the site's scripts have hydrated, it builds one container with the same tag and classes as the site's own text wrapper. That container holds all pages' paragraphs back to back. The site's CSS styles it exactly like the original, with no separators between pages. Identical pages are refused, and a paragraph repeated across a page boundary (100+ characters) is kept once.
6. **Swap.** The combined text is inserted where the original was. The original text, both pagination navs and the counter are **hidden, not removed** (`data-lsp-hidden`). The paragraph you were reading stays exactly where it was on screen, so opening page 3 keeps page 3 in front of you with pages 1–2 above it.
7. **Stay in sync.** It watches for URL changes (Navigation API plus a polling fallback). Moving to another story cancels in-flight requests, restores the original DOM, then starts over. Moving between pages of the same story keeps the combined view. URL changes that only open a dialog (`?dialog=…`) are ignored. If the site re-renders the story area, the combined view is re-applied. The last few stories are cached in memory, so Back/Forward doesn't refetch. A guard prevents running twice on one page.

### Files

```
manifest.json        MV3 manifest: a content script on *.literotica.com, no permissions
src/core.js          URL parsing, page analysis, sanitising, combining (pure DOM, unit tested)
src/loader.js        fetching: concurrency, timeouts, retries, fail-fast
src/content.js       controller: lifecycle, client-side navigation, DOM swap, status UI
src/content.css      hiding rule and status pill styles
icons/               toolbar icons (generated by scripts/make-icons.py)
guide/               the plain-language install guide page (template)
scripts/             icon generator and the guide's build script
test/                unit and integration tests, fixtures, live end-to-end check
```

There's no service worker because nothing needs one. Same-origin requests from a content script already carry your cookies.

## Testing

```bash
npm install
```

```bash
npm test
```

`npm test` runs 68 unit and integration tests with Node's built-in runner and jsdom. The fixtures in `test/fixtures/literotica.js` reproduce Literotica's real markup with placeholder text, and a mock server simulates responses, delays and failures. Covered:

- single, 2-page, 5-page and 25-page stories (truncated pagination), page order with out-of-order responses, and the concurrency limit
- opening on a later page, and keeping the scroll position
- duplicate pagination links, a server that ignores `?page`, and overlap at page boundaries
- missing pages, 403s, network errors, timeouts, transient 503s and redirects to other pages, plus Retry and Dismiss
- non-story pages, contradictory page counts, missing story text, and text placed directly in `articleBody`
- client-side navigation mid-load and after combining, same-story URL changes, and re-rendered pagination
- the restore toggle, very long pages, images, script/handler injection, poems, the German subdomain, and the double-run guard

```bash
HEADED=1 npm run test:live
```

`npm run test:live` loads the real unpacked extension into Chrome for Testing and checks it against the live site. It compares the combined text with each original page fetched separately, paragraph by paragraph, and covers:

- the restore toggle
- opening page 3 directly, checking the reading position doesn't move
- a 25-page story and a single-page story
- the German subdomain
- a page forced to fail, then Retry
- client-side navigation to another story, and Back

It needs Chromium or Chrome for Testing, because branded Chrome ignores `--load-extension`. It finds a Playwright-cached browser automatically, or you can set `CHROME_PATH`. Run it headed: the site refuses connections from headless Chrome.

## Install guide for non-technical users

`guide/guide.template.html` is a standalone page for people who have never installed an extension. It explains how to install and use the extension, and it has a **Download the extension** button with the extension embedded, so there's no separate file to host. It's published as a private claude.ai page: [Single-Page Reader Guide](https://claude.ai/artifact/FHGFaasxh13Bp3V9iUUfr5). Other people can open it only after it's shared from the page's Share menu.

```bash
npm run build:guide
```

That writes two files to `dist/` (git-ignored):

- `literotica-single-page-reader.zip`: the extension's files only (`manifest.json`, `src/`, `icons/`), at the top level of the ZIP so unzipping gives one folder with `manifest.json` directly inside. The ZIP is reproducible: the same source gives the same bytes.
- `single-page-reader-guide.html`: the template with that ZIP, the icon, and the name, version and description from `manifest.json` filled in.

The page's download is a snapshot of the extension at build time. After changing the extension, bump `version` in `manifest.json`, run the build, and republish `dist/single-page-reader-guide.html` to the same page URL (for example, by asking Claude to publish it to that artifact link). The download button uses claude.ai's download capability, so it works only when the page is viewed on claude.ai; elsewhere it tells the reader to ask for the ZIP instead.

## Known limitations

- **Tied to today's markup.** Detection relies on `[itemprop="articleBody"]`, the canonical link and the pagination hrefs. If Literotica changes these, the extension fails safe: it leaves the page untouched or shows an error, and never shows a guessed story.
- **All or nothing.** The combined view appears only once every page has loaded (in about 1.5–2 s for 25 pages in testing). A page that keeps failing means you get the original paginated story plus a Retry button.
- **Deep links stay at your page.** If you open `?page=3`, the URL keeps saying page 3 and pages 1–2 sit above where you're reading. Scroll up to read them.
- **Paged view lasts for the current view only.** Reloading or opening another story combines automatically again.
- **No access-control bypass.** If Literotica serves a login, age-verification or error page instead of a story page, the extension reports an error and keeps the original.
- **Series aren't merged.** Separate chapters or parts of a series are separate works, and only the pages of the story you're reading are combined.
- **Ad filtering is a heuristic.** The current page's text is taken from the live page, and a small selector list drops any ads injected into it. An ad in an unusual container could slip through.
- **Fixed-position pill.** It sits in the bottom-right corner and can overlap the sidebar while you scroll. It's semi-transparent until hovered.
- **Chromium only.** It's built and tested for Chrome. Other Chromium browsers should work; Firefox is untested.
