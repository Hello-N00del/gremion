<script lang="ts">
  import { createEventDispatcher } from 'svelte'

  export let org: { name: string; domain: string; logo_path: string | null }
  // P2.1c (D-WIZARD/D2): the deployment-mode toggle. Pre-selected from the
  // persisted config (default 'single'). 'single' = one organisation;
  // 'multi' = this deployment hosts multiple tenants (provisioning a second
  // tenant stays an operator command — this only unlocks the gate).
  export let deploymentMode: 'single' | 'multi' = 'single'

  const dispatch = createEventDispatcher<{ advance: void; back: void }>()

  let name = org.name ?? ''
  let domain = org.domain ?? ''
  let mode: 'single' | 'multi' = deploymentMode
  // v5 Task 4.5 — Haushaltsjahr is forward-shape (no dedicated config field
  // yet), so it is collected but not yet persisted — surfaced now so the
  // wizard matches the v5 Stammdaten step. (The Bundesland field that used to
  // live alongside it was removed: the governance-only kernel carries no
  // calendar module, and german_state has no home in gremionConfigSchema — see
  // audit #425.)
  let haushaltsjahr = String(new Date().getFullYear())

  let saving = false
  let error = ''

  // Basic domain validation (no protocol, no trailing slash)
  function validateDomain(val: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(val)
  }

  function onSubmit(e: SubmitEvent) {
    e.preventDefault()
    void advance()
  }

  async function advance() {
    if (!name.trim()) { error = 'Name ist erforderlich.'; return }
    if (!validateDomain(domain)) { error = 'Bitte eine gültige Domain eingeben (z.B. stura.example.de).'; return }
    if (!/^\d{4}$/.test(haushaltsjahr)) { error = 'Bitte ein vierstelliges Haushaltsjahr eingeben.'; return }
    error = ''
    saving = true
    try {
      const res = await fetch('/api/setup/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org: { name: name.trim(), domain: domain.trim(), logo_path: null },
          // P2.1c (D-WIZARD/D2): persist the deployment-mode choice.
          deployment: { mode },
          wizard_steps: { org_info: 'complete' },
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
  <div class="eyebrow">Schritt 2 von 5 · Stammdaten</div>
  <h2 class="step-title">Studierendenschaft-Stammdaten</h2>
  <p class="step-sub">Name, Domain und die rechtlichen Rahmendaten eures Studierendenrats.</p>

  <form class="step-form" onsubmit={onSubmit}>
    <div class="field-grid">
      <div class="field field-wide">
        <label class="eyebrow" for="org-name">Name der Verfassten Studierendenschaft *</label>
        <input
          id="org-name"
          class="input"
          bind:value={name}
          placeholder="Studierendenrat der Musteruniversität"
          required
          maxlength={200}
          aria-required="true"
        />
      </div>

      <div class="field">
        <label class="eyebrow" for="org-domain">Kürzel · Domain *</label>
        <input
          id="org-domain"
          class="input mono"
          bind:value={domain}
          placeholder="stura.example.de"
          required
          maxlength={253}
          aria-required="true"
          aria-describedby="org-domain-hint"
        />
        <p id="org-domain-hint" class="field-hint">Nur die Domain, ohne https:// (z.B. stura.example.de)</p>
      </div>

      <div class="field">
        <label class="eyebrow" for="org-hhj">Haushaltsjahr</label>
        <input
          id="org-hhj"
          class="input mono"
          bind:value={haushaltsjahr}
          inputmode="numeric"
          maxlength={4}
          placeholder="2026"
        />
      </div>
    </div>

    <fieldset class="mode-fieldset">
      <legend class="eyebrow">Betriebsmodus</legend>
      <label class="mode-option" class:selected={mode === 'single'}>
        <input type="radio" name="deployment-mode" value="single" bind:group={mode} />
        <span class="mode-text">
          <span class="mode-title">Einzelbetrieb</span>
          <span class="mode-desc">Diese Installation betreibt eine einzige Organisation.</span>
        </span>
      </label>
      <label class="mode-option" class:selected={mode === 'multi'}>
        <input type="radio" name="deployment-mode" value="multi" bind:group={mode} />
        <span class="mode-text">
          <span class="mode-title">Mehrmandantenbetrieb</span>
          <span class="mode-desc">Diese Installation hostet mehrere Mandanten.</span>
        </span>
      </label>
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
  .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .field-wide { grid-column: 1 / -1; }
  .field-hint { font-size: 11.5px; color: var(--ink-muted); margin-top: 2px; }

  .input {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-sm, 6px);
    background: var(--surface);
    color: var(--ink);
    font-size: 14px;
    font-family: inherit;
  }
  .input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft, transparent);
  }
  .input.mono { font-family: var(--font-mono); }

  .mode-fieldset {
    display: flex;
    flex-direction: column;
    gap: 8px;
    border: none;
    padding: 0;
    margin: 0;
    min-width: 0;
  }
  .mode-fieldset legend { margin-bottom: 6px; }
  .mode-option {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--r-sm, 6px);
    background: var(--surface);
    cursor: pointer;
  }
  .mode-option.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft, transparent);
  }
  .mode-option input { margin-top: 3px; }
  .mode-text { display: flex; flex-direction: column; gap: 2px; }
  .mode-title { font-size: 14px; font-weight: 500; color: var(--ink); }
  .mode-desc { font-size: 12.5px; color: var(--ink-muted); }

  .step-error { color: var(--rust); font-size: 13px; }

  .step-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
</style>
