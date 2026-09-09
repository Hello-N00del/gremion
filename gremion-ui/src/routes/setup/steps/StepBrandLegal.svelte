<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { TENANT_PALETTES } from '$lib/theme/instance-theme'

  // t291-setup-brand-legal — combined Marke (brand) + Rechtstexte (legal) step.
  // Brand: a product name + a CURATED accent palette (HANDOVER-v8 Part E LOCKED
  // decision — a designed, AA-coherent hue per instance, NOT a free-form hex
  // field). Legal: the three statutory texts, each flagged with a
  // Platzhalter/Entwurf badge while it still carries the per-tenant placeholder
  // marker (the un-edited neutral default copy).
  export let brand: { product: string; palette: string | null }
  export let legal: {
    datenschutz_html: string
    impressum_html: string
    barrierefreiheit_html: string
  }

  const dispatch = createEventDispatcher<{
    advance: void
    back: void
    // Emitted whenever the operator edits a field so the wizard shell can
    // recompute the go-live gate live (mirrors the server isGoLiveReady).
    golivechange: { ready: boolean }
  }>()

  // The per-tenant placeholder sentinel. CANONICAL source is the server-only
  // $lib/server/config PLACEHOLDER_MARKER (which the pure isGoLiveReady predicate
  // and its test share); duplicated here as a plain literal only because a
  // server module (it imports `fs`) can't be bundled into this client component.
  // It is an HTML-comment sentinel, not a secret. The authoritative gate is the
  // server-computed goLiveReady; this client mirror only drives live UX feedback.
  const PLACEHOLDER_MARKER = '<!-- per-tenant: set via config -->'

  // Curated accent palette options. `null` = the default navy originator
  // rendering (no injection — app.css tokens). The rest are the locked
  // curated palette ids (gremion#22: brand.palette is id-only — no free-form
  // colour picker).
  const PALETTE_OPTIONS: ReadonlyArray<{ id: string | null; label: string; hue: string }> = [
    { id: null, label: 'Standard', hue: 'Navy' },
    ...Object.entries(TENANT_PALETTES).map(([id, p]) => ({ id, label: p.hue, hue: p.hue })),
  ]

  let product = brand.product ?? ''
  let palette: string | null = brand.palette ?? null
  let datenschutz = legal.datenschutz_html ?? ''
  let impressum = legal.impressum_html ?? ''
  let barrierefreiheit = legal.barrierefreiheit_html ?? ''

  let saving = false
  let error = ''

  function isPlaceholder(html: string): boolean {
    return html.includes(PLACEHOLDER_MARKER)
  }

  // Live mirror of the server isGoLiveReady predicate: product set AND all three
  // legal texts past the placeholder.
  $: ready =
    product.trim().length > 0 &&
    !isPlaceholder(datenschutz) &&
    !isPlaceholder(impressum) &&
    !isPlaceholder(barrierefreiheit)

  // Surface readiness to the wizard shell on every change.
  $: dispatch('golivechange', { ready })

  function onSubmit(e: SubmitEvent) {
    e.preventDefault()
    void save()
  }

  async function save() {
    if (!product.trim()) {
      error = 'Ein Produktname (Marke) ist erforderlich.'
      return
    }
    error = ''
    saving = true
    try {
      const res = await fetch('/api/setup/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brand: { product: product.trim(), palette },
          legal: {
            datenschutz_html: datenschutz,
            impressum_html: impressum,
            barrierefreiheit_html: barrierefreiheit,
          },
        }),
      })
      if (!res.ok) {
        const body = await res.json()
        error = body.error ?? 'Fehler beim Speichern.'
        return
      }
      dispatch('advance')
    } catch {
      error = 'Verbindungsfehler.'
    } finally {
      saving = false
    }
  }
</script>

<div class="setup-step">
  <div class="eyebrow">Marke &amp; Rechtstexte</div>
  <h2 class="step-title">Marke und Rechtstexte</h2>
  <p class="step-sub">
    Produktname, Akzentfarbe und die drei Pflicht-Rechtstexte. Die Rechtstexte
    sind bis zur Bearbeitung als Entwurf gekennzeichnet.
  </p>

  <form class="step-form" onsubmit={onSubmit}>
    <fieldset class="block">
      <legend class="eyebrow">Marke</legend>

      <div class="field field-wide">
        <label class="eyebrow" for="brand-product">Produktname *</label>
        <input
          id="brand-product"
          class="input"
          bind:value={product}
          placeholder="z. B. Musterstadt"
          required
          maxlength={120}
          aria-required="true"
        />
        <p class="field-hint">Erscheint im Seitentitel und in der Kopfzeile.</p>
      </div>

      <div class="field field-wide">
        <span class="eyebrow" id="accent-label">Akzentfarbe</span>
        <div class="accent-grid" role="radiogroup" aria-labelledby="accent-label">
          {#each PALETTE_OPTIONS as opt (opt.id ?? 'default')}
            <label class="accent-option" class:selected={palette === opt.id}>
              <input
                type="radio"
                name="brand-palette"
                value={opt.id}
                checked={palette === opt.id}
                onchange={() => (palette = opt.id)}
              />
              <span class="accent-text">{opt.label}</span>
            </label>
          {/each}
        </div>
        <p class="field-hint">
          Kuratierte, kontrastsichere Palette (keine freie Farbwahl).
        </p>
      </div>
    </fieldset>

    <fieldset class="block">
      <legend class="eyebrow">Rechtstexte</legend>

      <div class="field field-wide">
        <div class="legal-head">
          <label class="eyebrow" for="legal-impressum">Impressum</label>
          {#if isPlaceholder(impressum)}
            <span class="badge badge-draft">Platzhalter / Entwurf</span>
          {:else}
            <span class="badge badge-set">Hinterlegt</span>
          {/if}
        </div>
        <textarea id="legal-impressum" class="textarea mono" rows="4" bind:value={impressum}></textarea>
      </div>

      <div class="field field-wide">
        <div class="legal-head">
          <label class="eyebrow" for="legal-datenschutz">Datenschutzerklärung</label>
          {#if isPlaceholder(datenschutz)}
            <span class="badge badge-draft">Platzhalter / Entwurf</span>
          {:else}
            <span class="badge badge-set">Hinterlegt</span>
          {/if}
        </div>
        <textarea id="legal-datenschutz" class="textarea mono" rows="4" bind:value={datenschutz}></textarea>
      </div>

      <div class="field field-wide">
        <div class="legal-head">
          <label class="eyebrow" for="legal-barrierefreiheit">Erklärung zur Barrierefreiheit</label>
          {#if isPlaceholder(barrierefreiheit)}
            <span class="badge badge-draft">Platzhalter / Entwurf</span>
          {:else}
            <span class="badge badge-set">Hinterlegt</span>
          {/if}
        </div>
        <textarea id="legal-barrierefreiheit" class="textarea mono" rows="4" bind:value={barrierefreiheit}></textarea>
      </div>

      <div class="notice-strip" class:notice-ok={ready} role="note">
        {#if ready}
          <span>Marke und alle drei Rechtstexte sind hinterlegt — der Abschluss ist freigeschaltet.</span>
        {:else}
          <span>Solange ein Rechtstext als Entwurf markiert ist oder die Marke fehlt, bleibt der Abschluss gesperrt.</span>
        {/if}
      </div>
    </fieldset>

    {#if error}
      <p class="step-error" role="alert">{error}</p>
    {/if}

    <div class="step-actions">
      <button type="button" class="btn" onclick={() => dispatch('back')}>Zurück</button>
      <button type="submit" class="btn btn-primary" disabled={saving}>
        {saving ? 'Speichere…' : 'Weiter'}
      </button>
    </div>
  </form>
</div>

<style>
  .step-title {
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin-top: 6px;
  }
  .step-sub { color: var(--ink-muted); font-size: 13.5px; margin-top: 4px; }

  .step-form { margin-top: 20px; display: flex; flex-direction: column; gap: 18px; }

  .block {
    display: flex;
    flex-direction: column;
    gap: 14px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm, 6px);
    padding: 14px 16px;
    margin: 0;
    min-width: 0;
  }
  .block legend { padding: 0 4px; }

  .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .field-wide { width: 100%; }
  .field-hint { font-size: 11.5px; color: var(--ink-muted); margin-top: 2px; }

  .input, .textarea {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-sm, 6px);
    background: var(--surface);
    color: var(--ink);
    font-size: 14px;
    font-family: inherit;
  }
  .input:focus, .textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft, transparent);
  }
  .textarea { resize: vertical; }
  .mono { font-family: var(--font-mono); }

  .accent-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .accent-option {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-sm, 6px);
    background: var(--surface);
    cursor: pointer;
    font-size: 13px;
    color: var(--ink);
  }
  .accent-option.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft, transparent);
  }

  .legal-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    line-height: 1.6;
  }
  .badge-draft {
    color: var(--amber-ink, #92400e);
    background: var(--amber-soft, #fef3c7);
    border: 1px solid var(--amber-border, #fde68a);
  }
  .badge-set {
    color: var(--green-ink, #166534);
    background: var(--green-soft, #dcfce7);
    border: 1px solid var(--green-border, #bbf7d0);
  }

  .notice-strip {
    display: flex;
    gap: 8px;
    padding: 10px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm, 6px);
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .notice-ok {
    border-color: var(--green-border, #bbf7d0);
    background: var(--green-soft, #dcfce7);
    color: var(--green-ink, #166534);
  }

  .step-error { color: var(--rust); font-size: 13px; }

  .step-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
</style>
