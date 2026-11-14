<script lang="ts">
  import { Button } from 'bits-ui'
  import type { ActionData, PageData } from './$types'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  const disabled = $derived(data.disabled ?? form?.disabled ?? null)
  const errors = $derived((form?.errors ?? {}) as Record<string, string>)
  const values = $derived((form?.values ?? {}) as Record<string, unknown>)
  // a failed submit keeps the chosen modules (a resubmit must not drop them)
  const checkedModules = $derived(Array.isArray(values.enable) ? (values.enable as unknown[]).map(String) : [])
  const dpiaValues = $derived((values.dpia ?? {}) as Record<string, { requiresDpia?: boolean | null; documentRef?: string }>)
  const key = $derived(String(form?.key || data.key))
  // the semester start months: October and April unless a failed submit kept the operator's choice
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
  const winterMonth = $derived(Number.isInteger(values.termWinterMonth) ? Number(values.termWinterMonth) : 10)
  const summerMonth = $derived(Number.isInteger(values.termSummerMonth) ? Number(values.termSummerMonth) : 4)
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
  <input type="hidden" name="key" value={key} />
  <fieldset disabled={disabled !== null}>
    <label>
      Kurzname
      <input name="slug" required autocomplete="off" value={String(values.slug ?? '')} aria-invalid={errors.slug ? 'true' : undefined} />
      {#if errors.slug}<span class="err">{errors.slug}</span>{/if}
    </label>
    <label>
      Kurzname noch einmal eingeben
      <input name="confirmSlug" required autocomplete="off" value={String(values.confirmSlug ?? '')} aria-invalid={errors.confirmSlug ? 'true' : undefined} aria-describedby="slug-once" />
      <span id="slug-once" class="muted">Der Kurzname bleibt dauerhaft (Anmelde-Realm, Datenbank, Kalender) und lässt sich nicht umbenennen.</span>
      {#if errors.confirmSlug}<span class="err">{errors.confirmSlug}</span>{/if}
    </label>
    <label>
      Host
      <input name="host" required autocomplete="off" placeholder="rat.musterstadt.de" value={String(values.host ?? data.expectedHost ?? '')} aria-invalid={errors.host ? 'true' : undefined} aria-describedby={data.expectedHost ? 'host-expected' : undefined} />
      {#if data.expectedHost}<span id="host-expected" class="muted">Diese Installation ist für den Host <code>{data.expectedHost}</code> eingerichtet; jeder andere Host wird beim Anlegen abgelehnt.</span>{/if}
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
      Erstes Gremium (Name, optional)
      <input name="bodyName" autocomplete="off" placeholder="Stadtrat" value={String(values.bodyName ?? '')} aria-invalid={errors.bodyName ? 'true' : undefined} />
      {#if errors.bodyName}<span class="err">{errors.bodyName}</span>{/if}
    </label>
    <label>
      Marke: Produktname
      <input name="brandProduct" required autocomplete="off" placeholder="Ratsportal" value={String(values.brandProduct ?? '')} aria-invalid={errors.brandProduct ? 'true' : undefined} />
      {#if errors.brandProduct}<span class="err">{errors.brandProduct}</span>{/if}
    </label>
    <label>
      Marke: Kurzname der Organisation
      <input name="brandOrgShort" required autocomplete="off" placeholder="MS" value={String(values.brandOrgShort ?? '')} aria-invalid={errors.brandOrgShort ? 'true' : undefined} />
      {#if errors.brandOrgShort}<span class="err">{errors.brandOrgShort}</span>{/if}
    </label>
    <label>
      Wintersemester beginnt im
      <select name="termWinterMonth" aria-invalid={errors.termMonths ? 'true' : undefined} aria-describedby={errors.termMonths ? 'err-term' : 'term-hint'}>
        {#each MONTHS as name, i (name)}
          <option value={String(i + 1)} selected={winterMonth === i + 1}>{name}</option>
        {/each}
      </select>
    </label>
    <label>
      Sommersemester beginnt im
      <select name="termSummerMonth" aria-invalid={errors.termMonths ? 'true' : undefined} aria-describedby={errors.termMonths ? 'err-term' : 'term-hint'}>
        {#each MONTHS as name, i (name)}
          <option value={String(i + 1)} selected={summerMonth === i + 1}>{name}</option>
        {/each}
      </select>
      <span id="term-hint" class="muted">Daraus berechnet das Portal die Semesterangabe neben dem Kurznamen (z. B. „WiSe 26/27“ oder „SoSe 27“).</span>
      {#if errors.termMonths}<span id="err-term" class="err">{errors.termMonths}</span>{/if}
    </label>
    <fieldset class="modules">
      <legend>Module (keine sind voreingestellt)</legend>
      {#each data.modules as m (m.id)}
        <label class="check">
          <input type="checkbox" name="enable" value={m.id} checked={checkedModules.includes(m.id)} disabled={m.denied !== null} />
          {m.name} <code>{m.id}</code>
          {#if m.denied}<span class="muted">gesperrt: {m.denied}</span>{/if}
        </label>
        {#if m.denied === null}
          <div class="dpia">
            <label>
              DPIA für {m.id}
              <select name={`dpia_${m.id}`} aria-invalid={errors.dpia ? 'true' : undefined} aria-describedby={errors.dpia ? 'err-dpia' : undefined}>
                <option value="" selected={typeof dpiaValues[m.id]?.requiresDpia !== 'boolean'}>bitte wählen</option>
                <option value="no" selected={dpiaValues[m.id]?.requiresDpia === false}>nicht erforderlich</option>
                <option value="yes" selected={dpiaValues[m.id]?.requiresDpia === true}>erforderlich</option>
              </select>
            </label>
            <label>
              Dokumentverweis (Pflicht für angekreuzte Module)
              <input name={`dpiaRef_${m.id}`} aria-invalid={errors.dpia ? 'true' : undefined} aria-describedby={errors.dpia ? 'err-dpia' : undefined} autocomplete="off" maxlength="500" value={String(dpiaValues[m.id]?.documentRef ?? '')} />
            </label>
          </div>
        {/if}
      {/each}
      <p class="muted">„vault“ (Tresor) bleibt im Pilotbetrieb abgeschaltet und ist nicht wählbar. Module ohne Isolationsprüfung sind ebenfalls nicht wählbar; die DPIA-Entscheidung trägt weiterhin die Betreiberin oder der Betreiber ein.</p>
      <p id="board-hint" class="muted">Ein nicht angekreuztes „board“ ist für den Kunden trotzdem eingeschaltet. Zum Ausblenden später auf der Kundenseite „Modul aktivieren“ und dann „Modul deaktivieren“ verwenden.</p>
      {#if errors.enable}<span class="err">{errors.enable}</span>{/if}
      {#if errors.dpia}<span id="err-dpia" class="err">{errors.dpia}</span>{/if}
    </fieldset>
    <p id="hint" class="muted">
      Das Panel legt nichts selbst an: es stellt eine Anfrage, die der Ausführer auf dem Host erneut prüft und Schritt für Schritt umsetzt.
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
  .dpia {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-left: 1.5rem;
  }
  select {
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
