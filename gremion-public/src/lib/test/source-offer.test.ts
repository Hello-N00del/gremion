// AGPL-3.0 section 13 guard — the public portal must offer its source.
//
// Section 13 is not discharged by a LICENSE file in a repository: a user who
// interacts with the program over a network has to be offered the Corresponding
// Source of the version they are running, from the running program. For this
// app that means the footer chrome every page renders.
//
// The rendering half is a source guard rather than a mounted render: this app's
// vitest project has no DOM environment (see vite.config.ts), so the cheap,
// honest check is that the wiring exists end to end — load supplies it, layout
// passes it, footer renders it as a link.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveSourceUrl, DEFAULT_SOURCE_URL, SOURCE_OFFER_LABEL } from '../source-offer';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('resolveSourceUrl', () => {
  it('falls back to upstream when unset', () => {
    expect(resolveSourceUrl(undefined)).toBe(DEFAULT_SOURCE_URL);
    expect(resolveSourceUrl(null)).toBe(DEFAULT_SOURCE_URL);
  });

  it('treats an empty or blank value as unset', () => {
    // docker compose substitutes ${VAR:-} as an EMPTY STRING, so this — not
    // undefined — is the shape a missing value actually arrives in.
    expect(resolveSourceUrl('')).toBe(DEFAULT_SOURCE_URL);
    expect(resolveSourceUrl('  ')).toBe(DEFAULT_SOURCE_URL);
  });

  it("uses the operator's own repository when configured", () => {
    expect(resolveSourceUrl('https://git.council.example/gremion')).toBe(
      'https://git.council.example/gremion',
    );
  });

  it('names the licence in the label', () => {
    expect(SOURCE_OFFER_LABEL).toContain('AGPL');
  });
});

describe('the portal chrome offers the source', () => {
  it('renders a labelled link bound to the resolved URL in the footer', () => {
    const footer = read('../components/PortalFooter.svelte');
    expect(footer).toContain('SOURCE_OFFER_LABEL');
    expect(footer).toMatch(/href=\{sourceUrl\}/);
    expect(footer).toContain('rel="noopener noreferrer"');
  });

  it('threads the operator value from the layout load to the footer', () => {
    expect(read('../../routes/+layout.server.ts')).toContain(
      'resolveSourceUrl(env.PUBLIC_SOURCE_URL)',
    );
    expect(read('../../routes/+layout.svelte')).toContain('sourceUrl={data.sourceUrl}');
  });
});
