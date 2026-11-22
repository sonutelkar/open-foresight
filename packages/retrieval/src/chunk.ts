import type { Heading } from '@open-foresight/core';

/** Bump when chunk boundaries could change for the same text. */
export const CHUNKER_VERSION = 'chunk-1';

export type ChunkOptions = {
  /** Aim for this many characters, about 800 tokens at 4 characters a token. */
  targetChars?: number;
  /** Repeat this many characters from the end of one chunk at the start of the next. */
  overlapChars?: number;
  /** Never exceed this. Keeps a chunk far below the embedding model's input limit. */
  maxChars?: number;
};
export type Chunk = { ordinal: number; section: string; start: number; end: number; text: string };

type Section = { title: string; start: number; end: number };

function sectionsOf(text: string, headings: Heading[]): Section[] {
  const marks = [...headings].filter(h => h.offset >= 0 && h.offset < text.length).sort((a, b) => a.offset - b.offset);
  const out: Section[] = [];
  const first = marks[0];
  if (!first || first.offset > 0) out.push({ title: first ? 'preamble' : 'document', start: 0, end: first ? first.offset : text.length });
  marks.forEach((mark, i) => {
    const next = marks[i + 1];
    const last = out[out.length - 1];
    if (last && last.start === mark.offset) { last.title = mark.title; last.end = next ? next.offset : text.length; return; }
    out.push({ title: mark.title, start: mark.offset, end: next ? next.offset : text.length });
  });
  return out.filter(s => text.slice(s.start, s.end).trim().length > 0);
}

/** The latest natural break in `from..to`, preferring a line, then a sentence, then a word. Returns the end offset after the break. */
function breakPoint(text: string, from: number, to: number): number {
  const window = text.slice(from, to);
  const line = window.lastIndexOf('\n');
  if (line >= 0) return from + line + 1;
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('; '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  if (sentence >= 0) return from + sentence + 2;
  const space = window.lastIndexOf(' ');
  return space >= 0 ? from + space + 1 : to;
}

/**
 * Splits extracted text into overlapping windows inside each section.
 * Every chunk satisfies `text.slice(start, end) === chunk.text`, so a hit points back to exact source offsets.
 */
export function chunkText(input: { text: string; headings: Heading[] }, options: ChunkOptions = {}): Chunk[] {
  const target = options.targetChars ?? 3200;
  const overlap = options.overlapChars ?? 400;
  const max = options.maxChars ?? 4800;
  if (!(target > 0) || overlap < 0 || overlap >= target || max < target) throw new Error('Invalid chunk options');
  const { text } = input;
  const chunks: Chunk[] = [];
  for (const section of sectionsOf(text, input.headings)) {
    let position = section.start;
    while (position < section.end) {
      let end = Math.min(position + target, section.end);
      if (end < section.end) {
        const lower = position + Math.floor(target * 0.6);
        const broke = breakPoint(text, lower, end);
        if (broke > position) end = broke;
        // Absorb a short tail so the last chunk is not a sliver.
        if (section.end - end < Math.floor(target * 0.25) && section.end - position <= max) end = section.end;
      }
      let start = position;
      while (start < end && /\s/.test(text[start] ?? '')) start++;
      let stop = end;
      while (stop > start && /\s/.test(text[stop - 1] ?? '')) stop--;
      if (stop > start) chunks.push({ ordinal: chunks.length, section: section.title, start, end: stop, text: text.slice(start, stop) });
      if (end >= section.end) break;
      let next = end - overlap;
      if (next <= position) next = end;
      const space = text.slice(next, end).search(/\s/);
      position = space >= 0 && next + space < end ? next + space + 1 : next;
      if (position <= start) position = end;
    }
  }
  return chunks;
}
