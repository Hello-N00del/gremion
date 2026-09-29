// gremion-public/src/hooks.server.test.ts
//
// #259-2 established the portal's app-layer security headers. This file pins
// the ATTACHMENT contract — which responses get them, and which do not — plus
// the directives that are settled.
//
// SCOPE, deliberately narrow: `img-src` is NOT asserted here. What a portal
// image may be is an OPEN product decision (audit finding #459-4, see
// docs/security/portal-image-model-open-decision.md); the directive's current
// value (`'self' data: blob: https:`) is the pre-decision baseline, and a test
// asserting it either way would turn an open question into a pinned contract.
// The other directives below are settled and are pinned.
import { describe, it, expect } from 'vitest';
// Kernel port (TASK-206-A): the kernel self-hosts its fonts (TASK-007), so the
// source's "keeps Google Fonts reachable" case is dropped (the opposite is
// pinned by lib/test/csp-no-third-party-fonts.test.ts), and the header hook is
// the kernel's `securityHeadersHandle` (its `handle` is the TASK-062 i18n
// sequence around it).
import { CSP_HEADER_VALUE, securityHeadersHandle as handle } from './hooks.server';

function directive(name: string): string {
  const found = CSP_HEADER_VALUE.split('; ').find((d) => d.startsWith(`${name} `));
  return found ?? '';
}

describe('public-portal CSP — the settled directives', () => {
  it('defaults to self', () => {
    expect(directive('default-src')).toBe("default-src 'self'");
  });

  it('forbids ALL framing — the portal embeds nothing and needs no framing', () => {
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  it('forbids plugin elements outright', () => {
    expect(directive('object-src')).toBe("object-src 'none'");
  });

  it('pins base-uri and form-action to self', () => {
    expect(directive('base-uri')).toBe("base-uri 'self'");
    expect(directive('form-action')).toBe("form-action 'self'");
  });

  it('does not grant a script source beyond self + the SvelteKit inline hydration script', () => {
    expect(directive('script-src')).toBe("script-src 'self' 'unsafe-inline'");
  });
});

describe('handle — headers are attached to HTML responses only', () => {
  const call = (contentType: string) =>
    handle({
      event: {} as never,
      resolve: async () =>
        new Response('<html></html>', { headers: { 'content-type': contentType } }),
    } as never) as Promise<Response>;

  it('sets the CSP and the anti-framing headers on a text/html response', async () => {
    const res = await call('text/html; charset=utf-8');
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP_HEADER_VALUE);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('leaves a JSON response untouched — a CSP only applies to a parsed document', async () => {
    const res = await call('application/json');
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
    expect(res.headers.get('X-Frame-Options')).toBeNull();
    expect(res.headers.get('X-Content-Type-Options')).toBeNull();
  });

  it('leaves a binary attachment (the protocol PDF route) untouched', async () => {
    const res = await call('application/pdf');
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
  });
});
