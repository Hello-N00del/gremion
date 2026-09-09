<script lang="ts">
  import '../app.css';
  import type { Snippet } from 'svelte';
  import { page } from '$app/stores';
  import { base } from '$app/paths';
  import type { LayoutData } from './$types';
  import PortalHeader from '$lib/components/PortalHeader.svelte';
  import PortalFooter from '$lib/components/PortalFooter.svelte';

  let { children, data }: { children: Snippet; data: LayoutData } = $props();

  // v12 — every internal link goes through `base` (empty by default, e.g.
  // `/portal` when the portal is mounted under a path). These are anchors on
  // the portal's own landing page.
  const navLinks = [
    { href: `${base}/#übersicht`,     label: 'Übersicht' },
    { href: `${base}/#organisation`,  label: 'Organisation' },
    { href: `${base}/#protokolle`,    label: 'Protokolle' },
    { href: `${base}/#kontakt`,       label: 'Kontakt' },
  ];

  let currentPath = $derived($page.url.pathname);
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
  <div class="border-b border-ink-subtle bg-ink text-[11px] tracking-widest text-white/60">
    <div class="mx-auto flex max-w-7xl items-center justify-between px-5 py-1.5">
      <nav aria-label="Barrierefreiheit" class="flex items-center gap-4">
        <a href="#main-content" class="uppercase hover:text-white/90">DE</a>
        <span class="text-white/20">·</span>
        <a href="{base}/kontakt#barrierefreiheit" class="uppercase hover:text-white/90">Barrierefreiheit</a>
        <span class="text-white/20">·</span>
        <a href="{base}/kontakt#leichte-sprache" class="uppercase hover:text-white/90">Leichte Sprache</a>
      </nav>
      <div class="flex items-center gap-3 text-white/40 uppercase">
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
    institutionName={data.institutionName ?? 'Studierendenrat'}
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
    institutionName={data.institutionName ?? 'Studierendenrat'}
    apexHref={data.apexUrl}
    apexLabel={data.apexColophon}
    sourceUrl={data.sourceUrl}
  />

</div>
