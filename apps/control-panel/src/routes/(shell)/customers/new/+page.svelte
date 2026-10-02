<script lang="ts">
  import { Button } from 'bits-ui'
  import type { ActionData, PageData } from './$types'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  const MODULES = [
    { id: 'calendar', label: 'Kalender' },
    { id: 'content', label: 'Inhalte' },
    { id: 'publishing', label: 'Newsletter' },
    { id: 'finance', label: 'Finanzen' },
  ]
  const disabled = $derived(data.disabled ?? form?.disabled ?? null)
  const errors = $derived((form?.errors ?? {}) as Record<string, string>)
  const values = $derived((form?.values ?? {}) as Record<string, unknown>)
  // a failed submit keeps the chosen modules (a resubmit must not drop them)
  const checkedModules = $derived(Array.isArray(values.enable) ? (values.enable as unknown[]).map(String) : [])
</script>

<svelte:head><title>Neuer Mandant · Gremion Betrieb</title></svelte:head>

<h1>Neuer Mandant</h1>

{#if disabled}
  <p class="notice warn" role="status">Deaktiviert: {disabled}</p>
{/if}
{#if errors.form}
  <p class="notice warn" role="alert">{errors.form}</p>
{/if}

<form method="POST" aria-describedby={disabled ? undefined : 'hint'}>
  <fieldset disabled={disabled !== null}>
    <label>
      Kurzname
      <input name="slug" required autocomplete="off" value={String(values.slug ?? '')} aria-invalid={errors.slug ? 'true' : undefined} />
      {#if errors.slug}<span class="err">{errors.slug}</span>{/if}
    </label>
    <label>
      Host
      <input name="host" required autocomplete="off" placeholder="rat.musterstadt.de" value={String(values.host ?? '')} aria-invalid={errors.host ? 'true' : undefined} />
      {#if errors.host}<span class="err">{errors.host}</span>{/if}
    </label>
    <label>
      IT-Administration (E-Mail)
      <input name="itAdmin" type="email" required value={String(values.itAdmin ?? '')} aria-invalid={errors.itAdmin ? 'true' : undefined} />
      {#if errors.itAdmin}<span class="err">{errors.itAdmin}</span>{/if}
    </label>
    <label>
      Gremienverwaltung (E-Mail)
      <input name="councilAdmin" type="email" required value={String(values.councilAdmin ?? '')} aria-invalid={errors.councilAdmin ? 'true' : undefined} />
      {#if errors.councilAdmin}<span class="err">{errors.councilAdmin}</span>{/if}
    </label>
    <label>
      Mandantenkonfiguration (Pfad auf dem Host)
      <input name="configFile" required placeholder="/opt/gremion/etc/tenants/musterstadt.json" value={String(values.configFile ?? '')} aria-invalid={errors.configFile ? 'true' : undefined} />
      {#if errors.configFile}<span class="err">{errors.configFile}</span>{/if}
    </label>
    <fieldset class="modules">
      <legend>Module (keine sind voreingestellt)</legend>
      {#each MODULES as m (m.id)}
        <label class="check"><input type="checkbox" name="enable" value={m.id} checked={checkedModules.includes(m.id)} /> {m.label} <code>{m.id}</code></label>
      {/each}
      <p class="muted">„board“ ist noch nicht mandantengetrennt, „vault“ (Tresor) bleibt im Pilotbetrieb abgeschaltet: beide sind nicht wählbar.</p>
      {#if errors.enable}<span class="err">{errors.enable}</span>{/if}
    </fieldset>
    <p id="hint" class="muted">
      Der Panel legt nichts selbst an: es startet <code>gremion-tenant create</code>, das den Mandanten registriert und Schritt für Schritt einrichtet.
    </p>
    <Button.Root type="submit" disabled={disabled !== null}>Mandant anlegen</Button.Root>
  </fieldset>
</form>

<style>
  h1 {
    font-size: 1.4rem;
    margin: 1.5rem 0 1rem;
  }
  form {
    max-width: 36rem;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 1rem;
  }
  fieldset.modules {
    border: 1px solid var(--line);
    padding: 0.75rem 1rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
  }
  label.check {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  input:not([type='checkbox']) {
    font: inherit;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--line);
    background: transparent;
    color: var(--fg);
  }
  .err {
    color: var(--bad);
    font-size: 0.9rem;
  }
  .muted {
    color: var(--muted);
  }
  .notice.warn {
    border: 1px solid var(--line);
    padding: 0.75rem 1rem;
    color: var(--warn);
  }
  :global([data-button-root]) {
    justify-self: start;
    font: inherit;
    padding: 0.5rem 1rem;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--bg);
    cursor: pointer;
  }
  :global([data-button-root][disabled]) {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
