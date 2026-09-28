import { describe, it, expect } from 'vitest';
import { generateSlug, deduplicateSlug } from './news-db.js';

describe('generateSlug', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(generateSlug('Hello World')).toBe('hello-world');
  });

  it('removes diacritics (German umlauts)', () => {
    expect(generateSlug('Öffentliche Ankündigung')).toBe('offentliche-ankundigung');
  });

  it('strips non-alphanumeric characters', () => {
    expect(generateSlug('StuRa 2026: Update!')).toBe('stura-2026-update');
  });

  it('collapses multiple hyphens', () => {
    expect(generateSlug('foo  --  bar')).toBe('foo-bar');
  });

  it('trims leading and trailing hyphens', () => {
    expect(generateSlug('  hello  ')).toBe('hello');
  });
});

describe('deduplicateSlug', () => {
  it('returns base slug when no conflict', () => {
    expect(deduplicateSlug('hello', [])).toBe('hello');
  });

  it('appends -2 on first conflict', () => {
    expect(deduplicateSlug('hello', ['hello'])).toBe('hello-2');
  });

  it('increments until unique', () => {
    expect(deduplicateSlug('hello', ['hello', 'hello-2', 'hello-3'])).toBe('hello-4');
  });
});
