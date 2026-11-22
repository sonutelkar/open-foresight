import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { htmlToText } from './html.js';

describe('htmlToText', () => {
  it('joins inline elements without a separator and breaks lines at blocks', () => {
    const { text } = htmlToText('<div>Mark<span class="_ _0"></span>et environment</div><div>Review <b>9M</b> 2026</div><p>One</p><p>Two</p>');
    expect(text).toBe('Market environment\nReview 9M 2026\nOne\nTwo');
  });
  it('decodes entities, collapses whitespace and drops scripts, styles and the XBRL header', () => {
    const { text } = htmlToText('<html><head><title>T</title><style>.a{}</style></head><body><ix:header><xbrli:context>HIDDEN</xbrli:context></ix:header><script>var x=1</script><p>A &amp; B\n\n   c&nbsp;d</p></body></html>');
    expect(text).toBe('A & B c d');
  });
  it('passes plain text through', () => {
    expect(htmlToText('Form 10-K\nFor the fiscal year').text).toBe('Form 10-K For the fiscal year');
  });
  it('marks headings and drops short sections such as table of contents entries', () => {
    const body = 'Revenue grew because of services. '.repeat(10);
    const { text, headings } = htmlToText(`<h1>Contents</h1><p>short</p><h2>Item 7. Management discussion</h2><p>${body}</p><h2>Risk factors</h2><p>${body}</p>`);
    expect(headings.map(h => h.title)).toEqual(['Item 7. Management discussion', 'Risk factors']);
    expect(text.slice(headings[0]?.offset ?? 0).startsWith('Item 7.')).toBe(true);
    expect(headings[1] && text.slice(headings[1].offset).startsWith('Risk factors')).toBe(true);
  });
  it('detects SEC Item lines in plain text and keeps the later real section over the contents entry', () => {
    const body = 'We design and sell phones and services worldwide. '.repeat(8);
    const { text, headings } = htmlToText(`<div>Item 1. Business</div><div>Item 1A. Risk Factors</div><div>Item 1. Business</div><div>${body}</div><div>Item 1A. Risk Factors</div><div>${body}</div>`);
    expect(headings.map(h => h.title)).toEqual(['Item 1. Business', 'Item 1A. Risk Factors']);
    expect(headings[0]?.offset).toBeGreaterThan(text.indexOf('Item 1A.'));
  });
  it('marks outer ESEF text blocks and ignores tiny ones', () => {
    const body = 'The Group reports revenue by segment and region. '.repeat(8);
    const { headings } = htmlToText(`<div><ix:nonNumeric name="ifrs-full:DisclosureOfRevenueExplanatory"><div>${body}</div><ix:nonNumeric name="gsd:Inner"><div>${body}</div></ix:nonNumeric></ix:nonNumeric></div><div><ix:nonNumeric name="gsd:IdentificationNumberCvr">12345678</ix:nonNumeric></div>`);
    expect(headings.map(h => h.title)).toEqual(['DisclosureOfRevenueExplanatory']);
  });
  it('extracts words from a real PDF-converted ESEF report excerpt without header noise', () => {
    const html = readFileSync(new URL('../../data/fixtures/esef/report-excerpt.xhtml', import.meta.url), 'utf8');
    const { text } = htmlToText(html);
    expect(text.length).toBeGreaterThan(500);
    expect(text).not.toMatch(/xbrli|iVBORw0KGgo|<div|class=/);
    expect(text).toMatch(/Market environment|Review 9M 2026/);
  });
  it('is deterministic', () => {
    const html = '<div>a<span>b</span></div><h2>H</h2>' + '<p>x y z. </p>'.repeat(40);
    expect(htmlToText(html)).toEqual(htmlToText(html));
  });
});
