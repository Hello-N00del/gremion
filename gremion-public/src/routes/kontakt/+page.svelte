<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Kontakt — Studierendenrat</title>
  <meta name="description" content="Kontaktdaten, Impressum und Datenschutz des Studierendenrats." />
</svelte:head>

<!-- Page header -->
<div class="border-b border-ink-subtle bg-surface">
  <div class="mx-auto max-w-7xl px-5 py-10">
    <p class="mb-2 font-mono text-[10px] tracking-widest text-ink-muted uppercase">Kontakt & Rechtliches</p>
    <h1 class="font-display text-4xl font-bold text-ink">Kontakt</h1>
  </div>
</div>

<div class="mx-auto max-w-7xl px-5 py-10">
  <div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3">

    <!-- Contact details -->
    <section id="kontakt" aria-labelledby="kontakt-heading" class="rounded-md border border-ink-subtle bg-surface p-6">
      <h2 id="kontakt-heading" class="mb-4 font-mono text-[10px] tracking-widest text-ink-muted uppercase">
        Kontaktdaten
      </h2>
      <dl class="space-y-4 text-[14px]">
        {#if data.email}
          <div>
            <dt class="font-mono text-[10px] tracking-wider text-ink-muted uppercase">E-Mail</dt>
            <dd class="mt-1">
              <a href="mailto:{data.email}" class="text-[var(--ember)] hover:opacity-75 transition-opacity">
                {data.email}
              </a>
            </dd>
          </div>
        {/if}
        {#if data.address}
          <div>
            <dt class="font-mono text-[10px] tracking-wider text-ink-muted uppercase">Adresse</dt>
            <dd class="mt-1 whitespace-pre-line text-ink-2">{data.address}</dd>
          </div>
        {/if}
        {#if data.officeHours}
          <div>
            <dt class="font-mono text-[10px] tracking-wider text-ink-muted uppercase">Sprechzeiten</dt>
            <dd class="mt-1 whitespace-pre-line text-ink-2">{data.officeHours}</dd>
          </div>
        {/if}
        {#if !data.email && !data.address && !data.officeHours}
          <p class="text-ink-muted">Kontaktdaten werden in Kürze veröffentlicht.</p>
        {/if}
      </dl>
    </section>

    <!-- Imprint -->
    <section id="impressum" aria-labelledby="impressum-heading" class="rounded-md border border-ink-subtle bg-surface p-6">
      <h2 id="impressum-heading" class="mb-4 font-mono text-[10px] tracking-widest text-ink-muted uppercase">
        Impressum
      </h2>
      <dl class="space-y-4 text-[14px]">
        {#if data.imprintResponsible}
          <div>
            <dt class="font-mono text-[10px] tracking-wider text-ink-muted uppercase">Verantwortlich</dt>
            <dd class="mt-1 whitespace-pre-line text-ink-2">{data.imprintResponsible}</dd>
          </div>
        {/if}
        <div>
          <dt class="font-mono text-[10px] tracking-wider text-ink-muted uppercase">Hinweis</dt>
          <dd class="mt-1 leading-relaxed text-ink-muted">
            Diese Website ist ein öffentliches Informationsportal des Studierendenrats.
          </dd>
        </div>
      </dl>
    </section>

    <!-- Accessibility + Easy Language -->
    <section class="rounded-md border border-ink-subtle bg-surface p-6">
      <h2 class="mb-4 font-mono text-[10px] tracking-widest text-ink-muted uppercase">
        Barrierefreiheit
      </h2>
      <div class="space-y-4 text-[14px]">
        <div id="barrierefreiheit">
          <p class="font-mono text-[10px] tracking-wider text-ink-muted uppercase">Erklärung</p>
          <p class="mt-1 leading-relaxed text-ink-muted">
            Dieses Portal strebt WCAG 2.1 Level AA an. Bei Problemen wenden Sie sich an uns.
          </p>
        </div>
        <div id="leichte-sprache">
          <p class="font-mono text-[10px] tracking-wider text-ink-muted uppercase">Leichte Sprache</p>
          <p class="mt-1 leading-relaxed text-ink-muted">
            Inhalte in leichter Sprache befinden sich im Aufbau.
          </p>
        </div>
      </div>
    </section>

  </div>

  <!-- Privacy section -->
  <section id="datenschutz" class="mt-8 rounded-md border border-ink-subtle bg-surface p-6">
    <h2 class="mb-4 font-mono text-[10px] tracking-widest text-ink-muted uppercase">Datenschutz</h2>
    <p class="max-w-prose text-[14px] leading-relaxed text-ink-muted">
      Für die Verarbeitung personenbezogener Daten gilt die Datenschutzerklärung der Hochschule.
      Dieses Portal verarbeitet keine personenbezogenen Daten ohne Einwilligung und erfordert keinen Login.
    </p>
  </section>
</div>
