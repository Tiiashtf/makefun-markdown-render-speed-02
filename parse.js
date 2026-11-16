// parse.js — a fast Markdown parser whose output is byte-identical to
// marked 18.1.3's marked.parse() with the default options
// (gfm: true, breaks: false, pedantic: false, async: false).
//
// Original implementation, written from the CommonMark 0.31.2 + GFM 0.29
// specifications and calibrated against marked 18.1.3's behaviour (where
// marked departs from the spec, marked's output is what this parser
// reproduces). No dependencies, no regular expressions in the hot paths.
//
// Export: parse(markdown) -> string of HTML.

'use strict';

// ---------------------------------------------------------------------------
// Character classification (ASCII fast tables, Unicode fallback)
// ---------------------------------------------------------------------------

// ASCII punctuation, per Unicode general categories P and S.
const PUNCT = new Uint8Array(128);
for (let i = 0; i < 128; i++) {
  const c = String.fromCharCode(i);
  if (/[!-\/:-@\[-`{-~]/.test(c)) PUNCT[i] = 1;
}
// ASCII whitespace.
const SPACE = new Uint8Array(128);
SPACE[9] = 1; SPACE[10] = 1; SPACE[11] = 1; SPACE[12] = 1; SPACE[13] = 1; SPACE[32] = 1;

const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_RE = /\s/;
const ALNUM_RE = /[\p{L}\p{N}]/u;

function cpAt(s, i) {
  const c = s.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
    const d = s.charCodeAt(i + 1);
    if (d >= 0xDC00 && d <= 0xDFFF) return (c - 0xD800) * 0x400 + (d - 0xDC00) + 0x10000;
  }
  return c;
}
function isPunctCp(cp) {
  if (cp < 128) return PUNCT[cp] === 1;
  return PUNCT_RE.test(String.fromCodePoint(cp));
}
function isSpaceCp(cp) {
  if (cp < 128) return SPACE[cp] === 1;
  return SPACE_RE.test(String.fromCodePoint(cp));
}
function isAlnumCp(cp) {
  if (cp < 128) return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122);
  return ALNUM_RE.test(String.fromCodePoint(cp));
}
// Class of the character ending at index i (i is exclusive): -1 none,
// 0 other, 1 punctuation, 2 whitespace.
function classBefore(s, i) {
  if (i <= 0) return -1;
  let j = i - 1;
  let cp = s.charCodeAt(j);
  if (cp >= 0xDC00 && cp <= 0xDFFF && j > 0) {
    const hi = s.charCodeAt(j - 1);
    if (hi >= 0xD800 && hi <= 0xDBFF) cp = (hi - 0xD800) * 0x400 + (cp - 0xDC00) + 0x10000;
  }
  if (isSpaceCp(cp)) return 2;
  if (isPunctCp(cp)) return 1;
  return 0;
}
// Class of the character starting at index i.
function classAt(s, i) {
  if (i >= s.length) return -1;
  const cp = cpAt(s, i);
  if (isSpaceCp(cp)) return 2;
  if (isPunctCp(cp)) return 1;
  return 0;
}
function alnumAt(s, i) {
  if (i >= s.length) return false;
  return isAlnumCp(cpAt(s, i));
}
function alnumBefore(s, i) {
  if (i <= 0) return false;
  let j = i - 1;
  let cp = s.charCodeAt(j);
  if (cp >= 0xDC00 && cp <= 0xDFFF && j > 0) {
    const hi = s.charCodeAt(j - 1);
    if (hi >= 0xD800 && hi <= 0xDBFF) cp = (hi - 0xD800) * 0x400 + (cp - 0xDC00) + 0x10000;
  }
  return isAlnumCp(cp);
}

// ---------------------------------------------------------------------------
// Small string helpers (marked's P, Ie, he, F, ke, de, L, ge, J)
// ---------------------------------------------------------------------------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
// Escape every & < > " '  (marked's escape with encode=true).
function escapeAll(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_REPLACE, (c) => ESC_MAP[c]);
}
// Escape < > " ' and & only when it does not start a valid entity or
// numeric character reference (marked's escape with encode=false).
const NOENC_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NOENC_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
function escapeNoEnc(s) {
  if (!NOENC_TEST.test(s)) return s;
  return s.replace(NOENC_RE, (c) => (c === '&' ? '&amp;' : ESC_MAP[c]));
}

// Decode numeric character references; leave named entities alone and turn
// a bare & (not starting a valid reference) into &amp;  (marked's unescape).
const NUMREF_TEST = /&#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6});/;
const NUMREF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function unescape(s) {
  if (!NUMREF_TEST.test(s)) return s;
  return s.replace(NUMREF_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// encodeURI, with %25 turned back into %; null when encodeURI throws.
const PCT25 = /%25/g;
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(PCT25, '%');
  } catch {
    return null;
  }
}

// Normalise a link label: trim, collapse whitespace, Unicode case fold.
const MULTI_SPACE = /\s+/g;
function normalizeLabel(s) {
  return s.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing bracket matching the opener at the start of
// the scan, counting nesting; backslash-escapes are skipped.
// Returns the index, -1 when there is no closer, -2 when left unclosed.
function findClosingBracket(s, open, close) {
  if (s.indexOf(open) === -1 && s.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row on unescaped pipes, trim cells, pad/truncate to count.
function splitCells(row, count) {
  let t = '';
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '|') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && row[j] === '\\'; j--) backslashes++;
      t += (backslashes % 2 === 1) ? '|' : ' |';
    } else t += c;
  }
  const cells = t.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  }
  return cells;
}

// Remove trailing occurrences of ch from s (marked's rtrim).
function rtrim(s, ch) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === ch.charCodeAt(0)) n--;
  return s.slice(0, n);
}

// Trim trailing blank lines, keeping at most the last two lines' worth
// (marked's trimBlankLines).
const BLANK_LINE = /^[ \t]*$/;
function trimBlankLines(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces, tracking the column (marked's expandTabs).
function expandTabs(s, col) {
  let out = '';
  let c = col;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const n = 4 - (c % 4);
      out += '    '.slice(0, n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
//
// Node shapes (doubly linked via .next / .prev; the head is a sentinel):
//   {t:'x', s, raw}        plain text (s = raw source text; raw = inRawBlock)
//   {t:'c', s}             code span (s = processed code text)
//   {t:'h', s}             raw HTML tag (s = the tag verbatim)
//   {t:'b'}                hard break
//   {t:'a', href, title, auto, ch}   link (ch = child node list, linked)
//   {t:'i', href, title, ch}         image (ch = alt-text node list)
//   {t:'w', w, ch}         em / strong / del wrapper (ch = child node list)
//
// Rendering: renderList(head, textOnly) walks the list; renderText on a
// child list extracts plain text (used for image alt text).

function renderList(head, textOnly) {
  let out = '';
  for (let nd = head.next; nd; nd = nd.next) out += renderNode(nd, textOnly);
  return out;
}

function renderNode(nd, textOnly) {
  switch (nd.t) {
    case 'x':
      if (textOnly) return nd.raw ? nd.s : unescape(nd.s);
      return nd.raw ? nd.s : textHtml(nd.s);
    case 'c':
      return textOnly ? nd.s : '<code>' + escapeAll(nd.s) + '</code>';
    case 'h':
      return nd.s;
    case 'b':
      return textOnly ? '' : '<br>';
    case 'a': {
      if (textOnly) return renderList(nd.ch, true);
      if (nd.href === null) return renderList(nd.ch, false);
      const inner = nd.auto
        ? escapeAll(renderList(nd.ch, true))
        : renderList(nd.ch, false);
      let s = '<a href="' + (nd.auto ? escapeAll(nd.href) : escapeNoEnc(nd.href)) + '"';
      if (nd.title) s += ' title="' + escapeNoEnc(nd.title) + '"';
      return s + '>' + inner + '</a>';
    }
    case 'i': {
      if (textOnly) return renderList(nd.ch, true);
      if (nd.href === null) return escapeNoEnc(renderList(nd.ch, true));
      let s = '<img src="' + escapeNoEnc(nd.href) + '" alt="' + escapeNoEnc(renderList(nd.ch, true)) + '"';
      if (nd.title) s += ' title="' + escapeNoEnc(nd.title) + '"';
      return s + '>';
    }
    case 'w': {
      const inner = renderList(nd.ch, textOnly);
      if (textOnly) return inner;
      return nd.w === 'em' ? '<em>' + inner + '</em>'
        : nd.w === 'strong' ? '<strong>' + inner + '</strong>'
        : '<del>' + inner + '</del>';
    }
    default:
      return '';
  }
}

// HTML for a plain-text run (unescaped entities, noEncode escaping).
function textHtml(raw) {
  if (raw.indexOf('&') === -1) {
    if (!/[<>"']/.test(raw)) return raw;
    return raw.replace(/[<>"']/g, (c) => ESC_MAP[c]);
  }
  return escapeNoEnc(unescape(raw));
}

// --- link text scanning ----------------------------------------------------

// Find the ']' that closes a '[' at `start`, by bracket depth only
// (no code-span awareness). Used to locate a failed link's label when
// scanLinkText rejects it for an invalid backtick. Returns -1 if none.
function findBracketClose(src, start) {
  let depth = 1;
  let i = start;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Find the index just past the ')' matching a '(' at `start` (paren
// depth, backslash-aware). Returns -1 when there is no matching ')'.
function findParenClose(src, start) {
  let depth = 1;
  let i = start + 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

// The ']' closing a failed link attempt: a '[' at `p` whose brackets are
// followed by a complete parenthesised group (a link attempt whose label
// or destination is invalid). Returns the ']' index, or -1 when the
// brackets are bare (no complete parens follow) or unclosed.
function failedLinkClose(src, p) {
  const close = findBracketClose(src, p + 1);
  if (close === -1) return -1;
  if (src[close + 1] !== '(') return -1;
  if (findParenClose(src, close + 1) === -1) return -1;
  return close;
}

// Scan a link's bracketed text starting just after '[' at `start`.
// Returns the index of the matching ']' (depth returns to 0), or -1.
function scanLinkText(src, start) {
  let depth = 1;
  let i = start;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      // Skip a code span. Marked's label rule: a backtick run is either a
      // code span (opening run + non-backtick content + closing run, the
      // two runs may have different lengths) or a run of 2+ backticks
      // immediately before the closing ']' (doc-09/28/35 vs doc-18/20/23/30:
      // a lone backtick that is neither makes the whole thing NOT a link).
      // Inside a nested bracket a backtick is just a literal character.
      if (depth > 1) { i++; continue; }
      let j = i;
      while (j < n && src[j] === '`') j++;
      const k = j - i;
      // A run immediately before ']' cannot open a code span (there is
      // no room for content + a closing run): it is the `` ``+(?=\]) ``
      // case. Check this FIRST, before searching for a closing run —
      // otherwise the search runs past the ']' into a later line's
      // backtick and the label is wrongly rejected (doc-33: the `` `` ``
      // before ']' paired with a `a_b` backtick on the next line).
      if (k >= 2 && j < n && src[j] === ']') { i = j; continue; }
      let m = j;
      while (m < n && src[m] !== '`') m++;
      if (m === n) return -1;
      let e = m;
      while (e < n && src[e] === '`') e++;
      i = e;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// marked's "link in text" guard: the link text contains a '<' that starts
// an HTML tag or autolink which runs past the end of the text.
function linkTextHasEscapingTag(src, text, textStart) {
  if (!text.includes('<')) return false;
  for (let s = 0; s < text.length; s++) {
    if (text[s] === '\\') { s++; continue; }
    if (text[s] === '`') {
      const m = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(text.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (text[s] !== '<') continue;
    const rest = src.slice(textStart + s);
    const tagLen = scanInlineTag(rest);
    const auto = tagLen > 0 ? null : scanAutolink(rest);
    const oLen = tagLen > 0 ? tagLen : (auto ? auto.length : 0);
    if (oLen > 0) {
      if (oLen > text.length - s) return true;
      s += oLen - 1;
    }
  }
  return false;
}

// Scan an inline HTML tag at the start of s. Returns its length or 0.
function scanInlineTag(s) {
  if (s[0] !== '<') return 0;
  // Comment.
  if (s.startsWith('<!--')) {
    // Abrupt closing <!--> and <!---> are complete comments by themselves.
    if (s.length >= 5 && s[4] === '>') return 5;
    if (s.startsWith('<!--->')) return 6;
    const end = s.indexOf('-->', 4);
    if (end !== -1) return end + 3;
    return s.length;
  }
  // Processing instruction.
  if (s.startsWith('<?')) {
    const end = s.indexOf('?>', 2);
    return end !== -1 ? end + 2 : s.length;
  }
  // CDATA.
  if (s.startsWith('<![CDATA[')) {
    const end = s.indexOf(']]>', 9);
    return end !== -1 ? end + 3 : s.length;
  }
  // Declaration.
  if (s.startsWith('<!') && s.length > 2 && /[A-Za-z]/.test(s[2])) {
    const end = s.indexOf('>', 2);
    return end !== -1 ? end + 1 : s.length;
  }
  // Closing tag.
  let m = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/.exec(s);
  if (m) return m[0].length;
  // Opening tag.
  m = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/.exec(s);
  if (m) return m[0].length;
  return 0;
}

// Scan an autolink <scheme:...> or <email> at the start of s.
// Returns {length, text, href} or null.
const AUTOLINK_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/;
function scanAutolink(s) {
  if (s[0] !== '<') return null;
  const m = /^<([^>\s\x00-\x1f]*)>/.exec(s);
  if (!m) return null;
  const inner = m[1];
  if (AUTOLINK_SCHEME.test(inner)) return { length: m[0].length, text: inner, href: inner };
  const em = /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)$/.exec(inner);
  if (em) return { length: m[0].length, text: inner, href: 'mailto:' + inner };
  return null;
}

// Unescape backslash-escapes of punctuation in a link href/title.
const BACKSLASH_PUNCT = /\\([\p{P}\p{S}])/gu;
function unescapeBackslash(s) {
  return s.replace(BACKSLASH_PUNCT, '$1');
}

// Parse the "(dest title)" part of an inline link, starting at src[i] === '('.
// Returns {end, href, title} (end = index just past ')') or null.
function parseLinkParens(src, i) {
  const n = src.length;
  let j = i + 1;
  // Skip spaces/tabs/newlines.
  while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
  let href = '';
  if (j < n && src[j] === ')') {
    // Empty destination.
    href = '';
  } else if (j < n && src[j] === '<') {
    // Angle-bracket destination.
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = src[k];
      if (c === '\\') { k += 2; continue; }
      if (c === '\n' || c === '<' || c === '>') { if (c === '>') ok = true; break; }
      k++;
    }
    if (!ok) return null;
    // The closing > must not be escaped (odd backslash count -> fail).
    let bs = 0;
    for (let p = k - 1; p >= j + 1 && src[p] === '\\'; p--) bs++;
    if (bs % 2 === 1) return null;
    href = src.slice(j + 1, k);
    j = k + 1;
  } else {
    // Bare destination: run of non-whitespace, non-control chars
    // (marked's [^ \t\n\x00-\x1f]+). Stops at the first space/tab/
    // newline, so a following (title) is parsed as a title.
    let k = j;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c < 32) break;
      k++;
    }
    let dest = src.slice(j, k);
    const close = findClosingBracket(dest, '(', ')');
    if (close === -2) return null;
    if (close > -1) {
      dest = dest.slice(0, close);
      k = j + close;
    }
    href = dest;
    j = k;
  }
  // Optional title (requires a whitespace separator before it).
  let title = '';
  const save = j;
  let p = j;
  if (p < n && (src[p] === ' ' || src[p] === '\t')) {
    while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
    if (p < n && src[p] === '\n') {
      p++;
      while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
    }
  } else if (p < n && src[p] === '\n') {
    p++;
    while (p < n && (src[p] === ' ' || src[p] === '\t')) p++;
  }
  if (p > j && p < n && (src[p] === '"' || src[p] === "'" || src[p] === '(')) {
    const q = src[p];
    const closer = q === '(' ? ')' : q;
    let m = p + 1;
    let ok = false;
    while (m < n) {
      const c = src[m];
      if (c === '\\') { m += 2; continue; }
      if (c === closer) { ok = true; break; }
      if (q === "'" && c === '\n') {
        // Single-quoted titles may span one newline, not a blank line.
        if (src[m + 1] === '\n') break;
      }
      m++;
    }
    if (ok) {
      title = src.slice(p + 1, m);
      j = m + 1;
    } else {
      j = save;
    }
  } else {
    j = save;
  }
  // Skip trailing spaces/tabs/newlines, expect ')'.
  while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
  if (j >= n || src[j] !== ')') return null;
  // The closing paren must not be escaped (odd backslash count -> fail).
  let bs = 0;
  for (let q = j - 1; q >= i && src[q] === '\\'; q--) bs++;
  if (bs % 2 === 1) return null;
  return { end: j + 1, href: href.trim(), title };
}

// --- emphasis / strikethrough (marked's greedy left-to-right matcher) -----
//
// When a delimiter run that can open is found, the text ahead is scanned
// for a matching closer (skipping code spans, links and HTML tags, exactly
// as marked's masked-string search does). If one is found, the inner text is
// parsed recursively; otherwise the run is literal text. This seals the
// delimiters inside an emphasis span, matching marked.

function flanking(src, start, end) {
  // start/end delimit the run. Returns flanking flags.
  const prevC = classBefore(src, start);
  const nextC = classAt(src, end);
  const prevSpace = prevC === 2 || prevC === -1;
  const prevPunct = prevC === 1;
  const nextSpace = nextC === 2 || nextC === -1;
  const nextPunct = nextC === 1;
  const left = !nextSpace && (!nextPunct || prevSpace || prevPunct);
  const right = !prevSpace && (!prevPunct || nextSpace || nextPunct);
  return { left, right, prevPunct, nextPunct };
}

// Count the delimiter chars immediately before position i in src.
function countPrecedingDelim(src, i, ch) {
  let n = 0;
  for (let j = i - 1; j >= 0 && src[j] === ch; j--) n++;
  return n;
}

// Find a closer for a delimiter run starting at src[openStart] with length
// openLen (char ch). `openerCanClose` says whether the opener can also
// close (for the rule of three); `prevIsDelim` says whether the character
// before the opener (last text char) is the same delimiter.
// Returns {end, use} where `end` is the index just past the closer run's
// used delimiters, and `use` is how many delimiters the closer contributes.
// Returns null when there is no closer.
function findCloser(src, openStart, openLen, ch, openerCanClose, prevIsDelim, refs) {
  const n = src.length;
  let m = openLen; // opener delimiters still needing a closer
  let f = 0; // rule-of-three blocked closer length
  const y = openLen + countPrecedingDelim(src, openStart, ch);
  const R = openerCanClose;
  let i = openStart + openLen;
  // Marked's closer-search regex first skips a span of the form
  // `__ ... * ... __` (for a `*` opener) or `** ... _ ... **` (for a `_`
  // opener) that appears before any other delimiter in the search text:
  // the `*`/`_` inside such a span is not an opener (cm-470: the `*` in
  // `__bar *baz bim__` must not count). The regex's `^` anchors this skip
  // to the start of the search text, so it fires at most once, right here.
  // (The `~` closer regex has no such skip.)
  if (ch === '*' || ch === '_') {
    const pair = ch === '*' ? '__' : '**';
    const inner = ch;
    const s0 = openStart + openLen;
    let a = -1;
    for (let p = s0; p + 1 < n; p++) {
      if (src[p] === pair[0] && src[p + 1] === pair[1]) { a = p; break; }
      if (src[p] === '*' || src[p] === '_') break;
    }
    if (a !== -1) {
      let b = -1;
      for (let p = a + 2; p < n; p++) {
        if (src[p] === inner) { b = p; break; }
        if (src[p] === '*' || src[p] === '_') break;
      }
      if (b !== -1) {
        let d = -1;
        for (let p = b + 1; p + 1 < n; p++) {
          if (src[p] === pair[0] && src[p + 1] === pair[1]) { d = p; break; }
          if (src[p] === '*' || src[p] === '_') break;
        }
        if (d !== -1) i = d; // skip to just before the closing pair
      }
    }
  }
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx !== undefined && nx.charCodeAt(0) < 128 && PUNCT[nx.charCodeAt(0)] === 1) { i += 2; continue; }
      i++;
      continue;
    }
    if (c === '`') {
      // Skip a code span.
      let j = i;
      while (j < n && src[j] === '`') j++;
      const k = j - i;
      let p = j, found = -1;
      while (p < n) {
        if (src[p] === '`') {
          let e = p;
          while (e < n && src[e] === '`') e++;
          if (e - p === k && src[e] !== '`') { found = p; break; }
          p = e;
        } else p++;
      }
      i = found === -1 ? j : found + k;
      continue;
    }
    if (c === '[') {
      // Skip a link/image construct (its text is hidden from this
      // search) — but only when a valid link follows (cm-523: a bare
      // "[bar* baz]" is literal text, so a * inside it can close).
      const close = scanLinkText(src, i + 1);
      if (close === -1) { i++; continue; }
      let j = close + 1;
      let isLink = false;
      if (src[j] === '(') {
        const par = parseLinkParens(src, j);
        if (par) { j = par.end; isLink = true; }
      } else if (src[j] === '[') {
        const e2 = src.indexOf(']', j + 1);
        if (e2 !== -1) { j = e2 + 1; isLink = true; }
      } else {
        // Shortcut reference: only a link if the label is defined.
        const key = normalizeLabel(src.slice(i + 1, close));
        if (refs && refs[key]) isLink = true;
      }
      if (!isLink) { i++; continue; }
      i = j;
      continue;
    }
    if (c === '!') {
      if (src[i + 1] === '[') {
        const close = scanLinkText(src, i + 2);
        if (close !== -1) { i = close + 1; continue; }
      }
      i++;
      continue;
    }
    if (c === '<') {
      const tl = scanInlineTag(src.slice(i)) || (scanAutolink(src.slice(i)) || {}).length || 0;
      if (tl > 0) { i += tl; continue; }
      i++;
      continue;
    }
    if (c === ch) {
      // A delimiter run.
      let j = i;
      while (j < n && src[j] === ch) j++;
      const b = j - i;
      const fl = flanking(src, i, j);
      let canOpen, canClose;
      if (ch === '~') {
        canOpen = (classBefore(src, i) === -1 || classBefore(src, i) === 2 || classBefore(src, i) === 1)
          && classAt(src, j) !== -1 && classAt(src, j) !== 2;
        canClose = classBefore(src, i) !== -1 && classBefore(src, i) !== 2;
        if (b !== openLen) { i = j; continue; }
        if (canOpen && !canClose) { m += b; i = j; continue; }
        if (!canClose) { i = j; continue; }
        m -= b;
        if (m > 0) { i = j; continue; }
        return { end: i + b, use: b };
      }
      if (ch === '_') {
        canOpen = fl.left && (!fl.right || fl.prevPunct);
        canClose = fl.right && (!fl.left || fl.nextPunct);
      } else {
        canOpen = fl.left;
        canClose = fl.right;
      }
      if (canOpen && !canClose) { m += b; i = j; continue; }
      if (!canClose) { i = j; continue; }
      if (canOpen && canClose || R) {
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; i = j; continue; }
      }
      m -= b;
      if (m > 0) { i = j; continue; }
      const use = Math.min(b, b + m + f);
      return { end: i + use, use };
    }
    i++;
  }
  return null;
}

// Try to build an em/strong/del node for the delimiter run at src[p].
// Returns {end, node} or null. `st` is the shared inline state;
// `lastTextChar` is the last char of the previous text token in this parse.
function tryEmphasis(src, p, ch, refs, st, lastTextChar) {
  const n = src.length;
  let j = p;
  while (j < n && src[j] === ch) j++;
  const len = j - p;
  // Back up to the start of the delimiter run: the flanking is computed
  // from the character before the run, not before the retry position
  // (marked backs up the same way). The opener length, however, is the
  // run length from the retry position.
  let runStart = p;
  while (runStart > 0 && src[runStart - 1] === ch) runStart--;
  const fl = flanking(src, runStart, j);
  let canOpen, canClose;
  if (ch === '~') {
    canOpen = (classBefore(src, runStart) === -1 || classBefore(src, runStart) === 2 || classBefore(src, runStart) === 1)
      && classAt(src, j) !== -1 && classAt(src, j) !== 2;
    canClose = classBefore(src, runStart) !== -1 && classBefore(src, runStart) !== 2;
  } else if (ch === '_') {
    canOpen = fl.left && (!fl.right || fl.prevPunct);
    canClose = fl.right && (!fl.left || fl.nextPunct);
  } else {
    canOpen = fl.left;
    canClose = fl.right;
  }
  if (!canOpen) return null;
  // Strikethrough uses 1 or 2 tildes; a run of 3+ is not a del
  // opener (gfm-493: ~~~not~~~ stays literal; a single ~ is a del).
  if (ch === '~' && len > 2) return null;
  if (ch === '_' && alnumAt(src, j) && alnumBefore(src, runStart)) return null;
  const prevIsDelim = lastTextChar === ch;
  const found = findCloser(src, p, len, ch, canClose, prevIsDelim, refs);
  if (!found) return null;
  const use = found.use;
  // The span consumes 1 delimiter at each end for em, 2 for strong, and
  // `use` for del; any leftover run characters stay inside the inner text
  // (marked's M.slice(1,-1) / M.slice(2,-2)), where they are parsed
  // recursively.
  const minLen = Math.min(len, use);
  let w, consume;
  if (ch === '~') { w = 'del'; consume = use; }
  else if (minLen % 2 === 1) { w = 'em'; consume = 1; }
  else { w = 'strong'; consume = 2; }
  const inner = src.slice(p + consume, found.end - consume);
  const childHead = inlineNodes(inner, refs, st);
  const node = { t: 'w', w, ch: childHead };
  return { end: found.end, node };
}

// --- extended autolinks ----------------------------------------------------

const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function backpedal(s) {
  let cur = s, prev = '';
  while (cur !== prev) {
    prev = cur;
    const m = BACKPEDAL_RE.exec(cur);
    cur = m ? m[0] : '';
  }
  return cur;
}
const EMAIL_LOCAL = /[A-Za-z0-9._+-]/;
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;

// Try an extended autolink at src[p] (p = start of the candidate).
// Returns {end, text, href} or null.
function tryUrl(src, p) {
  const rest = src.slice(p);
  let m, text, href;
  if ((m = /^(?:mailto:([A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))|xmpp:([A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?))/.exec(rest))) {
    text = m[0]; href = m[0];
  } else if (/^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//.test(rest) || rest.startsWith('www.')) {
    m = /^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/.exec(rest);
    if (!m) return null;
    text = backpedal(m[0]);
    if (!text) return null;
    href = text.startsWith('www.') ? 'http://' + text : text;
  } else if ((m = EMAIL_RE.exec(rest))) {
    text = backpedal(m[0]);
    if (!text) return null;
    href = 'mailto:' + text;
  } else return null;
  return { end: p + text.length, text, href };
}

// --- link / image attempt --------------------------------------------------

// Try to parse a link (or image when isImage) whose '[' is at src[p].
// Returns {end, node} or null. Mutates st (inLink/linkEmitted/inRawBlock)
// the way marked's outputLink does.
function tryLink(src, p, isImage, refs, st, parenPossible) {
  const textStart = p + 1;
  const closeIdx = scanLinkText(src, textStart);
  if (closeIdx === -1) return null;
  const rawText = src.slice(textStart, closeIdx);
  if (linkTextHasEscapingTag(src, rawText, textStart)) return null;
  const text = rawText.replace(/\\([\[\]])/g, '$1');
  const after = closeIdx + 1;
  let href = null, title = null, end = -1;
  let inlineTried = false;
  if (after < src.length && src[after] === '(' && parenPossible) {
    const par = parseLinkParens(src, after);
    if (par !== null) {
      href = unescapeBackslash(par.href);
      title = par.title ? unescapeBackslash(par.title) : null;
      end = par.end;
    } else {
      // Inline destination invalid: fall back to a shortcut reference
      // link (cm-568: [foo](not a link) with [foo]: /url1).
      inlineTried = true;
    }
  }
  if (href === null && after < src.length && src[after] === '[' && !inlineTried) {
    // Full / collapsed reference link.
    let j = after + 1;
    let label = '';
    let ok = false;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { label += src.slice(j, j + 2); j += 2; continue; }
      if (c === '[' || c === '\n') break;
      if (c === ']') { ok = true; break; }
      label += c; j++;
    }
    if (!ok) return null;
    const key = label ? normalizeLabel(label) : normalizeLabel(rawText);
    const ref = refs[key];
    if (!ref) return null;
    href = ref.href; title = ref.title;
    end = j + 1;
  } else if (href === null) {
    // Shortcut reference link.
    const ref = refs[normalizeLabel(rawText)];
    if (!ref) return null;
    href = ref.href; title = ref.title;
    end = after;
  }
  // Parse the link text (recursively) and enforce the no-nested-link rule.
  const savedInLink = st.inLink, savedEmitted = st.linkEmitted, savedRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const childHead = inlineNodes(text, refs, st);
  const nested = st.linkEmitted;
  st.inLink = savedInLink;
  st.linkEmitted = savedEmitted;
  if (nested && !isImage) {
    st.inRawBlock = savedRaw;
    return null;
  }
  if (!isImage) st.linkEmitted = true;
  const clean = cleanUrl(href);
  const node = isImage
    ? { t: 'i', href: clean, title, ch: childHead }
    : { t: 'a', href: clean, title, auto: false, ch: childHead };
  return { end, node };
}

// --- the inline scanner ----------------------------------------------------

const SCAN_RE = /[\\`*_~\[!<\n]|www\.|:\/\/|mailto:|xmpp:|@/g;

// Parse inline markdown into a linked list of nodes. `st` is the shared
// lexer state ({inLink, linkEmitted, inRawBlock}). Returns the head sentinel.
function inlineNodes(src, refs, st) {
  const head = { t: 'h', next: null, prev: null };
  let tail = head;
  const n = src.length;
  const parenPossible = src.includes(')');
  let lastTextChar = '';
  // Ranges [start, end] (positions in this src) covering the label of a
  // failed link attempt "[...](...)": marked does not parse emphasis
  // inside such brackets, even though the link itself is invalid
  // (doc-16/20/23). Code spans inside still parse, so the range only
  // suppresses emphasis/del openers.
  const noEmph = [];
  const inNoEmph = (p) => {
    for (let q = 0; q < noEmph.length; q++) {
      if (p >= noEmph[q][0] && p <= noEmph[q][1]) return true;
    }
    return false;
  };
  const append = (nd) => { nd.prev = tail; nd.next = null; tail.next = nd; tail = nd; };
  let i = 0, textStart = 0;
  const flushText = (end) => {
    if (end > textStart) {
      const raw = src.slice(textStart, end);
      append({ t: 'x', s: raw, raw: st.inRawBlock });
      if (!raw.endsWith('_')) lastTextChar = raw[raw.length - 1];
    }
  };
  const restIsAllSpace = (from) => {
    for (let k = from; k < n; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 11 && c !== 12) return false;
    }
    return true;
  };
  SCAN_RE.lastIndex = 0;
  while (i < n) {
    SCAN_RE.lastIndex = i;
    const m = SCAN_RE.exec(src);
    if (!m) break;
    const p = m.index;
    const c = src[p];
    if (c === '\\') {
      const nx = src[p + 1];
      if (nx !== undefined && nx.charCodeAt(0) < 128 && PUNCT[nx.charCodeAt(0)] === 1) {
        // Backslash escape of an ASCII punctuation character.
        flushText(p);
        append({ t: 'x', s: nx, raw: false });
        lastTextChar = nx;
        i = textStart = p + 2;
        continue;
      }
      if (nx === '\n' && !restIsAllSpace(p + 2)) {
        // Hard break: backslash + newline (not at end of the source).
        flushText(p);
        append({ t: 'b' });
        let j = p + 2;
        while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
        i = textStart = j;
        continue;
      }
      i = p + 1;
      continue;
    }
    if (c === '`') {
      // Code span.
      let j = p;
      while (j < n && src[j] === '`') j++;
      const k = j - p;
      let q = j, found = -1;
      while (q < n) {
        if (src[q] === '`') {
          let e = q;
          while (e < n && src[e] === '`') e++;
          if (e - q === k && src[e] !== '`') { found = q; break; }
          q = e;
        } else q++;
      }
      // No matching closer: the whole backtick run is literal text.
      // Do not retry inside the run (marked's codespan regex fails
      // for the run as a whole, and the text tokenizer consumes it).
      if (found === -1) { i = j; continue; }
      let content = src.slice(j, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' '
        && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flushText(p);
      append({ t: 'c', s: content });
      i = textStart = found + k;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      if (inNoEmph(p)) { i = p + 1; continue; }
      const em = tryEmphasis(src, p, c, refs, st, lastTextChar);
      if (em) {
        flushText(p);
        append(em.node);
        i = textStart = em.end;
        continue;
      }
      // A failed opener leaves one delimiter as literal text and the
      // scanner retries at the next character (marked does the same:
      // the first `*` of `**foo*` becomes literal and the second `*`
      // opens the emphasis). tryEmphasis backs up to the run start
      // for the flanking check, so a mid-run retry sees the run's
      // true preceding character.
      i = p + 1;
      continue;
    }
    if (c === '[' || (c === '!' && src[p + 1] === '[')) {
      const isImage = c === '!';
      const bp = isImage ? p + 1 : p;
      const lk = tryLink(src, bp, isImage, refs, st, parenPossible);
      if (lk) {
        flushText(p);
        append(lk.node);
        i = textStart = lk.end;
        continue;
      }
      // Failed link attempt: suppress emphasis inside the label ONLY
      // when the failure is an invalid label or an invalid destination
      // (the cases where marked's link regex fails to match at all:
      // doc-16/20/23, "[foo _bar_ baz](not a link)"). When the label
      // and destination are valid but the link fails because the label
      // contains a nested link, emphasis inside still parses (cm-519,
      // doc-01/10/11/13/19/24/25), so do not suppress then.
      const closeIdx = scanLinkText(src, bp + 1);
      if (closeIdx === -1) {
        const fc = failedLinkClose(src, bp);
        if (fc !== -1) noEmph.push([bp + 1, fc]);
      } else if (src[closeIdx + 1] === '(' && parenPossible) {
        const par = parseLinkParens(src, closeIdx + 1);
        if (par === null && findParenClose(src, closeIdx + 1) !== -1) {
          noEmph.push([bp + 1, closeIdx]);
        }
      }
      i = p + 1;
      continue;
    }
    if (c === '<') {
      const rest = src.slice(p);
      const tl = scanInlineTag(rest);
      if (tl > 0) {
        const tag = rest.slice(0, tl);
        // Flush the preceding text BEFORE updating inRawBlock: text
        // before an opening <code> is normal text (unescaped), text
        // before a closing </code> is still inside the raw block.
        flushText(p);
        if (!st.inLink && /^<a /i.test(tag)) st.inLink = true;
        else if (st.inLink && /^<\/a>/i.test(tag)) st.inLink = false;
        if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = false;
        append({ t: 'h', s: tag });
        i = textStart = p + tl;
        continue;
      }
      const al = scanAutolink(rest);
      if (al) {
        flushText(p);
        const childHead = { t: 'h', next: null, prev: null };
        const tn = { t: 'x', s: al.text, raw: false, prev: childHead, next: null };
        childHead.next = tn;
        const clean = cleanUrl(al.href);
        append({ t: 'a', href: clean, title: null, auto: true, ch: childHead });
        i = textStart = p + al.length;
        continue;
      }
      i = p + 1;
      continue;
    }
    if (c === '\n') {
      // Hard break: two or more trailing spaces before the newline.
      let sp = 0;
      for (let q = p - 1; q >= textStart && src[q] === ' '; q--) sp++;
      if (sp >= 2 && !restIsAllSpace(p + 1)) {
        flushText(p - sp);
        append({ t: 'b' });
        let j = p + 1;
        while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
        i = textStart = j;
        continue;
      }
      i = p + 1;
      continue;
    }
    if (c === 'w' || c === ':' || c === 'm' || c === 'x' || c === '@') {
      // Possible extended autolink (www. / scheme:// / mailto: / email).
      if (!st.inLink) {
        let start = -1, url = null;
        if (c === 'w' && src.startsWith('www.', p)) {
          const before = p === 0 ? '' : src[p - 1];
          if (before === '' || before === ' ' || before === '\t' || before === '\n'
            || before === '*' || before === '_' || before === '~' || before === '(') {
            start = p; url = tryUrl(src, p);
          }
        } else if (c === ':') {
          // Scheme check is case-insensitive (marked's Re is
          // [hH][tT][tT][pP][sS]?|[fF][tT][pP]). Lengths: https 5,
          // http 4, ftp 3.
          let schemeStart = -1;
          if (p >= 5 && src.slice(p - 5, p).toLowerCase() === 'https') schemeStart = p - 5;
          else if (p >= 4 && src.slice(p - 4, p).toLowerCase() === 'http') schemeStart = p - 4;
          else if (p >= 3 && src.slice(p - 3, p).toLowerCase() === 'ftp') schemeStart = p - 3;
          if (schemeStart >= 0) {
            start = schemeStart; url = tryUrl(src, schemeStart);
          }
        } else if ((c === 'm' && src.startsWith('mailto:', p)) || (c === 'x' && src.startsWith('xmpp:', p))) {
          // mailto:/xmpp: is an autolink only at the start or after a
          // non-alphanumeric character.
          const before = p === 0 ? '' : src[p - 1];
          if (before === '' || !/[A-Za-z0-9]/.test(before)) {
            start = p; url = tryUrl(src, p);
          }
        } else if (c === '@') {
          // Back up over the local part, stopping before a
          // backslash-escaped character (cm-606: foo\+@bar.com is not
          // an autolink — the + is escaped, so no local part precedes @).
          let s = p - 1;
          while (s >= 0 && EMAIL_LOCAL.test(src[s])) {
            let b = s - 1, cnt = 0;
            while (b >= 0 && src[b] === '\\') { cnt++; b--; }
            if (cnt % 2 === 1) break;
            s--;
          }
          s++;
          if (s < p) {
            const u = tryUrl(src, s);
            if (u && u.end > p) { start = s; url = u; }
          }
        }
        if (url) {
          flushText(start);
          const childHead = { t: 'h', next: null, prev: null };
          const tn = { t: 'x', s: url.text, raw: false, prev: childHead, next: null };
          childHead.next = tn;
          const clean = cleanUrl(url.href);
          append({ t: 'a', href: clean, title: null, auto: true, ch: childHead });
          i = textStart = url.end;
          continue;
        }
      }
      i = p + 1;
      continue;
    }
    i = p + 1;
  }
  flushText(n);
  return head;
}

// Render an inline source to HTML (top-level entry; resets inRawBlock).
function inlineHtml(src, refs, st) {
  if (!src) return '';
  st.inRawBlock = false;
  return renderList(inlineNodes(src, refs, st), false);
}

// ---------------------------------------------------------------------------
// Block parsing (line based)
// ---------------------------------------------------------------------------

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const INLINE_TAGS = 'a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img';

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Number of leading spaces (tabs count as 0 here; handled separately).
function leadSpaces(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 32) n++;
  return n;
}
function isIndentedCodeLine(line) {
  // (?: {4}| {0,3}\t) followed by at least one character.
  if (line.startsWith('    ')) return line.length > 4;
  let sp = 0;
  while (sp < 3 && sp < line.length && line.charCodeAt(sp) === 32) sp++;
  return sp < line.length && line.charCodeAt(sp) === 9 && sp + 1 < line.length;
}
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const ATX_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)$/;
const HR_RE = /^ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/;
const BQ_START_RE = /^ {0,3}>/;
const LIST_START_RE = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM_RE = /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;

// Paragraph-interruption predicate for a continuation line (gfm paragraph
// lookahead: hr, heading, blockquote, fences, list (bullet or 1.), html,
// table). `nextLine` is used for the table check.
function paraInterrupts(line, nextLine) {
  if (isBlank(line)) return true;
  if (HR_RE.test(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (BQ_START_RE.test(line)) return true;
  if (/^ {0,3}(?:`{3,}(?=[^`\n]*$)|~~~)/.test(line)) return true;
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/.test(line)) return true;
  // HTML conditions 1-6 can interrupt a paragraph; condition 7 cannot.
  const hk = htmlBlockStart(line);
  if (hk !== 0 && hk !== 7) return true;
  if (nextLine !== undefined && isTableStart(line, nextLine)) return true;
  return false;
}
// Same, but a table start does not interrupt (used while collecting a
// setext heading: a `---` line after paragraph text is the underline,
// not a table delimiter — the table rule was already tried at the
// heading start and failed).
function paraInterruptsNoTable(line) {
  if (isBlank(line)) return true;
  if (HR_RE.test(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (BQ_START_RE.test(line)) return true;
  if (/^ {0,3}(?:`{3,}(?=[^`\n]*$)|~~~)/.test(line)) return true;
  if (/^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/.test(line)) return true;
  if (htmlBlockStart(line) > 0) return true;
  return false;
}
// Same, but with the general list pattern (used inside blockquotes).
function paraInterruptsKe(line, nextLine) {
  if (isBlank(line)) return true;
  if (HR_RE.test(line)) return true;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return true;
  if (BQ_START_RE.test(line)) return true;
  if (/^ {0,3}(?:`{3,}(?=[^`\n]*$)|~~~)/.test(line)) return true;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)) return true;
  // HTML conditions 1-6 can interrupt a paragraph; condition 7 cannot.
  const hk = htmlBlockStart(line);
  if (hk !== 0 && hk !== 7) return true;
  if (nextLine !== undefined && isTableStart(line, nextLine)) return true;
  return false;
}

// Does `line` start an HTML block? Returns the condition number (1-7) or 0.
function htmlBlockStart(line) {
  const m = /^ {0,3}</.exec(line);
  if (!m) return 0;
  const s = line.slice(m[0].length - 1);
  if (/^<(script|pre|style|textarea)(?:[\s>]|$)/i.test(s)) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(s)) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  const tagRe = new RegExp(`^</?(?:${BLOCK_TAGS})(?: +|\\n|/?>|$)`, 'i');
  if (tagRe.test(s)) return 6;
  // Condition 7: a complete open tag (any tag name other than pre,
  // script, style, textarea — those are condition 1) ending the line,
  // or a complete close tag ending the line. Inline tags count too
  // (CommonMark condition 7 does not exclude them).
  if (/^<[a-z][a-z0-9-]*/i.test(s)) {
    const name = /^<([a-z][a-z0-9-]*)/i.exec(s)[1].toLowerCase();
    if (!/^(script|pre|style|textarea)$/i.test(name)) {
      const tagEnd = scanInlineTag(s);
      if (tagEnd > 0 && /^[ \t]*$/.test(s.slice(tagEnd))) return 7;
    }
  }
  if (/^<\/[a-z][a-z0-9-]*\s*>[ \t]*$/i.test(s)) return 7;
  return 0;
}

function isTableStart(headerLine, delimLine) {
  if (!/^ *[^ ]/.test(headerLine)) return false;
  if (!TABLE_DELIM_RE.test(delimLine)) return false;
  return true;
}

// Link reference definition (marked's Fe). Returns null or
// {end, tag, href, title} where end is the line index after the definition.
const DEF_LABEL = /(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF_TITLE = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
const DEF_RE = new RegExp(
  '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)'
    .replace('label', DEF_LABEL.source).replace('title', DEF_TITLE.source)
);
function tryDef(lines, i, hi) {
  // A definition's title can span several lines; join enough lines.
  const text = lines.slice(i, Math.min(hi, i + 10)).join('\n');
  const m = DEF_RE.exec(text);
  if (!m) return null;
  // The destination must not have unbalanced parens (unless angle-bracketed).
  if (!m[2].startsWith('<') && findClosingBracket(m[2], '(', ')') !== -1) return null;
  const tag = normalizeLabel(m[1]);
  // An empty (whitespace-only) label is not a valid definition (cm-552).
  if (tag === '') return null;
  let href = m[2].replace(/^<(.*)>$/, '$1').replace(BACKSLASH_PUNCT, '$1');
  let title = m[3] ? m[3].substring(1, m[3].length - 1).replace(BACKSLASH_PUNCT, '$1') : null;
  // The match starts at the beginning of line i. After consuming `nl`
  // newlines we are at the start of line i+nl; if the match ends at the
  // end of the joined text (no trailing newline) the last line is also
  // consumed.
  const nl = (m[0].match(/\n/g) || []).length;
  const end = m[0].endsWith('\n') ? i + nl : Math.min(hi, i + nl + 1);
  // Raw with trailing newlines trimmed (used when a def is merged into a
  // preceding paragraph/text token instead of being registered).
  const raw = m[0].replace(/\n+$/, '');
  return { end, tag, href, title, raw };
}

// Indented code block starting at line i. Returns {end, text} or null.
function tryCodeBlock(lines, i, hi) {
  if (!isIndentedCodeLine(lines[i])) return null;
  const raw = [];
  let j = i;
  while (j < hi) {
    if (isIndentedCodeLine(lines[j])) { raw.push(lines[j]); j++; continue; }
    if (isBlank(lines[j])) {
      let k = j;
      while (k < hi && isBlank(lines[k])) k++;
      if (k < hi && isIndentedCodeLine(lines[k])) {
        while (j < k) { raw.push(lines[j]); j++; }
        continue;
      }
      while (j < k) { raw.push(lines[j]); j++; }
      break;
    }
    break;
  }
  const joined = raw.join('\n');
  const trimmed = trimBlankLines(joined);
  const text = trimmed.replace(/^(?: {0,3}\t| {1,4})/gm, '');
  return { end: j, text };
}

// Fenced code block starting at line i. Returns {end, text, lang} or null.
function tryFences(lines, i, hi) {
  const m = FENCE_RE.exec(lines[i]);
  if (!m) return null;
  const fence = m[1];
  const ch = fence[0];
  if (ch === '`' && m[2].includes('`')) return null;
  const indent = leadSpaces(lines[i]);
  const closeRe = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
  let j = i + 1;
  let closed = false;
  while (j < hi) {
    if (closeRe.test(lines[j])) { closed = true; break; }
    j++;
  }
  const contentLines = lines.slice(i + 1, closed ? j : hi);
  // Dedent by the opening fence's indent — but only for backtick fences.
  // Marked's indentCodeCompensation regex is /^(\s+)(?:```)/: it only
  // matches a backtick fence, so a tilde fence never dedents its content
  // (doc-22/29: a `~~~` fence at indent 3 keeps the content's 3 spaces).
  const text = ch === '`' ? contentLines.map((ln) => {
    const wm = /^[ \t]*/.exec(ln);
    if (!wm || wm[0].length === 0) return ln;
    return ln.slice(Math.min(wm[0].length, indent));
  }).join('\n') : contentLines.join('\n');
  const lang = m[2] ? m[2].trim().replace(BACKSLASH_PUNCT, '$1') : '';
  return { end: closed ? j + 1 : hi, text, lang };
}

// Table starting at line i. Returns the block or null.
function tryTable(lines, i, hi) {
  if (i + 1 >= hi) return null;
  if (!isTableStart(lines[i], lines[i + 1])) return null;
  const header = splitCells(lines[i]);
  const delimRaw = lines[i + 1].replace(/^\||\| *$/g, '');
  const delim = delimRaw.split('|');
  if (!/[:|]/.test(lines[i + 1])) return null;
  if (header.length !== delim.length) return null;
  const align = delim.map((cell) => {
    if (/^ *-+: *$/.test(cell)) return 'right';
    if (/^ *:-+: *$/.test(cell)) return 'center';
    if (/^ *:-+ *$/.test(cell)) return 'left';
    return null;
  });
  const rows = [];
  let j = i + 2;
  while (j < hi) {
    const ln = lines[j];
    // A table body ends at an empty or spaces-only line; a tab-only
    // line is a (empty) row, not a terminator (marked's body regex
    // rejects only ` *\n`, not tabs).
    if (/^ *$/.test(ln)) break;
    if (HR_RE.test(ln) || /^ {0,3}#{1,6}(?:\s|$)/.test(ln) || BQ_START_RE.test(ln)
      || isIndentedCodeLine(ln) || /^ {0,3}(?:`{3,}(?=[^`\n]*$)|~~~)/.test(ln)
      || LIST_START_RE.test(ln) || htmlBlockStart(ln) > 0) break;
    rows.push(splitCells(ln, header.length));
    j++;
  }
  return {
    end: j,
    block: {
      t: 'tab',
      head: header.map((c, k) => ({ s: c, align: align[k] })),
      rows: rows.map((r) => r.map((c, k) => ({ s: c, align: align[k] }))),
    },
  };
}

// ---------------------------------------------------------------------------
// Blockquote
// ---------------------------------------------------------------------------

function expandLeadingTabs(str, col) {
  let i = 0;
  let c = col;
  let out = '';
  while (i < str.length) {
    const ch = str.charCodeAt(i);
    if (ch === 32) { out += ' '; c++; i++; }
    else if (ch === 9) { const n = 4 - (c % 4); out += ' '.repeat(n); c += n; i++; }
    else break;
  }
  return out + str.slice(i);
}

function stripQuoteMarker(line) {
  const m = /^ {0,3}>[ \t]?/.exec(line);
  return m ? line.slice(m[0].length) : line;
}

// Is the stripped content of a `>` line paragraph text (so a following
// non-`>` line can be a lazy continuation)? Strip ALL nested `>`
// markers AND list item markers first: the innermost content decides
// (cm-250/251: a lazy line continues the innermost blockquote's
// paragraph; cm-292: a lazy line continues the paragraph inside a
// list item's nested blockquote).
function quoteLineParaOpen(content) {
  let s = content;
  while (true) {
    const m = /^ {0,3}>[ \t]?/.exec(s);
    if (m) { s = s.slice(m[0].length); continue; }
    const lm = /^ {0,3}(?:[*+-]|\d{1,9}[.)])/.exec(s);
    if (lm) {
      const b = lm[0].length;
      const g = expandLeadingTabs(s.slice(b), b);
      if (!g.trim()) return false;
      let R = g.search(/[^ ]/);
      if (R < 0) return false;
      if (R > 4) R = 1;
      s = g.slice(R);
      continue;
    }
    break;
  }
  if (isBlank(s)) return false;
  if (isIndentedCodeLine(s)) return false;
  // A fence line is not paragraph text — but a backtick fence whose info
  // string contains a backtick is NOT a valid fence (doc-05: the line
  // ```inner backticks``` is paragraph text, so a following lazy line
  // can continue the paragraph).
  const fm = FENCE_RE.exec(s);
  if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) return false;
  if (ATX_RE.test(s)) return false;
  if (HR_RE.test(s)) return false;
  if (BQ_START_RE.test(s)) return false;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(s)) return false;
  if (htmlBlockStart(s) > 0) return false;
  return true;
}

// Collect the lines of one blockquote (marked's blockquote regex, Xe).
// Tracks fenced code blocks inside the quote: a line inside a fence is
// not a paragraph opener, so it cannot lazily continue the quote.
function collectQuoteLines(lines, i, hi) {
  const qlines = [];
  let j = i;
  let paraOpen = false;
  let fenceCh = '';
  let fenceLen = 0;
  while (j < hi) {
    const line = lines[j];
    if (BQ_START_RE.test(line)) {
      qlines.push(line);
      const content = stripQuoteMarker(line);
      if (fenceCh) {
        // Inside a fenced code block: only a closing fence exits it.
        const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content);
        if (m && m[1][0] === fenceCh && m[1].length >= fenceLen) {
          fenceCh = '';
          fenceLen = 0;
        }
        paraOpen = false;
      } else {
        const fm = FENCE_RE.exec(content);
        if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
          fenceCh = fm[1][0];
          fenceLen = fm[1].length;
          paraOpen = false;
        } else {
          paraOpen = quoteLineParaOpen(content);
        }
      }
      j++;
    } else if (paraOpen && !isBlank(line) && !paraInterruptsKe(line, lines[j + 1])) {
      qlines.push(line);
      j++;
    } else break;
  }
  return { lines: qlines, end: j };
}

// Strip one chunk of a blockquote (marker whitespace expansion, setext
// indent, marker removal) and return the stripped lines.
function stripQuoteChunk(chunkLines) {
  let h = chunkLines.join('\n');
  h = h.replace(/^( {0,3}>)([ \t]+)/gm, (m, b, ws) => b + expandTabs(ws, b.length));
  h = h.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
  h = h.replace(/^ {0,3}>[ \t]?/gm, '');
  return h.split('\n');
}

function parseBlockquote(lines, i, hi, refs) {
  const { lines: qlines, end } = collectQuoteLines(lines, i, hi);
  let n = qlines;
  const children = [];
  while (n.length > 0) {
    let seen = false;
    const chunk = [];
    let p = 0;
    for (; p < n.length; p++) {
      // Every non-`>` line in qlines is a lazy continuation (collectQuoteLines
      // only adds such lines when paraOpen), so it belongs in the current
      // chunk with the `>` line it continues — not in a separate chunk
      // (cm-250/251: the lazy line must reach the nested blockquote).
      chunk.push(n[p]);
      if (BQ_START_RE.test(n[p])) seen = true;
    }
    n = n.slice(p);
    const stripped = stripQuoteChunk(chunk);
    // Lazy lines (no `>` marker) that are indented code lines have their
    // indent stripped when collected as paragraph continuations (cm-238).
    // The set is indexed by the stripped lines; it is only for this
    // chunk's parseBlocks call (nested quotes/lists compute their own).
    // The check uses the ORIGINAL chunk line: a lazy setext underline
    // (`===`) is indented by stripQuoteChunk and must keep its indent
    // (cm-093), while a lazy line that is already indented code is
    // stripped.
    const stripSet = new Set();
    for (let k = 0; k < chunk.length; k++) {
      if (!BQ_START_RE.test(chunk[k]) && isIndentedCodeLine(chunk[k])) stripSet.add(k);
    }
    const blocks = [];
    parseBlocks(stripped, 0, stripped.length, true, refs, blocks, stripSet);
    // Merge the chunk's first paragraph into the previous paragraph.
    if (blocks.length > 0 && blocks[0].t === 'p' && children.length > 0
      && children[children.length - 1].t === 'p') {
      children[children.length - 1].s += '\n' + blocks[0].s;
      blocks.shift();
    }
    for (const b of blocks) children.push(b);
    if (n.length === 0) break;
    const k = children[children.length - 1];
    if (!k) break;
    if (k.t === 'c' || k.t === 'h' || k.t === 'hr' || k.t === 'html' || k.t === 'tab') break;
    // Nested blockquote / list re-parse is not implemented (see README).
    // Continue with the next chunk.
  }
  return { end, block: { t: 'bq', ch: children } };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function parseList(lines, i, hi, refs) {
  const first = lines[i];
  const markerM = /^ {0,3}(?:[*+-]|\d{1,9}[.)])/.exec(first);
  const marker = markerM[0];
  const trimmed = marker.trim();
  const ordered = trimmed.length > 1;
  const start = ordered ? parseInt(trimmed.slice(0, -1), 10) : null;
  // A list continues only with the same marker kind: same bullet char
  // for unordered, same delimiter (. or )) for ordered (cm-301/302).
  const markerKind = ordered ? trimmed.slice(-1) : trimmed;
  const isSameKind = (line) => {
    const mm = /^ {0,3}(?:[*+-]|\d{1,9}[.)])/.exec(line);
    if (!mm) return false;
    const t = mm[0].trim();
    if (ordered) return t.length > 1 && t.slice(-1) === markerKind;
    return t === markerKind;
  };
  const b = marker.length;
  let g = first.slice(b);
  let m = expandLeadingTabs(g, b);
  let y = !m.trim();
  let R, d;
  if (y) { R = b + 1; d = ''; }
  else {
    R = m.search(/[^ ]/);
    if (R < 0) R = m.length;
    if (R > 4) R = 1;
    d = m.slice(R);
    R += b;
  }
  const items = [];
  let loose = false;
  let j = i;
  let cur = null;
  // Collect items. `j` is the index of the next line to examine.
  let itemText = d;
  let itemStart = i;
  let blankBetween = false;
  j = i + 1;
  let hasContent = d.trim() !== '';
  while (true) {
    // Regexes for block starts. Marked's D() helper clamps the indent
    // to min(3, R-1): a sibling block must start at an indent below
    // the item's content indent R; at indent R it is item content
    // (a nested block), not a break.
    const maxInd = Math.max(0, Math.min(3, R - 1));
    const fenceRe = new RegExp(`^ {0,${maxInd}}(?:\`\`\`|~~~)`);
    const headRe = new RegExp(`^ {0,${maxInd}}#{1,6}(?:\\s|$)`);
    const bqRe = new RegExp(`^ {0,${maxInd}}>`);
    const bullRe = new RegExp(`^ {0,${maxInd}}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|$)`);
    const hrRe = new RegExp(`^ {0,${maxInd}}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})[ \\t]*$`);
    // Collect continuation lines for the current item.
    let e = j;
    let itemEndsBlank = false;
    while (e < hi) {
      const f = lines[e];
      // An item with no content yet ends at a blank line (cm-280: an
      // empty item followed by a blank line is empty; the following
      // indented lines are not part of it).
      if (!f.trim() && !hasContent) break;
      const Z = expandLeadingTabs(f, 0);
      // htmlBlockStart already only matches at indent 0-3; the list
      // version is additionally clamped to maxInd (marked's D()).
      const htmlAt = leadSpaces(Z) <= maxInd && htmlBlockStart(Z) > 0;
      if (fenceRe.test(f) || headRe.test(f) || bqRe.test(f) || bullRe.test(f)
        || hrRe.test(f) || htmlAt) break;
      if (Z.search(/[^ ]/) >= R || !f.trim()) {
        // A blank line followed by a line that breaks the list is NOT
        // part of this item (marked's list raw excludes it; it becomes
        // a space token at the outer level). Leave it unconsumed.
        if (!f.trim()) {
          let k = e + 1;
          while (k < hi && !lines[k].trim()) k++;
          if (k >= hi) break;
          const fk = lines[k];
          const Zk = expandLeadingTabs(fk, 0);
          const htmlAtK = leadSpaces(Zk) <= maxInd && htmlBlockStart(Zk) > 0;
          if (fenceRe.test(fk) || headRe.test(fk) || bqRe.test(fk) || bullRe.test(fk)
            || hrRe.test(fk) || htmlAtK) break;
        }
        itemText += '\n' + Z.slice(R);
        itemEndsBlank = !f.trim();
        if (f.trim()) hasContent = true;
      } else {
        if (y || m.search(/[^ ]/) >= 4 || fenceRe.test(m) || headRe.test(m)
          || (htmlBlockStart(m) > 0) || hrRe.test(m)) break;
        // Setext underline of the marker line.
        const setextLine = /^ {0,3}(?:=+|-+) *$/.test(f)
          && /^([^\n]+)\n {0,3}(=+|-+)[ \t]*$/.test(m + '\n' + f);
        if (setextLine) itemText += '\n    ' + Z.replace(/^ {0,3}/, '');
        else itemText += '\n' + f;
        itemEndsBlank = false;
        if (f.trim()) hasContent = true;
      }
      y = !f.trim();
      m = Z.slice(R);
      e++;
    }
    j = e;
    // End of the current item. Check for a following item.
    let nextJ = j;
    let blanks = 0;
    while (nextJ < hi && isBlank(lines[nextJ])) { blanks++; nextJ++; }
    const hasNext = nextJ < hi && LIST_START_RE.test(lines[nextJ]) && isSameKind(lines[nextJ]) && !HR_RE.test(lines[nextJ]);
    // A blank line between items makes the list loose. The blank line
    // may already have been consumed into the item text (itemEndsBlank)
    // or may still follow (blanks).
    if (hasNext && (blanks > 0 || itemEndsBlank)) loose = true;
    // A blank line inside an item is judged from its parsed tokens
    // (marked's space/anyLine check), NOT from the raw text: blank
    // lines inside nested lists do not make this list loose.
    items.push({ text: itemText, blankBetween: blanks > 0 });
    if (!hasNext) break;
    // Start the next item.
    const nf = lines[nextJ];
    const nm = /^ {0,3}(?:[*+-]|\d{1,9}[.)])/.exec(nf);
    const nb = nm[0].length;
    let ng = nf.slice(nb);
    let nm2 = expandLeadingTabs(ng, nb);
    let ny = !nm2.trim();
    let nR, nd;
    if (ny) { nR = nb + 1; nd = ''; }
    else {
      nR = nm2.search(/[^ ]/);
      if (nR < 0) nR = nm2.length;
      if (nR > 4) nR = 1;
      nd = nm2.slice(nR);
      nR += nb;
    }
    itemText = nd;
    hasContent = nd.trim() !== '';
    R = nR;
    m = nm2;
    y = ny;
    j = nextJ + 1;
  }
  // Build the items: task checkbox, tokens.
  const outItems = items.map((it) => {
    let text = it.text;
    let checked = null;
    const tm = /^\[( |x|X)\][ \t]/.exec(text);
    if (tm) {
      checked = tm[1] !== ' ';
      text = text.slice(tm[0].length);
    }
    const lines2 = text.split('\n');
    const tokens = [];
    parseBlocks(lines2, 0, lines2.length, false, refs, tokens);
    return { checked, ch: tokens };
  });
  // Loose check from parsed tokens (marked): a space token between two
  // blocks in any item (raw matching /\n.*\n/) makes the list loose.
  if (!loose) {
    for (const it of outItems) {
      for (const tk of it.ch) {
        if (tk.t === 'space' && /\n.*\n/.test(tk.s)) { loose = true; break; }
      }
      if (loose) break;
    }
  }
  // A loose list renders each item's text blocks as paragraphs
  // (marked converts text tokens to paragraph tokens when loose).
  if (loose) {
    for (const it of outItems) for (const tk of it.ch) if (tk.t === 'x') tk.t = 'p';
  }
  // Marked trims a list's raw of trailing blank lines, so a blank line
  // consumed into the last item does not belong to the list: it becomes
  // a space token at the outer level (cm-325: a blank line between a
  // nested list and following text makes the OUTER list loose). Back the
  // end up over trailing blank lines; the item text keeps them (they are
  // harmless trailing blanks there).
  let end = j;
  while (end > i && isBlank(lines[end - 1])) end--;
  return {
    end,
    block: { t: 'l', ord: ordered, start, loose, items: outItems },
  };
}

// ---------------------------------------------------------------------------
// Setext heading + paragraph collection
// ---------------------------------------------------------------------------

// Setext heading (lheading) starting at line i. Returns null or
// {end, text, depth}.
function trySetext(lines, i, hi) {
  const textLines = [];
  let j = i;
  while (j < hi) {
    const ln = lines[j];
    if (SETEXT_RE.test(ln)) {
      if (textLines.length === 0) return null;
      const depth = ln.trim()[0] === '=' ? 1 : 2;
      return { end: j + 1, text: textLines.join('\n').trim(), depth };
    }
    if (textLines.length > 0 && paraInterruptsNoTable(ln)) return null;
    // The first line must not be a block start (the caller ensures this by
    // trying the other rules first); a later line that is a block start
    // (other than a setext underline) ends the heading attempt.
    textLines.push(ln);
    j++;
  }
  return null;
}

// Paragraph (top=true) or text (top=false) starting at line i.
// A paragraph collects lines until a block start (paragraph-interruption
// predicate). A text token is a SINGLE line: marked's text tokenizer
// matches /^[^\n]+/, so each following line is re-examined for block
// starts (any ordered list number can start a list inside an item,
// not just 1.).
function collectText(lines, i, hi, top, stripSet) {
  if (!top) return { text: lines[i], end: i + 1 };
  const acc = [lines[i]];
  let j = i + 1;
  while (j < hi) {
    if (paraInterrupts(lines[j], lines[j + 1])) {
      // A whitespace-only line at the very end of the range is paragraph
      // content, not a blank line: marked's paragraph regex excludes
      // `[ \t]+\n` (a whitespace-only line followed by a newline), but a
      // final whitespace-only line has no trailing newline (cm-241).
      if (isBlank(lines[j]) && j === hi - 1 && lines[j].length > 0) {
        acc.push(lines[j]);
        j++;
      }
      break;
    }
    // A lazy indented-code line inside a blockquote is a paragraph
    // continuation whose indent marked strips (its code-merge): the line
    // is listed in stripSet by parseBlockquote (cm-238). Stripping here,
    // after trySetext has already run on the unstripped line, keeps a
    // stripped setext-looking line (`    ===`) from becoming a heading.
    let ln = lines[j];
    if (stripSet && stripSet.has(j)) ln = ln.replace(/^(?: {0,3}\t| {1,4})/, '');
    acc.push(ln);
    j++;
  }
  return { text: acc.join('\n'), end: j };
}

// HTML block end. `kind` is the condition number from htmlBlockStart.
function htmlBlockEnd(lines, i, hi, kind) {
  let j = i;
  if (kind === 1) {
    const tag = /^ {0,3}<(\w+)/.exec(lines[i])[1].toLowerCase();
    const closeRe = new RegExp(`</${tag}`, 'i');
    while (j < hi) {
      if (closeRe.test(lines[j])) return j + 1;
      j++;
    }
    return hi;
  }
  if (kind === 2) {
    while (j < hi) {
      if (lines[j].includes('-->')) return j + 1;
      j++;
    }
    return hi;
  }
  if (kind === 3) {
    while (j < hi) {
      if (lines[j].includes('?>')) return j + 1;
      j++;
    }
    return hi;
  }
  if (kind === 4) {
    while (j < hi) {
      if (lines[j].includes('>')) return j + 1;
      j++;
    }
    return hi;
  }
  if (kind === 5) {
    while (j < hi) {
      if (lines[j].includes(']]>')) return j + 1;
      j++;
    }
    return hi;
  }
  // Kinds 6 and 7: end at the first blank line.
  while (j < hi) {
    if (isBlank(lines[j])) return j;
    j++;
  }
  return hi;
}

// ---------------------------------------------------------------------------
// Main block loop
// ---------------------------------------------------------------------------

function parseBlocks(lines, lo, hi, top, refs, out, stripSet) {
  let i = lo;
  // Type of the last token produced (paragraph/text/code/def/space/...).
  // A def token is a token even though it renders nothing, so a def after
  // a registered def does not merge into an earlier paragraph.
  let lastType = null;
  while (i < hi) {
    const line = lines[i];
    if (isBlank(line)) {
      // A run of blank lines between two blocks becomes a space token
      // (marked's loose check looks for a space token whose raw matches
      // /\n.*\n/ — i.e. at least one blank line between two blocks).
      // Leading/trailing blank runs are not tokens.
      let j2 = i;
      while (j2 < hi && isBlank(lines[j2])) j2++;
      if (out.length > 0 && j2 < hi) out.push({ t: 'space', s: '\n'.repeat(j2 - i + 1) });
      lastType = 'space'; i = j2; continue;
    }
    // Indented code (merges into a preceding paragraph/text token, but
    // only if no blank line intervenes — a blank line makes it a real
    // code block).
    const code = tryCodeBlock(lines, i, hi);
    if (code) {
      const prev = out[out.length - 1];
      if (prev && (lastType === 'p' || lastType === 'x')) prev.s += '\n' + code.text;
      else { out.push({ t: 'c', s: code.text, lang: '' }); lastType = 'c'; }
      i = code.end;
      continue;
    }
    // Fenced code.
    const fence = tryFences(lines, i, hi);
    if (fence) {
      out.push({ t: 'c', s: fence.text, lang: fence.lang });
      lastType = 'c';
      i = fence.end;
      continue;
    }
    // ATX heading.
    const atx = ATX_RE.exec(line);
    if (atx) {
      let n = atx[2].trim();
      if (n.endsWith('#')) {
        const s2 = n.replace(/#+$/, '');
        if (s2 === '' || /[ \t]$/.test(s2)) n = s2.trim();
      }
      out.push({ t: 'h', d: atx[1].length, s: n });
      lastType = 'h';
      i++;
      continue;
    }
    // Horizontal rule.
    if (HR_RE.test(line)) { out.push({ t: 'hr' }); lastType = 'hr'; i++; continue; }
    // Blockquote.
    if (BQ_START_RE.test(line)) {
      const bq = parseBlockquote(lines, i, hi, refs);
      out.push(bq.block);
      lastType = 'bq';
      i = bq.end;
      continue;
    }
    // List.
    if (LIST_START_RE.test(line)) {
      const lst = parseList(lines, i, hi, refs);
      out.push(lst.block);
      lastType = 'l';
      i = lst.end;
      continue;
    }
    // HTML block.
    const htmlKind = htmlBlockStart(line);
    if (htmlKind > 0) {
      const end = htmlBlockEnd(lines, i, hi, htmlKind);
      // Reconstruct the raw text (marked's Ue match) so ge() sees the
      // right trailing newlines. The regex endings differ by kind:
      // kinds 1-5 end with `[^\n]*\n*` (rest of line + consecutive
      // newlines only — a whitespace-only line stops it, so a tab-blank
      // after the block keeps the single trailing newline, doc-15/19/24);
      // kinds 6-7 end with `(?:\n[ \t]*)+\n` (they swallow following
      // blank lines, whitespace-only included, and ge() then strips the
      // trailing newline entirely, doc-03).
      let raw = lines.slice(i, end).join('\n');
      if (end < lines.length) {
        raw += '\n';
        // A line is real unless it is the trailing '' produced by
        // splitting a source that ends with '\n' (that '' is the
        // terminator of the last real line, not a blank line).
        const isReal = (k) => k + 1 < lines.length || lines[k] !== '';
        if (htmlKind === 6 || htmlKind === 7) {
          // Kinds 6-7 end with `(?:\n[ \t]*)+\n`: they swallow following
          // blank lines (whitespace-only included) and ge() then strips
          // the trailing newline (doc-03) — but only when content follows
          // the blank lines. At end of input the regex matches via `$`
          // instead, keeping the single trailing newline (cm-021).
          let k = end;
          while (k < lines.length && isBlank(lines[k]) && isReal(k)) k++;
          if (k < lines.length) {
            for (let q = end; q < k; q++) raw += lines[q] + '\n';
          }
        } else {
          let k = end;
          while (k < lines.length && lines[k].length === 0 && isReal(k)) { raw += '\n'; k++; }
        }
      }
      out.push({ t: 'html', s: trimBlankLines(raw) });
      lastType = 'html';
      i = end;
      continue;
    }
    // Link reference definition.
    if (/^ {0,3}\[/.test(line)) {
      const def = tryDef(lines, i, hi);
      if (def) {
        const prev = out[out.length - 1];
        if (prev && (lastType === 'p' || lastType === 'x')) {
          prev.s += '\n' + def.raw;
        } else {
          if (!(def.tag in refs)) refs[def.tag] = { href: def.href, title: def.title };
          lastType = 'def';
        }
        i = def.end;
        continue;
      }
    }
    // Table.
    const tab = tryTable(lines, i, hi);
    if (tab) {
      out.push(tab.block);
      lastType = 'tab';
      i = tab.end;
      continue;
    }
    // Setext heading.
    const setext = trySetext(lines, i, hi);
    if (setext) {
      out.push({ t: 'h', d: setext.depth, s: setext.text });
      lastType = 'h';
      i = setext.end;
      continue;
    }
    // Paragraph (top) or text (not top).
    const para = collectText(lines, i, hi, top, stripSet);
    if (!top) {
      // Consecutive text tokens merge (marked appends with '\n').
      const prev = out[out.length - 1];
      if (prev && lastType === 'x') {
        prev.s += '\n' + para.text;
        i = para.end;
        continue;
      }
    }
    out.push({ t: top ? 'p' : 'x', s: para.text });
    lastType = top ? 'p' : 'x';
    i = para.end;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks, refs, st, out) {
  for (const b of blocks) {
    switch (b.t) {
      case 'p':
        out.push('<p>', inlineHtml(b.s, refs, st), '</p>\n');
        break;
      case 'x':
        out.push(inlineHtml(b.s, refs, st));
        break;
      case 'h': {
        const id = st.slugger ? st.slugger.slug(b.s) : '';
        out.push('<h', String(b.d), id ? ` id="${id}"` : '', '>', inlineHtml(b.s, refs, st), '</h', String(b.d), '>\n');
        break;
      }
      case 'c': {
        let r = b.s ? b.s.replace(/\n$/, '') + '\n' : '';
        if (b.lang) {
          const lang = b.lang.split(' ')[0];
          out.push('<pre><code class="language-', escapeNoEnc(lang), '">', escapeAll(r), '</code></pre>\n');
        } else {
          out.push('<pre><code>', escapeAll(r), '</code></pre>\n');
        }
        break;
      }
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'html':
        out.push(b.s);
        break;
      case 'bq': {
        out.push('<blockquote>\n');
        renderBlocks(b.ch, refs, st, out);
        out.push('</blockquote>\n');
        break;
      }
      case 'l': {
        const tag = b.ord ? 'ol' : 'ul';
        out.push('<', tag);
        if (b.ord && b.start !== null && b.start !== 1) out.push(' start="', String(b.start), '"');
        out.push('>\n');
        for (const it of b.items) {
          out.push('<li>');
          const first = it.ch[0];
          if (it.checked !== null && b.loose && first && first.t === 'p') {
            // Loose task item: the checkbox goes inside the first
            // paragraph (marked unshifts it into the paragraph's
            // inline tokens when the list is loose).
            out.push('<p><input ', it.checked ? 'checked="" ' : '', 'disabled="" type="checkbox"> ');
            out.push(inlineHtml(first.s, refs, st), '</p>\n');
            renderBlocks(it.ch.slice(1), refs, st, out);
          } else {
            if (it.checked !== null) {
              out.push('<input ', it.checked ? 'checked="" ' : '', 'disabled="" type="checkbox"> ');
            }
            renderBlocks(it.ch, refs, st, out);
          }
          out.push('</li>\n');
        }
        out.push('</', tag, '>\n');
        break;
      }
      case 'tab': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (const c of b.head) {
          out.push('<th');
          if (c.align) out.push(' align="', c.align, '"');
          out.push('>', inlineHtml(c.s, refs, st), '</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        if (b.rows.length > 0) {
          out.push('<tbody>');
          for (const row of b.rows) {
            out.push('<tr>\n');
            for (const c of row) {
              out.push('<td');
              if (c.align) out.push(' align="', c.align, '"');
              out.push('>', inlineHtml(c.s, refs, st), '</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody>');
        }
        out.push('</table>\n');
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const lines = src.split('\n');
  const refs = Object.create(null);
  const blocks = [];
  parseBlocks(lines, 0, lines.length, true, refs, blocks);
  const out = [];
  const st = { slugger: null };
  renderBlocks(blocks, refs, st, out);
  return out.join('');
}
