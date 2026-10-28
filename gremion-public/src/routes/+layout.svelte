<script lang="ts">
  import '../app.css';
  // TASK-007: self-hosted fonts — no third-party Google Fonts dependency
  // (GDPR) and no CSP-blocked external request. Weight/style list mirrors
  // exactly what the removed Google `css2?family=` request used to load
  // (brief Sec5 Q2), not app.css's `--font-display` value (a pre-existing,
  // declared-but-never-loaded "Outfit" token this task does not touch).
  import '@fontsource/archivo-narrow/400.css';
  import '@fontsource/archivo-narrow/400-italic.css';
  import '@fontsource/archivo-narrow/500.css';
  import '@fontsource/archivo-narrow/600.css';
  import '@fontsource/archivo-narrow/700.css';
  import '@fontsource/archivo-narrow/700-italic.css';
  import '@fontsource/inter/400.css';
  import '@fontsource/inter/500.css';
  import '@fontsource/inter/600.css';
  import '@fontsource/jetbrains-mono/400.css';
  import '@fontsource/jetbrains-mono/500.css';
  import type { Snippet } from 'svelte';
  // KIT-2 RULE (R25-3): kit-3-forward-compatible even on the SvelteKit 2 tree
  // — $app/state instead of the deprecated $app/stores, resolve() instead of
  // the deprecated `base` export from $app/paths (both already available in
  // the installed kit 2.70.3, per its own @deprecated JSDoc).
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import type { LayoutData } from './$types';
  import PortalHeader from '$lib/components/PortalHeader.svelte';
  import PortalFooter from '$lib/components/PortalFooter.svelte';

  let { children, data }: { children: Snippet; data: LayoutData } = $props();

  // v12 — every internal link goes through `resolve()` (empty base by
  // default, e.g. `/portal` when the portal is mounted under a path). These
  // are anchors on the portal's own landing page.
  const navLinks = [
    { href: `${resolve('/')}#übersicht`,     label: 'Übersicht' },
    { href: `${resolve('/')}#organisation`,  label: 'Organisation' },
    { href: `${resolve('/')}#protokolle`,    label: 'Protokolle' },
    { href: `${resolve('/')}#kontakt`,       label: 'Kontakt' },
  ];

  let currentPath = $derived(page.url.pathname);
</script>

<!-- Skip-to-content — WCAG 2.4.1 -->
<a
  href="#main-content"
  class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50
         focus:rounded focus:bg-[var(--ember)] focus:px-4 focus:py-2 focus:text-white"
>
  Zum Inhalt springen
</a>

<div class="flex min-h-screen flex-col bg-paper font-body text-ink">

  <!-- ── Utility bar ─────────────────────────────────────────────────────── -->
  <div
    class="border-b border-ink-subtle bg-ink text-[11px] tracking-widest text-white/60"
    data-testid="portal-utility-bar"
  >
    <!-- Below `sm` the two groups (and the links inside the nav) may wrap
         instead of overflowing: at 360px the strip was ~22px wider than the
         viewport. Unchanged from `sm` up, where everything fits on one line. -->
    <div class="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-1.5">
      <nav aria-label="Barrierefreiheit" class="flex flex-wrap items-center gap-x-4 gap-y-1">
        <a href="#main-content" class="uppercase hover:text-white/90">DE</a>
        <span class="text-white/20">·</span>
        <a href="{resolve('/kontakt')}#barrierefreiheit" class="uppercase hover:text-white/90">Barrierefreiheit</a>
        <span class="text-white/20">·</span>
        <a href="{resolve('/kontakt')}#leichte-sprache" class="uppercase hover:text-white/90">Leichte Sprache</a>
      </nav>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-white/40 uppercase">
        <span>Öffentliches Portal</span>
        <!-- PUBLIC_PRODUCT_NAME is unset on an unconfigured kernel deploy, and
             it no longer defaults to any instance's name. Render nothing —
             separator included, or a bare "·" would dangle. -->
        {#if data.product}
          <span class="text-white/20">·</span>
          <span>{data.product}</span>
        {/if}
      </div>
    </div>
  </div>

  <!-- ── Main header ─────────────────────────────────────────────────────── -->
  <PortalHeader
    institutionName={data.institutionName ?? 'Gremium'}
    legislatureLabel={data.legislatureLabel}
    mainAppUrl={data.mainAppUrl}
    {navLinks}
    {currentPath}
    apexHref={data.apexUrl}
    apexLabel={data.apexLabel}
    apexNote={data.apexNote}
  />

  <!-- ── Page content ────────────────────────────────────────────────────── -->
  <main id="main-content" class="flex-1">
    {@render children()}
  </main>

  <!-- ── Footer ─────────────────────────────────────────────────────────── -->
  <PortalFooter
    institutionName={data.institutionName ?? 'Gremium'}
    apexHref={data.apexUrl}
    apexLabel={data.apexColophon}
    sourceUrl={data.sourceUrl}
  />

</div>
