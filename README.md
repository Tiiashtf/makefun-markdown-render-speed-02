# markdown-render-speed-02 — fast marked-compatible parser

A dependency-free ES module (`parse.js`) whose `parse(markdown)` returns,
for every string, exactly the HTML that marked 18.1.3's
`marked.parse(markdown)` returns with marked's default options
(gfm true, breaks false, pedantic false, async false).

## Design

- **Line-based block parser.** The input is split into lines once; block
  constructs (code, fences, headings, hr, blockquote, list, HTML, link
  reference definitions, tables, setext headings, paragraphs) are
  recognised by scanning lines, which avoids re-scanning the whole
  document with large regular expressions.
- **Single-pass inline scanner.** Inline constructs (escapes, tags, links,
  emphasis, code spans, breaks, deletions, autolinks, URLs, text) are
  handled by one left-to-right scan. Emphasis/delimiter matching is a
  greedy matcher that reproduces marked's `emStrong`/`del` algorithm
  (opener flanking check, closer search, the rule of three), not a
  delimiter stack — marked's nesting behaviour (delimiters inside an
  emphasis span are sealed) requires the greedy form.
- **Precomputed tables.** ASCII character classes live in `Uint8Array`
  tables; non-ASCII input falls back to a small Unicode regular
  expression. Output is built with array push + join.
- **No dependencies, no network.** Node 22, standard library only.

## Where marked departs from the spec

Where marked 18.1.3 departs from CommonMark/GFM, marked's HTML is
reproduced (it is the expected output), including:

- Named entities are *not* decoded (`&copy;` stays); numeric character
  references *are* decoded (`&#169;` → ©, `&#0;` → U+FFFD).
- No URL sanitisation: `javascript:`, `vbscript:` and similar pass
  through; `cleanUrl` is `encodeURI(href)` with `%25` un-escaped.
- Disallowed raw HTML (`<script>`, `<style>`, `<title>`, `<textarea>`,
  `<iframe>`) passes through raw.
- A blank line splits a blockquote (`> foo\n\n> bar` is two quotes);
  `> foo\n>\n> bar` is one quote with two paragraphs.
- Link reference definitions are collected document-globally before
  rendering, so forward references resolve; the first definition wins.
- An indented-code line or a link definition immediately after a
  paragraph is merged into that paragraph's text (and the definition is
  not registered); a blank line between them makes them separate blocks.

## Files

- `parse.js` — the parser (export `parse`).
- `main.ts` — harness driver: reads `/input/cases.json`, writes
  `/output/html.json`.
- `work/` (development only, removed before submission) — differential
  test and benchmark scripts.

## Known limitations

- The blockquote chunk loop does not implement marked's nested
  blockquote/list re-parse: when a chunk's last block is a nested
  blockquote or list and further quote lines follow, the re-parse that
  marked performs is skipped. Simple nested quotes and lists are handled;
  the re-parse only matters for lazy continuations after a nested
  quote/list.
- The setext check inside list-item continuation lines uses a simplified
  form of marked's `lheading` pattern.
