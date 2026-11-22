import type { Embedder } from '@open-foresight/llm';
import { EMBEDDING_DIMENSIONS } from '@open-foresight/db';

/** A deterministic offline embedder. Words hash into buckets, so overlapping words give similar vectors. */
export function fakeEmbedder(model = 'fake/hash-embed'): Embedder & { calls: number } {
  const state = { calls: 0 };
  const embedOne = (text: string) => {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      let h = 2166136261;
      for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
      v[h % EMBEDDING_DIMENSIONS]! += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map(x => x / norm);
  };
  return {
    model, provider: 'fake', dimensions: EMBEDDING_DIMENSIONS,
    get calls() { return state.calls; },
    async embed(texts) { state.calls++; return { vectors: texts.map(embedOne), tokens: texts.length, costUsd: 0 }; },
  };
}
