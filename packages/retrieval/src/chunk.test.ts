import { describe, expect, it } from 'vitest';
import { chunkText } from './chunk.js';

function rng(seed: number) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const words = ['revenue', 'segment', 'grid', 'energy', 'cash', 'flow', 'the', 'and', 'of', 'risk', 'market', 'Mærsk', 'données', 'Überschuss', '2026', 'USD', '1.5bn'];
function doc(seed: number, size: number) {
  const r = rng(seed); let out = '';
  while (out.length < size) {
    const sentence = Array.from({ length: 4 + Math.floor(r() * 14) }, () => words[Math.floor(r() * words.length)]).join(' ');
    out += sentence + (r() < 0.2 ? '.\n' : r() < 0.5 ? '. ' : ' ');
  }
  return out;
}

describe('chunkText', () => {
  it('keeps exact offsets, covers every character, stays under the limit and is ordered, over many documents', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const text = doc(seed, 500 + seed * 977);
      const marks = seed % 3 === 0 ? [{ offset: Math.floor(text.length * 0.4), level: 1, title: 'Item 7' }, { offset: Math.floor(text.length * 0.7), level: 1, title: 'Item 8' }] : [];
      const chunks = chunkText({ text, headings: marks });
      const covered = new Uint8Array(text.length);
      chunks.forEach((c, i) => {
        expect(text.slice(c.start, c.end)).toBe(c.text);
        expect(c.text).toBe(c.text.trim());
        expect(c.text.length).toBeLessThanOrEqual(4800);
        expect(c.ordinal).toBe(i);
        expect(c.end).toBeGreaterThan(c.start);
        for (let p = c.start; p < c.end; p++) covered[p] = 1;
      });
      for (let p = 0; p < text.length; p++) if (!/\s/.test(text[p] ?? '')) expect(covered[p], `seed ${seed} char ${p}`).toBe(1);
      for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.start);
    }
  });

  it('returns one chunk for short text and none for empty or blank text', () => {
    expect(chunkText({ text: 'A short note.', headings: [] })).toEqual([{ ordinal: 0, section: 'document', start: 0, end: 13, text: 'A short note.' }]);
    expect(chunkText({ text: '', headings: [] })).toEqual([]);
    expect(chunkText({ text: '  \n  ', headings: [] })).toEqual([]);
  });

  it('never lets a chunk cross a section boundary and labels chunks with their section', () => {
    const a = doc(7, 9000), b = doc(8, 9000);
    const text = `${a}\n${b}`;
    const boundary = a.length + 1;
    const chunks = chunkText({ text, headings: [{ offset: 0, level: 1, title: 'Item 1A' }, { offset: boundary, level: 1, title: 'Item 7' }] });
    expect(new Set(chunks.map(c => c.section))).toEqual(new Set(['Item 1A', 'Item 7']));
    for (const c of chunks) {
      if (c.section === 'Item 1A') expect(c.end).toBeLessThanOrEqual(boundary);
      else expect(c.start).toBeGreaterThanOrEqual(boundary);
    }
  });

  it('overlaps consecutive chunks inside a section by about the overlap and prefers line breaks', () => {
    const text = doc(3, 20000);
    const chunks = chunkText({ text, headings: [] });
    expect(chunks.length).toBeGreaterThan(4);
    for (let i = 1; i < chunks.length - 1; i++) {
      const overlap = chunks[i - 1]!.end - chunks[i]!.start;
      expect(overlap).toBeGreaterThan(0);
      expect(overlap).toBeLessThanOrEqual(600);
    }
    const lined = 'Line of text number one.\n'.repeat(400);
    const first = chunkText({ text: lined, headings: [] })[0];
    expect(first?.text.endsWith('one.')).toBe(true);
  });

  it('makes progress and terminates on text with no spaces', () => {
    const text = 'x'.repeat(20000);
    const chunks = chunkText({ text, headings: [] });
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every(c => c.text.length <= 4800)).toBe(true);
  });

  it('is deterministic and rejects invalid options', () => {
    const text = doc(5, 12000);
    expect(chunkText({ text, headings: [] })).toEqual(chunkText({ text, headings: [] }));
    expect(() => chunkText({ text, headings: [] }, { targetChars: 100, overlapChars: 100 })).toThrow();
    expect(() => chunkText({ text, headings: [] }, { targetChars: 100, overlapChars: 10, maxChars: 50 })).toThrow();
  });
});
