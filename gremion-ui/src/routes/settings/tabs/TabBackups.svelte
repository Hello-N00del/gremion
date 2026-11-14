<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { onDestroy, onMount } from 'svelte'

  export let backups: { retention_days: number; last_backup_at: string | null; encryption_key_path: string }
  /** How often the real run state is re-read while a backup is in flight. */
  export let pollMs = 3000

  let retentionDays = backups.retention_days
  let saving = false
  let saved = false
  let saveError = ''

  // F1-FIX-10-K (D-4): the button triggers a REAL host backup (hostd). What is
  // shown is the server-recorded run state; `last_backup_at` is only ever the
  // value the server stamped from a finished run.
  interface RunState {
    id: string
    state: 'started' | 'finished' | 'failed'
    startedAt: string
    finishedAt?: string
    exitCode?: number | null
    error?: string
  }
  // The host daemon is optional. `not_configured` means backups are not managed
  // from the app on this installation (the operator runs them outside it): a
  // normal state, shown as a plain notice. `unreachable` is a fault.
  type TriggerState = 'available' | 'not_configured' | 'unreachable'
  let triggerLoaded = false
  let triggerState: TriggerState = 'unreachable'
  let triggerReason = ''
  let run: RunState | null = null
  let lastBackupAt: string | null = backups.last_backup_at
  let destroyed = false

  let triggeringBackup = false
  let backupError = ''

  let requestingCheck = false
  let checkMessage = ''
  let checkError = ''

  interface BackupStep {
    step: string
    duration_s: number
    status: string
    size_bytes?: number
  }
  interface BackupRun {
    run_id: string
    timestamp: string
    total_duration_s: number
    status: string
    steps: BackupStep[]
  }

  let backupRuns: BackupRun[] = []
  let logLoading = false
  let expandedRun: string | null = null

  function readTriggerState(trigger: { available?: unknown; state?: unknown } | null | undefined): TriggerState {
    const state = trigger?.state
    if (state === 'available' || state === 'not_configured' || state === 'unreachable') return state
    return trigger?.available === true ? 'available' : 'unreachable'
  }

  async function loadLog() {
    logLoading = true
    try {
      const res = await fetch('/api/settings/backup')
      if (res.ok) {
        const body = await res.json()
        backupRuns = (body.data as BackupRun[] ?? []).slice().reverse()
        triggerState = readTriggerState(body.trigger)
        triggerReason = body.trigger?.reason ?? ''
        run = (body.run as RunState | null) ?? null
        lastBackupAt = body.last_backup_at ?? null
        triggerLoaded = true
      }
    } finally {
      logLoading = false
    }
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  // Re-read the recorded run state until it leaves `started`. The state comes
  // from the server (hostd's answer), never from this component's guess.
  async function pollRun() {
    while (!destroyed && run?.state === 'started') {
      await sleep(pollMs)
      if (destroyed) return
      try {
        await loadLog()
      } catch {
        /* transient: keep polling, the next read shows the truth */
      }
    }
  }

  async function triggerBackup() {
    triggeringBackup = true
    backupError = ''
    try {
      const res = await fetch('/api/settings/backup', { method: 'POST' })
      if (res.ok) {
        const body = await res.json()
        run = { id: body.data?.run_id ?? '', state: 'started', startedAt: body.data?.timestamp ?? new Date().toISOString() }
        await pollRun()
      } else {
        const body = await res.json()
        backupError = body.error ?? 'Fehler beim Starten des Backups.'
        if (res.status === 503) {
          triggerState = body.code === 'not_configured' ? 'not_configured' : 'unreachable'
          triggerReason = backupError
          backupError = ''
        }
      }
    } catch {
      backupError = 'Verbindungsfehler.'
    } finally {
      triggeringBackup = false
    }
  }

  async function requestIntegrityCheck() {
    requestingCheck = true
    checkMessage = ''
    checkError = ''
    try {
      const res = await fetch('/api/settings/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check' }),
      })
      if (res.ok) {
        checkMessage = 'Integritätsprüfung angefragt — wird beim nächsten Backup-Lauf ausgeführt.'
      } else {
        const body = await res.json()
        if (body.code === 'not_configured') {
          triggerState = 'not_configured'
          triggerLoaded = true
        } else {
          checkError = body.error ?? 'Fehler beim Anfordern der Prüfung.'
        }
      }
    } catch {
      checkError = 'Verbindungsfehler.'
    } finally {
      requestingCheck = false
    }
  }

  async function saveRetention() {
    saving = true
    saved = false
    saveError = ''
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backups: { retention_days: Number(retentionDays) } }),
      })
      if (!res.ok) {
        const body = await res.json()
        saveError = body.error ?? 'Fehler beim Speichern.'
        return
      }
      saved = true
      setTimeout(() => { saved = false }, 3000)
    } catch {
      saveError = 'Verbindungsfehler.'
    } finally {
      saving = false
    }
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  function formatBytes(bytes: number | undefined): string {
    if (!bytes || bytes === 0) return '–'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  function stepLabel(step: string): string {
    const labels: Record<string, string> = {
      dump_postgres_nextcloud: 'Dump PostgreSQL (Nextcloud)',
      dump_postgres_keycloak: 'Dump PostgreSQL (Keycloak)',
      restic_backup: 'restic backup',
      restic_forget_prune: 'restic forget + prune',
      rclone_sync: 'rclone sync (Remote)',
      restic_check: 'Integritätsprüfung',
    }
    return labels[step] ?? step
  }

  $: running = run?.state === 'started'
  $: notManaged = triggerLoaded && triggerState === 'not_configured'
  $: unreachable = triggerLoaded && triggerState === 'unreachable'
  $: actionsUsable = triggerLoaded && triggerState === 'available'
  $: buttonDisabled = !actionsUsable || triggeringBackup || running
  $: checkDisabled = !actionsUsable || requestingCheck

  onMount(() => {
    loadLog()
      .then(pollRun)
      .catch(() => { backupError = 'Backup-Status konnte nicht geladen werden.' })
  })
  onDestroy(() => { destroyed = true })
</script>

<div class="space-y-6 py-4">
  <h2 class="text-lg font-semibold">Backups</h2>

  <!-- Retention setting. Where backups are not managed from the app, the operator
       sets retention together with the backups, so the form is not offered there. -->
  {#if !notManaged}
  <form class="space-y-3 max-w-xs" onsubmit={(e) => { e.preventDefault(); saveRetention() }}>
    <div class="space-y-1">
      <Label for="b-retention">Aufbewahrungsdauer (Tage)</Label>
      <Input id="b-retention" type="number" bind:value={retentionDays} min={7} max={365} aria-describedby="b-retention-hint" />
      <p id="b-retention-hint" class="text-xs text-ink-muted">Minimum 7 Tage</p>
    </div>
    {#if saveError}
      <p class="text-sm text-rust" role="alert">{saveError}</p>
    {/if}
    <div class="flex items-center gap-3">
      <Button type="submit" disabled={saving}>{saving ? 'Speichere…' : 'Speichern'}</Button>
      {#if saved}
        <span class="text-sm text-green-600" role="status">Gespeichert ✓</span>
      {/if}
    </div>
  </form>
  {/if}

  {#if notManaged}
    <!-- No host daemon on this installation: nothing here can start or inspect a
         backup, so say who runs them instead of offering actions that do nothing. -->
    <div class="space-y-1 max-w-prose rounded-lg border border-border px-3 py-2" data-testid="backup-not-managed">
      <p class="text-sm">
        Auf dieser Installation werden Backups nicht aus der App gesteuert. Der Betreiber führt sie außerhalb der App aus.
      </p>
      <p class="text-sm text-ink-muted">
        Deshalb lässt sich hier weder ein Backup noch eine Integritätsprüfung auslösen.
        {#if backupRuns.length === 0}
          Die App hat keine Aufzeichnungen über diese Läufe; Auskunft gibt der Betreiber.
        {/if}
      </p>
      <p class="text-sm text-ink-muted">
        Auch die Aufbewahrungsdauer der Backups legt der Betreiber fest; sie lässt sich hier nicht einstellen.
      </p>
      {#if lastBackupAt}
        <p class="text-xs text-ink-muted" data-testid="backup-last-at">
          Letztes erfolgreiches Backup, das aus der App gestartet wurde: {formatDate(lastBackupAt)}
        </p>
      {/if}
    </div>
  {:else}
  {#if unreachable}
    <div class="space-y-1" role="alert" data-testid="backup-trigger-reason">
      <p class="text-sm text-rust">{triggerReason || 'Der Host-Dienst für Backups ist nicht erreichbar.'}</p>
      <p class="text-sm text-ink-muted">
        Solange dieser Fehler besteht, lassen sich Backup und Integritätsprüfung hier nicht auslösen.
      </p>
    </div>
  {/if}
  <!-- Actions -->
  <div class="flex flex-wrap gap-3 items-start">
    <div class="space-y-1">
      <Button variant="outline" onclick={triggerBackup} disabled={buttonDisabled}>
        {running ? 'Backup läuft…' : triggeringBackup ? 'Starte Backup…' : 'Backup jetzt erstellen'}
      </Button>
      {#if run}
        {#if run.state === 'started'}
          <p class="text-sm text-ink-muted" role="status" data-testid="backup-run-state">
            Backup läuft seit {formatDate(run.startedAt)}…
          </p>
        {:else if run.state === 'finished'}
          <p class="text-sm text-green-700" role="status" data-testid="backup-run-state">
            Backup abgeschlossen am {formatDate(run.finishedAt ?? run.startedAt)}.
          </p>
        {:else}
          <p class="text-sm text-rust" role="alert" data-testid="backup-run-state">
            Backup fehlgeschlagen{run.finishedAt ? ` am ${formatDate(run.finishedAt)}` : ''}{run.error ? `: ${run.error}` : '.'}
          </p>
        {/if}
      {/if}
      {#if backupError}
        <p class="text-sm text-rust" role="alert">{backupError}</p>
      {/if}
      <p class="text-xs text-ink-muted" data-testid="backup-last-at">
        {lastBackupAt ? `Letztes erfolgreiches Backup: ${formatDate(lastBackupAt)}` : 'Noch kein erfolgreiches Backup.'}
      </p>
    </div>

    <div class="space-y-1">
      <Button variant="outline" onclick={requestIntegrityCheck} disabled={checkDisabled}>
        {requestingCheck ? 'Anfrage läuft…' : 'Integritätsprüfung anfragen'}
      </Button>
      {#if checkMessage}
        <p class="text-sm text-green-700" role="status">{checkMessage}</p>
      {/if}
      {#if checkError}
        <p class="text-sm text-rust" role="alert">{checkError}</p>
      {/if}
    </div>
  </div>
  {/if}

  <!-- Backup run log. Where backups are not managed from the app, an empty list
       would read as "no backups exist", so it is only shown when it has entries. -->
  {#if !notManaged || backupRuns.length > 0}
  <div class="space-y-2">
    <h3 class="text-sm font-semibold">Backup-Protokoll</h3>
    {#if logLoading}
      <p class="text-sm text-ink-muted">Lade…</p>
    {:else if backupRuns.length === 0}
      <p class="text-sm text-ink-muted">Keine Backups vorhanden.</p>
    {:else}
      <div class="space-y-2">
        {#each backupRuns as run (run.run_id)}
          <div class="rounded-lg border border-border overflow-hidden">
            <!-- Run header (clickable to expand steps) -->
            <button
              class="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-surface-2/30 transition-colors"
              onclick={() => { expandedRun = expandedRun === run.run_id ? null : run.run_id }}
            >
              <span class="font-mono text-xs text-ink-muted">{formatDate(run.timestamp)}</span>
              <span class="flex items-center gap-4">
                <span class="text-xs text-ink-muted">{run.total_duration_s}s gesamt</span>
                {#if run.status === 'ok'}
                  <span class="text-green-700 text-xs font-medium">✓ OK</span>
                {:else}
                  <span class="text-rust text-xs font-medium">✗ {run.status}</span>
                {/if}
                <span class="text-ink-muted text-xs">{expandedRun === run.run_id ? '▲' : '▼'}</span>
              </span>
            </button>

            <!-- Step duration table (expanded) -->
            {#if expandedRun === run.run_id}
              <div class="border-t border-border bg-surface-2/20">
                <table class="w-full text-xs">
                  <thead>
                    <tr class="text-ink-muted">
                      <th class="text-left px-3 py-1.5 font-medium">Schritt</th>
                      <th class="text-right px-3 py-1.5 font-medium">Dauer</th>
                      <th class="text-right px-3 py-1.5 font-medium">Größe</th>
                      <th class="text-right px-3 py-1.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-border/50">
                    {#each run.steps as step}
                      <tr>
                        <td class="px-3 py-1.5">{stepLabel(step.step)}</td>
                        <td class="px-3 py-1.5 text-right font-mono">{step.duration_s}s</td>
                        <td class="px-3 py-1.5 text-right">{formatBytes(step.size_bytes)}</td>
                        <td class="px-3 py-1.5 text-right">
                          {#if step.status === 'ok'}
                            <span class="text-green-700">✓</span>
                          {:else if step.status === 'skipped'}
                            <span class="text-ink-muted">—</span>
                          {:else}
                            <span class="text-rust">✗</span>
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
  {/if}
</div>
