<script lang="ts">
  import { enhance } from '$app/forms'
  import { originLabel } from '$lib/request-format'
  import { LEDGER_STEP_LABEL as STEP_LABEL } from '$lib/request-state'
  import type { ActionData, PageData } from './$types'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  const STATUS_LABEL: Record<string, string> = { done: 'erledigt', pending: 'ausstehend', failed: 'fehlgeschlagen', absent: '—' }
  // No script polls: while a request or the setup is active the page reloads itself
  // (meta refresh, allowed by the panel's CSP), and the link reloads on demand.
</script>

<svelte:head>
  <title>{data.slug} · Gremion Betrieb</title>
  {#if data.refresh}<meta http-equiv="refresh" content="5" />{/if}
</svelte:head>

<h1>{data.slug}</h1>

{#if data.latest}
  <section class="request {data.latest.phase}" aria-labelledby="req-h">
    <h2 id="req-h">Anfrage: <span class="phase">{data.latest.label}</span></h2>
    <p role="status">{data.latest.text}</p>
    {#if data.latest.code}<p class="muted">Fehlerkennung: <code>{data.latest.code}</code></p>{/if}
    {#if data.latest.detail}<p class="muted">Begründung (technisch): <code>{data.latest.detail}</code></p>{/if}
    {#if data.latest.active}<p class="muted">Diese Seite lädt sich alle 5 Sekunden neu. <a href="/customers/{data.slug}">Jetzt aktualisieren</a></p>{/if}
    {#if data.latest.retryable}
      <form method="POST" action="?/retry" use:enhance>
        {#if form?.retryError}<p class="error" role="alert">{form.retryError}</p>{/if}
        <button type="submit">Erneut versuchen</button>
      </form>
    {:else if data.latest.retryNote}
      <p class="muted">{data.latest.retryNote}</p>
    {/if}
  </section>
{/if}

{#if !data.status}
  {#if !data.latest}<p class="muted" role="status">Noch keine Anfrage und kein Mandant mit diesem Kurznamen.</p>{/if}
{:else}
  <dl>
    <dt>Status</dt><dd>{data.status.status}</dd>
    <dt>Host</dt><dd>{data.status.host ?? '—'}</dd>
    <dt>Kennung</dt><dd><code>{data.status.id}</code></dd>
  </dl>
  {#if data.status.steps === null}
    <p class="muted">Keine Plattform-Datenbank konfiguriert: der Einrichtungsverlauf ist hier nicht lesbar.</p>
  {:else}
    <ol class="steps">
      {#each data.status.steps as s (s.kind)}
        <li class={s.status}>
          <span class="label">{STEP_LABEL[s.kind] ?? s.kind}</span>
          <span class="state">{STATUS_LABEL[s.status]}</span>
        </li>
      {/each}
    </ol>
  {/if}
{/if}

{#if data.offer.suspend || data.offer.resume}
  <section class="lifecycle" aria-labelledby="life-h">
    <h2 id="life-h">Betrieb</h2>
    {#if form?.lifecycleError}<p class="error" role="alert">{form.lifecycleError}</p>{/if}
    {#if data.offer.suspend}
      <form method="POST" action="?/suspend" use:enhance>
        <p class="muted">Sperren: Anmeldung und Zugriff des Mandanten werden beendet, die Seite zeigt die Sperrmeldung. Die Daten bleiben unangetastet.</p>
        <button type="submit">Mandant sperren</button>
      </form>
    {/if}
    {#if data.offer.resume}
      <form method="POST" action="?/resume" use:enhance>
        <p class="muted">Fortsetzen: Der Mandant wird mit seinen unveränderten Daten wieder freigegeben.</p>
        <button type="submit">Mandant fortsetzen</button>
      </form>
    {/if}
  </section>
{/if}

{#if data.moduleSection}
  <section class="modules" aria-labelledby="mod-h">
    <h2 id="mod-h">Module</h2>
    {#if form?.moduleError}<p class="error" role="alert">{form.moduleError}</p>{/if}
    {#if !data.moduleSection.canAct}
      <p class="muted" role="status">Module können nur für einen aktiven Mandanten ohne laufende Anfrage geändert werden.</p>
    {/if}

    <h3>Aktive Module</h3>
    {#if data.moduleSection.enabled.length === 0}
      <p class="muted">Keine Module aktiv.</p>
    {:else}
      <ul class="mods">
        {#each data.moduleSection.enabled as m (m.id)}
          <li>
            <span>{m.name} <code>{m.id}</code></span>
            {#if data.moduleSection.canAct}
              <form method="POST" action="?/disable_module" use:enhance>
                <input type="hidden" name="module" value={m.id} />
                <p class="muted">Deaktivieren: Die Moduldaten werden zuerst exportiert und geprüft, erst danach wird die Moduldatenbank entfernt.</p>
                <button type="submit">Modul deaktivieren</button>
              </form>
              <details>
                <summary>DPIA-Entscheidung festhalten</summary>
                <form method="POST" action="?/record_dpia" use:enhance>
                  <input type="hidden" name="module" value={m.id} />
                  <label>
                    DPIA für {m.id}
                    <select name="dpia">
                      <option value="" selected>bitte wählen</option>
                      <option value="no">nicht erforderlich</option>
                      <option value="yes">erforderlich</option>
                    </select>
                  </label>
                  <label>
                    Dokumentverweis (Pflicht)
                    <input name="dpiaRef" autocomplete="off" maxlength="500" />
                  </label>
                  <button type="submit">Entscheidung festhalten</button>
                </form>
              </details>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <h3>Verfügbare Module</h3>
    {#if data.moduleSection.available.length === 0}
      <p class="muted">Keine weiteren Module verfügbar.</p>
    {:else}
      <ul class="mods">
        {#each data.moduleSection.available as m (m.id)}
          <li>
            <span>{m.name} <code>{m.id}</code></span>
            {#if m.denied}
              <span class="muted">gesperrt: {m.denied}</span>
            {:else if data.moduleSection.canAct}
              <form method="POST" action="?/enable_module" use:enhance>
                <input type="hidden" name="module" value={m.id} />
                <label>
                  DPIA für {m.id}
                  <select name="dpia" required>
                    <option value="" selected>bitte wählen</option>
                    <option value="no">nicht erforderlich</option>
                    <option value="yes">erforderlich</option>
                  </select>
                </label>
                <label>
                  Dokumentverweis (Pflicht, auch bei „nicht erforderlich“)
                  <input name="dpiaRef" required autocomplete="off" maxlength="500" />
                </label>
                <button type="submit">Modul aktivieren</button>
              </form>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if data.moduleSection.canAct}
      <h3>Abgleich</h3>
      <p class="muted">Prüft den Anmelde-Realm des Mandanten gegen den Sollzustand (Trockenlauf ändert nichts); „anwenden“ repariert Abweichungen.</p>
      <form method="POST" action="?/reconcile" use:enhance class="inline">
        <input type="hidden" name="apply" value="false" />
        <button type="submit">Abgleich prüfen (Trockenlauf)</button>
      </form>
      <form method="POST" action="?/reconcile" use:enhance class="inline">
        <input type="hidden" name="apply" value="true" />
        <button type="submit">Abgleich anwenden</button>
      </form>
    {/if}

    {#if data.reconcileEvents.length}
      <h3>Ergebnis des letzten Abgleichs</h3>
      <pre class="events">{#each data.reconcileEvents as e, i (i)}{e.level === 'error' ? '! ' : '  '}{e.message}
{/each}</pre>
    {/if}
  </section>
{/if}

{#if data.requests.length}
  <h2>Anfragen</h2>
  <ul class="requests">
    {#each data.requests as q (q.id)}
      <li>
        <code>{q.kind}</code> · {q.state}
        {#if q.origin === 'host'}<strong class="breakglass">{originLabel(q.origin)}</strong> ({q.hostActor ?? '—'}: {q.reason ?? '—'}){/if}
        {#if q.outcome}<span class="muted"> — {q.outcome}</span>{/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  h1 {
    font-size: 1.4rem;
    margin: 1.5rem 0 1rem;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
  }
  dt {
    color: var(--muted);
  }
  .steps {
    padding-left: 1.25rem;
  }
  .steps li {
    display: flex;
    justify-content: space-between;
    max-width: 36rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--line);
  }
  .steps li.done .state {
    color: var(--ok);
  }
  .steps li.failed .state {
    color: var(--bad);
  }
  .steps li.pending .state {
    color: var(--warn);
  }
  .request {
    max-width: 36rem;
    border: 1px solid var(--line);
    border-left-width: 4px;
    padding: 0.5rem 1rem;
    margin-bottom: 1.5rem;
  }
  .request h2 {
    font-size: 1.1rem;
  }
  .request.succeeded {
    border-left-color: var(--ok);
  }
  .request.failed,
  .request.refused,
  .request.dead {
    border-left-color: var(--bad);
  }
  .request.queued,
  .request.verifying,
  .request.running,
  .request.expired {
    border-left-color: var(--warn);
  }
  .lifecycle {
    max-width: 36rem;
    margin-bottom: 1.5rem;
  }
  .modules {
    max-width: 36rem;
    margin-bottom: 1.5rem;
  }
  .modules h3 {
    font-size: 1rem;
    margin: 1rem 0 0.25rem;
  }
  .mods {
    list-style: none;
    padding: 0;
  }
  .mods li {
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--line);
  }
  .mods label {
    display: block;
    margin: 0.25rem 0;
  }
  .inline {
    display: inline-block;
    margin-right: 0.5rem;
  }
  .events {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    border: 1px solid var(--line);
    padding: 0.5rem;
  }
  .error {
    color: var(--bad);
  }
  .muted {
    color: var(--muted);
  }
</style>
