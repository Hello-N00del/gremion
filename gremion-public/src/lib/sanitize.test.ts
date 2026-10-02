// gremion-public/src/lib/sanitize.test.ts
//
// The portal renders Collabora-authored `body_html` through `{@html}` on
// `/protokolle/[id]` (the kernel portal; the source also had `/aktuelles/[slug]`). `sanitizeHtml` is the only
// thing between stored HTML and an ANONYMOUS reader's browser there, and until
// now it had no test at all — the file's behaviour was pinned by nothing.
//
// SCOPE, deliberately narrow: this file covers ONLY the contracts that are
// settled. The `<img src>` model is an OPEN product decision (audit finding
// #459-4, see docs/security/portal-image-model-open-decision.md) — what a
// portal image is allowed to be has not been chosen, so pinning any image
// behaviour here would freeze an answer nobody has given. There is therefore
// no image case below, on purpose. Add them with the decision, not before.
import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from './sanitize';

describe('sanitizeHtml — active content is removed', () => {
  it('strips a <script> element, tag and payload alike', () => {
    const out = sanitizeHtml('<p>before</p><script>alert(1)</script><p>after</p>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    // the surrounding document survives — this is not a nuke of the body
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('strips an inline event handler (on* attribute) but keeps its element', () => {
    const out = sanitizeHtml('<p onclick="alert(1)">text</p>');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('text');
  });

  it('strips on* handlers on a link too, without dropping the link', () => {
    const out = sanitizeHtml('<a href="/satzung" onmouseover="steal()">Satzung</a>');
    expect(out).not.toContain('onmouseover');
    expect(out).not.toContain('steal()');
    expect(out).toContain('/satzung');
  });

  it('strips a javascript: href — the click-to-execute vector', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">klick</a>');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('alert(1)');
    // the link TEXT is kept; only the executable target is removed
    expect(out).toContain('klick');
  });

  it('strips a javascript: href however it is cased or padded', () => {
    for (const href of ['JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)']) {
      const out = sanitizeHtml(`<a href="${href}">x</a>`);
      expect(out.toLowerCase()).not.toContain('javascript:');
      expect(out).not.toContain('alert(1)');
    }
  });

  it('drops elements that are not on the allowlist (iframe, object, form)', () => {
    const out = sanitizeHtml(
      '<iframe src="https://evil.example"></iframe><object data="x"></object><form action="/x"><input></form>',
    );
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<object');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('<input');
  });
});

describe('sanitizeHtml — legitimate content is preserved', () => {
  it('keeps an EXTERNAL <a href> — a link is followed by consent, unlike a subresource', () => {
    const out = sanitizeHtml('<a href="https://example.org/satzung">Satzung</a>');
    expect(out).toContain('https://example.org/satzung');
    expect(out).toContain('Satzung');
  });

  it('keeps a mailto: link', () => {
    const out = sanitizeHtml('<a href="mailto:vorsitz@example.org">Mail</a>');
    expect(out).toContain('mailto:vorsitz@example.org');
  });

  it('keeps the structural markup Collabora emits (headings, lists, tables)', () => {
    const out = sanitizeHtml(
      '<h2>TOP 1</h2><ul><li>Punkt</li></ul><table><tbody><tr><td colspan="2">Zelle</td></tr></tbody></table>',
    );
    expect(out).toContain('<h2>');
    expect(out).toContain('<li>');
    expect(out).toContain('<td');
    expect(out).toContain('colspan="2"');
  });

  it('keeps inline emphasis and paragraph structure', () => {
    const out = sanitizeHtml('<p>ein <strong>wichtiger</strong> <em>Beschluss</em></p>');
    expect(out).toContain('<strong>wichtiger</strong>');
    expect(out).toContain('<em>Beschluss</em>');
  });

  it('is total on empty and plain-text input (never throws, never invents markup)', () => {
    expect(sanitizeHtml('')).toBe('');
    expect(sanitizeHtml('nur Text')).toBe('nur Text');
  });
});
