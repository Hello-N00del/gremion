<script lang="ts">
  // PortalFooter — public-portal footer (PR 5 T5.1.5). Ported from the
  // bundle's four-column footer (brand blurb · Kontakt · Mitmachen ·
  // Rechtliches) plus a legal bottom bar. Read-only links; skinned with the
  // production app.css token system (Outfit display, oklch tokens,
  // .dark auto-switch).
  //
  // v12 apex topology adds the COLOPHON below the legal bar — the footer half
  // of the back-route the apex strip opens in PortalHeader.
  import { base } from '$app/paths';
  import { SOURCE_OFFER_LABEL, resolveSourceUrl } from '$lib/source-offer';

  let {
    institutionName = 'Studierendenrat',
    apexHref = null,
    apexLabel = null,
    sourceUrl = resolveSourceUrl(),
  }: {
    institutionName?: string;
    /**
     * AGPL-3.0 section 13 — where this instance's Corresponding Source lives.
     * Supplied by the layout load from PUBLIC_SOURCE_URL so an operator running
     * a modified build points at THEIR source; defaults to upstream, which is
     * the corresponding source of an unmodified deploy.
     */
    sourceUrl?: string;
    /**
     * v12 — where the colophon points: the site ABOVE this portal. Deliberately
     * NOT `base`-prefixed (see PortalHeader for the full reasoning). Defaults to
     * `null` — the kernel has no site above it, and renders no colophon.
     */
    apexHref?: string | null;
    /**
     * Colophon text, supplied whole by the instance (e.g. "Läuft auf <Produkt>
     * — Produkt & Info"). Required companion to `apexHref`; with no label the
     * colophon stays hidden. The wording is instance-owned on purpose: the
     * kernel must not bake any product's name or marketing copy into markup.
     */
    apexLabel?: string | null;
  } = $props();

  const year = new Date().getFullYear();
</script>

<footer class="border-t border-border bg-surface">
  <div class="mx-auto max-w-7xl px-5 pb-10 pt-14">
    <div class="grid gap-9 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">

      <!-- Brand + blurb -->
      <div>
        <div class="flex items-center gap-3">
          <span
            class="relative grid h-9 w-9 place-items-center rounded-sm bg-ink font-display
                   text-[17px] font-bold text-paper"
          >
            S
            <span
              class="absolute -bottom-[3px] -right-[3px] h-[9px] w-[9px] rounded-[2px] bg-ember"
              aria-hidden="true"
            ></span>
          </span>
          <span class="leading-tight">
            <span class="block font-display text-[18px] font-semibold tracking-tight text-ink">
              {institutionName}
            </span>
            <span class="block font-mono text-[9.5px] tracking-[0.14em] text-ink-muted uppercase">
              Studierendenschaft · Körperschaft öR
            </span>
          </span>
        </div>
        <p class="mt-4 max-w-sm text-[13px] leading-relaxed text-ink-muted">
          Verfasste Studierendenschaft — gewählte Vertretung der Studierenden,
          öffentlich rechenschaftspflichtig nach dem Hochschulgesetz.
        </p>
      </div>

      <!-- Kontakt -->
      <div>
        <h2 class="mb-3.5 font-mono text-[10.5px] tracking-[0.14em] text-ink-muted uppercase">
          Kontakt
        </h2>
        <ul class="space-y-2 text-[14px] text-ink-2">
          <li><a class="transition-colors hover:text-ink" href="{base}/kontakt#impressum">Impressum &amp; Anschrift</a></li>
          <li><a class="transition-colors hover:text-ink" href="{base}/kontakt">Sprechzeiten</a></li>
        </ul>
      </div>

      <!-- Mitmachen -->
      <div>
        <h2 class="mb-3.5 font-mono text-[10.5px] tracking-[0.14em] text-ink-muted uppercase">
          Mitmachen
        </h2>
        <ul class="space-y-2 text-[14px] text-ink-2">
          <li><a class="transition-colors hover:text-ink" href="{base}/#protokolle">Protokolle</a></li>
          <li><a class="transition-colors hover:text-ink" href="{base}/#organisation">Gremien &amp; Referate</a></li>
        </ul>
      </div>

      <!-- Rechtliches -->
      <div>
        <h2 class="mb-3.5 font-mono text-[10.5px] tracking-[0.14em] text-ink-muted uppercase">
          Rechtliches
        </h2>
        <ul class="space-y-2 text-[14px] text-ink-2">
          <li><a class="transition-colors hover:text-ink" href="{base}/kontakt#impressum">Impressum</a></li>
          <li><a class="transition-colors hover:text-ink" href="{base}/kontakt#datenschutz">Datenschutz</a></li>
          <li><a class="transition-colors hover:text-ink" href="{base}/#protokolle">Beschlüsse &amp; Protokolle</a></li>
        </ul>
      </div>
    </div>

    <!-- Legal bottom bar -->
    <div
      class="mt-9 flex flex-col gap-2 border-t border-border pt-5 font-mono text-[11px]
             text-ink-muted sm:flex-row sm:items-center sm:justify-between"
    >
      <span>© {institutionName} · {year}</span>
      <span class="flex items-center gap-2">
        <span>Öffentliches Portal · ohne Login einsehbar</span>
        <span class="text-ink-faint" aria-hidden="true">·</span>
        <a class="transition-colors hover:text-ink" href={sourceUrl} target="_blank" rel="noopener noreferrer"
          >{SOURCE_OFFER_LABEL}</a
        >
      </span>
    </div>

    <!-- ── Colophon (v12) ──────────────────────────────────────────────────
         Back-route up to the site above the portal — the footer half of the
         apex strip. Mono type, muted until hover. Hidden unless the instance
         configured both a target and a label. -->
    {#if apexHref && apexLabel}
      <div class="mt-5 border-t border-border pt-5">
        <a
          href={apexHref}
          class="group inline-flex items-center gap-2 font-mono text-[11px]
                 tracking-[0.14em] text-ink-muted uppercase transition-colors
                 hover:text-ink focus-visible:text-ink"
        >
          <span>{apexLabel}</span>
          <span
            class="transition-transform duration-150 group-hover:translate-x-0.5"
            aria-hidden="true">→</span
          >
        </a>
      </div>
    {/if}
  </div>
</footer>
