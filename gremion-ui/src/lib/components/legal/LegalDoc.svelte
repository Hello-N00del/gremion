<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  // Shared v4 layout for the public legal pages (/legal/impressum,
  // /legal/datenschutz + /legal/barrierefreiheit). Renders the
  // it-admin-configured HTML
  // (config.legal.<doc>_html, edited via Settings → Rechtliches) inside the v4
  // legal-doc card, with a tab row linking the two statutory pages. Empty config
  // → a first-class "noch nicht hinterlegt" state.
  //
  // {@html} renders it-admin-authored markup (TabLegal is it-admin-gated) — the
  // same trust model as any CMS rich-text field; no untrusted input reaches it.
  import Icon from '$lib/components/ui/Icon.svelte'

  interface Props {
    title: string
    sub: string
    html: string
    active: 'impressum' | 'datenschutz' | 'barrierefreiheit'
  }
  let { title, sub, html, active }: Props = $props()

  const TABS = [
    { key: 'impressum', label: 'Impressum', href: '/legal/impressum' },
    { key: 'datenschutz', label: 'Datenschutzerklärung', href: '/legal/datenschutz' },
    { key: 'barrierefreiheit', label: 'Barrierefreiheit', href: '/legal/barrierefreiheit' },
  ] as const

  const hasContent = $derived(html.trim().length > 0)
</script>

<PageTitle title={title} />

<div class="legal-page">
  <header class="page-head">
    <div class="eyebrow">Rechtliches</div>
    <h1 class="display legal-title">{title}</h1>
    <p class="page-sub">{sub}</p>
  </header>

  <nav class="legal-tabs" aria-label="Rechtliche Seiten">
    {#each TABS as t (t.key)}
      <a href={t.href} class="legal-tab" class:on={t.key === active} aria-current={t.key === active ? 'page' : undefined}>
        {t.label}
      </a>
    {/each}
  </nav>

  {#if hasContent}
    <!-- v5 Task 4.7 — the shipped default copy (and any draft an admin has not
         yet had legally vetted) carries this notice, matching the prototype's
         "Entwurfsfassung — vor Veröffentlichung juristisch zu prüfen." strip. -->
    <div class="legal-notice">
      <Icon name="info" size={15} />
      <span>Entwurfsfassung — vor Veröffentlichung juristisch zu prüfen.</span>
    </div>
    <div class="card card-pad legal-doc">
      <!-- eslint-disable-next-line svelte/no-at-html-tags — it-admin-authored config HTML -->
      {@html html}
    </div>
  {:else}
    <div class="empty-state">
      <div class="glyph"><Icon name="file-text" size={22} /></div>
      <div class="ttl">Noch nicht hinterlegt</div>
      <div class="sub">
        Diese Seite wird unter <strong>Einstellungen → Rechtliches</strong> gepflegt.
        Sobald der Text dort eingetragen ist, erscheint er hier.
      </div>
    </div>
  {/if}
</div>

<style>
  .legal-page {
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
  }
  .page-head {
    margin-bottom: 16px;
  }
  .legal-title {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-top: 4px;
  }
  .page-sub {
    color: var(--ink-muted);
    font-size: 13.5px;
    margin-top: 6px;
  }

  .legal-tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 18px;
  }
  .legal-tab {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 500;
    color: var(--ink-muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    transition: color var(--d-fast), border-color var(--d-fast);
  }
  .legal-tab:hover {
    color: var(--ink);
  }
  .legal-tab.on {
    color: var(--ink);
    border-bottom-color: var(--accent);
  }

  .legal-notice {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    padding: 10px 14px;
    background: var(--ember-soft, var(--surface-2));
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-size: 12.5px;
    color: var(--ink-2);
  }

  /* legal-doc: the rendered statutory HTML. Scoped typographic defaults for the
     admin-authored markup (headings / paragraphs / lists). */
  .legal-doc :global(h2),
  .legal-doc :global(h3) {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 600;
    margin: 18px 0 6px;
  }
  .legal-doc :global(h2:first-child),
  .legal-doc :global(h3:first-child) {
    margin-top: 0;
  }
  .legal-doc :global(p),
  .legal-doc :global(li) {
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--ink-2);
    margin: 4px 0;
  }
  .legal-doc :global(ul),
  .legal-doc :global(ol) {
    padding-left: 20px;
    margin: 6px 0;
  }
  .legal-doc :global(a) {
    color: var(--accent-ink);
    text-decoration: none;
  }
  .legal-doc :global(a:hover) {
    text-decoration: underline;
  }
</style>
