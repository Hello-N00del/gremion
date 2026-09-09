<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'

  const dispatch = createEventDispatcher<{ advance: void }>()

  type ServiceStatus = 'healthy' | 'unhealthy' | 'warning' | 'checking'
  type CredentialStatus = 'valid' | 'invalid' | 'unchecked'
  interface ServiceHealth {
    status: ServiceStatus
    reachable: boolean
    credentialsValid: boolean | null
  }
  interface HealthData {
    services: Record<string, ServiceStatus>
    // New fields (backward-compatible): present on current API, may be absent
    // when talking to an older endpoint.
    serviceDetails?: Record<string, ServiceHealth>
    credentials?: Record<string, CredentialStatus>
    can_proceed: boolean
  }

  let loading = false
  let healthData: HealthData | null = null
  let error = ''

  // (open-core carve) Nextcloud/Helios reachability rows + the Nextcloud/Synapse
  // credential rows were removed with those satellite services — the governance
  // kernel probes only the always-on core services here.
  const SERVICE_LABELS: Record<string, string> = {
    postgres: 'PostgreSQL',
    keycloak: 'Keycloak',
    redis: 'Redis',
  }

  // Credential validity is reported under these keys.
  const CREDENTIAL_LABELS: Record<string, string> = {
    keycloak: 'Keycloak',
  }

  async function checkHealth() {
    loading = true
    error = ''
    try {
      const res = await fetch('/api/setup/health')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      healthData = body.data
    } catch (err) {
      error = err instanceof Error ? err.message : 'Verbindungsfehler'
    } finally {
      loading = false
    }
  }

  onMount(() => { checkHealth() })

  function credIcon(status: CredentialStatus | undefined): string {
    if (status === 'valid') return '✓'
    if (status === 'unchecked') return '—'
    return '✗'
  }

  function credClass(status: CredentialStatus | undefined): string {
    if (status === 'valid') return 'text-green-600'
    if (status === 'unchecked') return 'text-ink-muted'
    return 'text-rust'
  }

  // Credential entries surfaced distinctly from reachability. Falls back to an
  // empty list when talking to an older endpoint that omits `credentials`.
  $: credentialEntries = healthData?.credentials
    ? Object.entries(CREDENTIAL_LABELS)
        .map(([key, label]) => ({ key, label, status: healthData?.credentials?.[key] }))
        .filter((e) => e.status !== undefined && e.status !== 'unchecked')
    : []

  // Any required-service credential that was reachable but rejected. These block
  // "Weiter" even if every service is reachable — the server already enforces
  // this in can_proceed; the UI mirrors it so the reason is visible (#191).
  $: invalidRequiredCreds = (['keycloak'] as const).filter(
    (k) => healthData?.credentials?.[k] === 'invalid'
  )

  // Belt-and-braces gate: trust the server's can_proceed, but never allow
  // advancing while a required credential is known-invalid.
  $: canProceed = !!healthData?.can_proceed && invalidRequiredCreds.length === 0
</script>

<div class="space-y-6">
  <div>
    <h2 class="text-xl font-semibold">Systemprüfung</h2>
    <p class="mt-1 text-sm text-ink-muted">
      Alle erforderlichen Dienste werden auf Erreichbarkeit und gültige
      Admin-Zugangsdaten geprüft.
    </p>
  </div>

  {#if error}
    <div class="rounded border border-rust/50 bg-rust-soft px-4 py-3 text-sm text-rust-ink" role="alert">
      {error}
    </div>
  {/if}

  <div>
    <h3 class="mb-2 text-sm font-semibold text-ink-muted">Erreichbarkeit</h3>
    <ul class="divide-y rounded-lg border" role="list">
      {#each Object.entries(SERVICE_LABELS) as [key, label]}
        {@const status = loading ? undefined : healthData?.services[key]}
        {@const detail = healthData?.serviceDetails?.[key]}
        <!-- Reachability shown on its own terms: prefer the explicit `reachable`
             flag when the API provides it, so a reachable-but-bad-secret service
             still reads "Erreichbar" here and surfaces the failure in the
             credential section below (#191). -->
        {@const reachable = detail ? detail.reachable : status === 'healthy'}
        <li class="flex items-center justify-between px-4 py-3">
          <span class="font-medium text-sm">{label}</span>
          <div class="flex items-center gap-2 text-sm">
            {#if loading}
              <span class="text-ink-muted">Prüfe…</span>
            {:else}
              <span class="{reachable ? 'text-green-600' : 'text-rust'} font-semibold">
                {reachable ? '✓' : '✗'}
              </span>
              <span class="{reachable ? 'text-green-600' : 'text-rust'}">
                {reachable ? 'Erreichbar' : 'Nicht erreichbar'}
              </span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </div>

  {#if credentialEntries.length > 0 && !loading}
    <div>
      <h3 class="mb-2 text-sm font-semibold text-ink-muted">Admin-Zugangsdaten</h3>
      <ul class="divide-y rounded-lg border" role="list">
        {#each credentialEntries as { key, label, status } (key)}
          <li class="flex items-center justify-between px-4 py-3">
            <span class="font-medium text-sm">{label}</span>
            <div class="flex items-center gap-2 text-sm">
              <span class="{credClass(status)} font-semibold">{credIcon(status)}</span>
              <span class="{credClass(status)}">
                {#if status === 'valid'}Zugangsdaten gültig
                {:else}Zugangsdaten ungültig
                {/if}
              </span>
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if invalidRequiredCreds.length > 0 && !loading}
    <div class="rounded border border-rust/50 bg-rust-soft px-4 py-3 text-sm text-rust-ink" role="alert">
      Mindestens ein Dienst ist erreichbar, aber die Admin-Zugangsdaten wurden
      abgelehnt. Bitte das jeweilige Secret prüfen (z. B.
      KEYCLOAK_ADMIN_CLIENT_SECRET) – sonst schlägt die
      Einrichtung später mit 401-Fehlern fehl.
    </div>
  {/if}

  <div class="flex items-center justify-between">
    <Button variant="outline" onclick={checkHealth} disabled={loading}>
      {loading ? 'Prüfe…' : 'Erneut prüfen'}
    </Button>
    <Button
      disabled={loading || !canProceed}
      onclick={async () => {
        await fetch('/api/setup/config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wizard_steps: { health_check: 'complete' } }),
        })
        dispatch('advance')
      }}
    >
      Weiter
    </Button>
  </div>
</div>
