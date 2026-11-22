import { Parser } from 'htmlparser2';

/** Bump when the output for the same input could change. Chunk offsets refer to this output. */
export const EXTRACTOR_VERSION = 'html-text-1';

export type Heading = { offset: number; level: number; title: string };
export type ExtractedText = { text: string; headings: Heading[] };

const blocks = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'title']);
const skipped = new Set(['script', 'style', 'head', 'ix:header', 'ix:hidden', 'noscript']);
const minSectionChars = 200;
const itemLine = /^(?:part\s+[ivx]+\b.{0,60}|item\s+\d{1,2}[a-c]?\b\.?.{0,100})$/i;

/**
 * Turns HTML, XHTML or inline XBRL into plain text with section markers. Plain text passes through.
 * Inline elements join without a separator, so a word split by an empty span stays whole.
 * Block elements start a new line. The hidden XBRL header, scripts and styles are dropped.
 * Markers come from h1 to h6, from outer ESEF `ix:nonNumeric` text blocks, and from SEC "Item" lines.
 * A marker whose section is under 200 characters is dropped, which removes table of contents entries.
 */
export function htmlToText(html: string): ExtractedText {
  let out = '';
  let skip = 0;
  let nonNumericDepth = 0;
  const open: Array<{ kind: 'heading' | 'block'; level: number; title: string; offset: number; start: number }> = [];
  const markers: Heading[] = [];
  const append = (value: string) => {
    for (const ch of value) {
      if (/\s/.test(ch)) { if (out.length > 0 && !/\s/.test(out[out.length - 1] ?? '')) out += ' '; }
      else out += ch;
    }
  };
  const newline = () => {
    if (out.length === 0 || out.endsWith('\n')) return;
    out = out.replace(/ $/, '') + '\n';
  };
  const parser = new Parser({
    onopentag(name, attrs) {
      if (skipped.has(name)) { skip++; return; }
      if (skip) return;
      if (blocks.has(name)) newline();
      if (/^h[1-6]$/.test(name)) open.push({ kind: 'heading', level: Number(name[1]), title: '', offset: out.length, start: out.length });
      else if (name === 'ix:nonnumeric' || name === 'ix:nonNumeric') {
        if (nonNumericDepth++ === 0 && attrs.name) open.push({ kind: 'block', level: 2, title: attrs.name.split(':').pop() ?? attrs.name, offset: out.length, start: out.length });
      }
    },
    ontext(data) { if (!skip) append(data); },
    onclosetag(name) {
      if (skipped.has(name)) { skip = Math.max(0, skip - 1); return; }
      if (skip) return;
      if (/^h[1-6]$/.test(name)) {
        const top = open.pop();
        if (top?.kind === 'heading') { const title = out.slice(top.start).trim(); if (title) markers.push({ offset: top.offset, level: top.level, title: title.slice(0, 120) }); }
      } else if (name === 'ix:nonnumeric' || name === 'ix:nonNumeric') {
        nonNumericDepth = Math.max(0, nonNumericDepth - 1);
        if (nonNumericDepth === 0) { const top = open.pop(); if (top?.kind === 'block' && out.length - top.start >= minSectionChars) markers.push({ offset: top.offset, level: top.level, title: top.title }); }
      }
      if (blocks.has(name)) newline();
    },
  }, { decodeEntities: true, lowerCaseTags: true, xmlMode: false, recognizeSelfClosing: true });
  parser.write(html);
  parser.end();
  const text = out.replace(/\s+$/, '');
  // SEC style Item lines.
  let position = 0;
  for (const line of text.split('\n')) {
    if (itemLine.test(line.trim())) markers.push({ offset: position, level: 1, title: line.trim().slice(0, 120) });
    position += line.length + 1;
  }
  markers.sort((a, b) => a.offset - b.offset || a.level - b.level);
  const headings: Heading[] = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (!marker) continue;
    const next = markers.slice(i + 1).find(m => m.offset > marker.offset);
    const end = next ? next.offset : text.length;
    if (end - marker.offset < minSectionChars) continue;
    const previous = headings[headings.length - 1];
    if (previous && previous.offset === marker.offset) continue;
    headings.push(marker);
  }
  return { text, headings };
}
