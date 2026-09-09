<script lang="ts">
  import { base } from '$app/paths';
  import type { PageData } from './$types';
  import OrganisationTree from '$lib/components/OrganisationTree.svelte';

  let { data }: { data: PageData } = $props();

  function fmtMeetingDate(d: Date | string) {
    return new Date(d).toLocaleDateString('de-DE', {
      day: '2-digit', month: 'long', year: 'numeric',
    });
  }
</script>

<svelte:head>
  <title>Studierendenrat — Öffentliches Portal</title>
  <meta name="description" content="Protokolle, Beschlüsse und Gremien des Studierendenrats — öffentlich dokumentiert, ohne Login einsehbar." />
</svelte:head>

<!-- ── Hero ──────────────────────────────────────────────────────────────── -->
<!-- Editorial hero: headline + CTAs introducing the read-only governance
     portal (protocols, decisions, committee structure). -->
<section id="übersicht" class="border-b border-border bg-paper">
  <div class="mx-auto max-w-7xl px-5 py-16 lg:py-24">
    <div class="max-w-3xl">
      <span class="font-mono text-[11px] tracking-widest text-ink-muted uppercase">
        Öffentliche Selbstverwaltung
      </span>

      <h1
        class="mt-4 font-display text-5xl font-medium leading-[1.02] tracking-tight text-ink lg:text-6xl"
      >
        Selbstverwaltung zum <em class="not-italic text-ember">Mitlesen</em>.
      </h1>

      <p class="mt-6 max-w-md text-[18px] leading-relaxed text-ink-2">
        Protokolle und Beschlüsse der Gremien — öffentlich dokumentiert,
        ohne Login einsehbar.
      </p>

      <div class="mt-7 flex flex-wrap items-center gap-3">
        <a
          href="#protokolle"
          class="rounded-sm bg-ink px-[22px] py-3.5 text-[14px] font-medium text-paper
                 transition-opacity hover:opacity-85"
        >
          Protokolle ansehen →
        </a>
        <a
          href="#organisation"
          class="rounded-sm border border-border bg-surface px-[22px] py-3.5 text-[14px]
                 font-medium text-ink transition-colors hover:border-border-strong"
        >
          Organisation
        </a>
      </div>

      <!-- Stats row -->
      <dl class="mt-10 grid grid-cols-2 gap-6 sm:grid-cols-3">
        <div>
          <dt class="font-mono text-[10px] tracking-widest text-ink-muted uppercase">Protokolle</dt>
          <dd class="mt-1 font-display text-xl font-semibold text-ink">
            {data.latestProtocols.length > 0 ? data.latestProtocols.length + '+' : '—'}
          </dd>
        </div>
        <div>
          <dt class="font-mono text-[10px] tracking-widest text-ink-muted uppercase">Gremien</dt>
          <dd class="mt-1 font-display text-xl font-semibold text-ink">
            {data.committees.length > 0 ? data.committees.length + '+' : '—'}
          </dd>
        </div>
        <div>
          <dt class="font-mono text-[10px] tracking-widest text-ink-muted uppercase">Transparenz</dt>
          <dd class="mt-1 font-display text-xl font-semibold text-ember">100&thinsp;%</dd>
        </div>
      </dl>
    </div>
  </div>
</section>

<!-- ── Organisation ───────────────────────────────────────────────────────── -->
<OrganisationTree committees={data.committees} />

<!-- ── Protokolle ─────────────────────────────────────────────────────────── -->
<!-- Transparency cards: each published protocol/decision is its own editorial
     card linking to the full protocol view. -->
<section id="protokolle" class="border-b border-border">
  <div class="mx-auto max-w-7xl px-5 py-14 lg:py-[70px]">
    <div class="mb-12 grid items-end gap-10 lg:grid-cols-[1fr_1.5fr]">
      <div>
        <p class="mb-1 font-mono text-[11px] tracking-widest text-ink-muted uppercase">Transparenz</p>
        <h2 class="font-display text-4xl font-medium leading-tight tracking-tight text-ink">
          Jede Entscheidung, öffentlich nachlesbar.
        </h2>
      </div>
      <p class="max-w-xl text-[16px] text-ink-2">
        Beschlüsse und Sitzungsprotokolle der Gremien — veröffentlicht, sobald sie
        verabschiedet sind. Kein Login, keine Hürden.
      </p>
    </div>

    {#if data.latestProtocols.length === 0}
      <p class="text-ink-muted">Noch keine Protokolle veröffentlicht.</p>
    {:else}
      <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {#each data.latestProtocols as protocol (protocol.id)}
          <article
            class="group flex flex-col rounded-md border border-border bg-surface p-5 shadow-1
                   transition-shadow hover:shadow-2"
          >
            <div class="mb-3 flex items-center gap-2">
              <time
                datetime={new Date(protocol.meeting_date).toISOString()}
                class="font-mono text-[11px] tracking-widest text-ink-muted uppercase"
              >
                {fmtMeetingDate(protocol.meeting_date)}
              </time>
              <span class="text-ink-faint" aria-hidden="true">·</span>
              <span
                class="rounded-full bg-pine-soft px-2 py-0.5 font-mono text-[10px] font-medium
                       tracking-wider text-pine-ink uppercase"
              >
                {protocol.committee_name}
              </span>
            </div>

            <h3 class="font-display text-[18px] font-medium leading-snug tracking-tight text-ink">
              <a href={`${base}/protokolle/${protocol.id}`} class="transition-colors group-hover:text-accent">
                {protocol.title}
              </a>
            </h3>

            <div class="mt-4 flex items-center gap-4 pt-1">
              <a
                href={`${base}/protokolle/${protocol.id}`}
                class="font-mono text-[12px] font-medium tracking-wide text-accent uppercase
                       transition-colors hover:text-accent-ink"
              >
                Protokoll lesen →
              </a>
              <!-- `pdf_url` arrives from the DB as a root-relative path
                   (`/api/public/protocols/<id>/pdf`, built in public-db.ts), so
                   it needs the same `base` prefix as any other internal link. -->
              {#if protocol.pdf_url}
                <a
                  href={`${base}${protocol.pdf_url}`}
                  class="font-mono text-[12px] tracking-wide text-ink-muted uppercase
                         transition-colors hover:text-ink"
                >
                  PDF
                </a>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}

    <div class="mt-10">
      <a
        href="{base}/protokolle"
        class="font-mono text-[12px] tracking-wide text-ink-muted uppercase
               transition-colors hover:text-accent"
      >
        Alle Protokolle →
      </a>
    </div>
  </div>
</section>

<!-- ── Antrag (optional, no login) ────────────────────────────────────────── -->
<!-- v5 Task 4.8 — public Antragsformular (prototype #antrag). No login: the form
     is submitted to the StuRa inbox via mailto (no public write-back endpoint
     exists). Optional via PUBLIC_PORTAL_ANTRAG. -->
{#if data.showAntrag}
  <section id="antrag" class="border-b border-border">
    <div class="mx-auto max-w-7xl px-5 py-14">
      <div class="mb-10 grid items-end gap-10 lg:grid-cols-[1fr_1.5fr]">
        <div>
          <p class="mb-1 font-mono text-[11px] tracking-widest text-ink-muted uppercase">§ Mitmachen</p>
          <h2 class="font-display text-4xl font-medium leading-tight tracking-tight text-ink">
            Dein Anliegen auf die Tagesordnung.
          </h2>
        </div>
        <p class="max-w-xl text-[16px] text-ink-2">
          Jede:r Studierende darf Anträge stellen — vom Kulturfest-Vorschlag bis zur
          Satzungsänderung. Kein Login nötig, nur eine Hochschul-Mail zur Identifikation.
        </p>
      </div>

      <div class="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
        <!-- Steps -->
        <ol class="space-y-5">
          {#each [
            { n: '01', t: 'Formular ausfüllen', s: 'Titel, Anliegen, gewünschter Beschluss. Anlagen optional.' },
            { n: '02', t: 'Bestätigung per Hochschul-Mail', s: 'Du erhältst eine Vorgangsnummer und kannst den Status mitverfolgen.' },
            { n: '03', t: 'Erste Behandlung im Präsidium', s: 'Meist innerhalb von 7 Tagen. Bei Finanzen zusätzlich im Haushaltsausschuss.' },
            { n: '04', t: 'Plenum entscheidet — öffentlich', s: 'Du bist eingeladen, dein Anliegen selbst vorzutragen.' },
          ] as step (step.n)}
            <li class="flex gap-4">
              <span class="font-mono text-[13px] font-semibold text-ember">{step.n}</span>
              <div>
                <div class="font-display text-[15px] font-semibold text-ink">{step.t}</div>
                <div class="mt-0.5 text-[13px] text-ink-2">{step.s}</div>
              </div>
            </li>
          {/each}
        </ol>

        <!-- Form (mailto submit — no public write-back endpoint) -->
        <form
          class="rounded-md border border-ink-subtle bg-surface p-6"
          action="mailto:{data.contactEmail ?? 'kontakt@stura.example.edu'}"
          method="post"
          enctype="text/plain"
        >
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="block">
              <span class="font-mono text-[10px] tracking-widest text-ink-muted uppercase">Dein Name</span>
              <input
                name="Name"
                class="mt-1.5 w-full rounded-sm border border-ink-subtle bg-paper px-3 py-2.5 text-[14px] text-ink
                       focus:border-ember focus:outline-hidden"
                placeholder="Vor- und Nachname"
              />
            </label>
            <label class="block">
              <span class="font-mono text-[10px] tracking-widest text-ink-muted uppercase">Hochschul-Mail</span>
              <input
                name="Mail"
                type="email"
                class="mt-1.5 w-full rounded-sm border border-ink-subtle bg-paper px-3 py-2.5 text-[14px] text-ink
                       focus:border-ember focus:outline-hidden"
                placeholder="max.muster@example.edu"
              />
            </label>
          </div>
          <label class="mt-4 block">
            <span class="font-mono text-[10px] tracking-widest text-ink-muted uppercase">Art des Anliegens</span>
            <select
              name="Art"
              class="mt-1.5 w-full rounded-sm border border-ink-subtle bg-paper px-3 py-2.5 text-[14px] text-ink
                     focus:border-ember focus:outline-hidden"
            >
              <option>Sachantrag</option>
              <option>Finanzantrag</option>
              <option>Frage / Beschwerde</option>
              <option>Idee / Anregung</option>
            </select>
          </label>
          <label class="mt-4 block">
            <span class="font-mono text-[10px] tracking-widest text-ink-muted uppercase">Titel</span>
            <input
              name="Titel"
              class="mt-1.5 w-full rounded-sm border border-ink-subtle bg-paper px-3 py-2.5 text-[14px] text-ink
                     focus:border-ember focus:outline-hidden"
              placeholder="Kurz und prägnant"
            />
          </label>
          <label class="mt-4 block">
            <span class="font-mono text-[10px] tracking-widest text-ink-muted uppercase">Anliegen</span>
            <textarea
              name="Anliegen"
              rows="4"
              class="mt-1.5 w-full rounded-sm border border-ink-subtle bg-paper px-3 py-2.5 text-[14px] text-ink
                     focus:border-ember focus:outline-hidden"
              placeholder="Worum geht es? Was soll das Plenum beschließen?"
            ></textarea>
          </label>
          <div class="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p class="font-mono text-[11px] text-ink-muted">Wird per E-Mail an den StuRa übermittelt.</p>
            <button
              type="submit"
              class="rounded-sm bg-ink px-5 py-2.5 text-[14px] font-medium text-paper transition-opacity hover:opacity-85"
            >
              Absenden →
            </button>
          </div>
        </form>
      </div>
    </div>
  </section>
{/if}

<!-- ── Kontakt ────────────────────────────────────────────────────────────── -->
<section id="kontakt" class="bg-surface">
  <div class="mx-auto max-w-7xl px-5 py-12">
    <div class="mb-8 border-b border-ink-subtle pb-4">
      <p class="mb-1 font-mono text-[10px] tracking-widest text-ink-muted uppercase">Kontakt & Rechtliches</p>
      <h2 class="font-display text-3xl font-bold text-ink">Kontakt</h2>
    </div>
    <div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      <div class="rounded-md border border-ink-subtle bg-paper p-5">
        <p class="font-mono text-[10px] tracking-widest text-ink-muted uppercase">Impressum</p>
        <p class="mt-3 text-[14px] leading-relaxed text-ink-2">
          Verantwortlich: Vorsitz des Studierendenrats
        </p>
      </div>
      <div class="rounded-md border border-ink-subtle bg-paper p-5">
        <p class="font-mono text-[10px] tracking-widest text-ink-muted uppercase">Datenschutz</p>
        <p class="mt-3 text-[14px] leading-relaxed text-ink-2">
          Dieses Portal erfordert keinen Login und verarbeitet keine personenbezogenen Daten.
        </p>
      </div>
      <div class="rounded-md border border-ink-subtle bg-paper p-5">
        <p class="font-mono text-[10px] tracking-widest text-ink-muted uppercase">Barrierefreiheit</p>
        <p class="mt-3 text-[14px] leading-relaxed text-ink-2">
          Dieses Portal strebt WCAG 2.1 Level AA an.
        </p>
      </div>
    </div>
  </div>
</section>
