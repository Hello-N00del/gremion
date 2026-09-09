<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import { page } from '$app/state'
  import { resolveBrand } from '$lib/brand'
  import type { PageData } from './$types'
  import Step1Health from './steps/Step1Health.svelte'
  import Step2Org from './steps/Step2Org.svelte'
  import Step3Admins from './steps/Step3Admins.svelte'
  import Step4Smtp from './steps/Step4Smtp.svelte'
  import StepBrandLegal from './steps/StepBrandLegal.svelte'
  import Step5Done from './steps/Step5Done.svelte'

  let { data }: { data: PageData } = $props()

  // Tenant brand (v4 re-audit slice 10) — product name for the wizard heading.
  const brand = $derived(resolveBrand(page.data.brand))

  // Runes mode: both of these are mutated after init (advance/goBack and the
  // Step3Admins advance handler), so they must be $state or the wizard never
  // re-renders on step change.
  let currentStep = $state(data.currentStep)

  // IT admin email is threaded to SMTP step for test email target
  let itAdminEmail = $state('')

  // t291-setup-brand-legal: go-live readiness gate. Seeded from the server
  // (isGoLiveReady over the persisted config) and refreshed live by the
  // Marke/Rechtstexte step's golivechange event, so the Abschluss action only
  // unlocks once the brand product is set AND all three legal texts are past the
  // placeholder.
  let goLiveReady = $state(data.goLiveReady)

  // t291-setup-brand-legal: a new Marke & Rechtstexte step sits before the
  // Abschluss step (6 steps total).
  const STEP_LABELS = [
    'Systemprüfung',
    'Organisation',
    'Admin-Konten',
    'E-Mail (SMTP)',
    'Marke & Rechtstexte',
    'Abschluss',
  ]
  const STEP_COUNT = STEP_LABELS.length

  function advance() {
    if (currentStep < STEP_COUNT) currentStep = currentStep + 1
  }

  function goBack() {
    if (currentStep > 1) currentStep = currentStep - 1
  }
</script>

<PageTitle title="Einrichtung" />

<div class="min-h-screen bg-paper flex flex-col items-center justify-start py-12 px-4">
  <div class="w-full max-w-2xl">
    <!-- Header -->
    <div class="mb-8 text-center">
      <h1 class="text-3xl font-bold">{brand.product} einrichten</h1>
      <p class="mt-2 text-ink-muted">Schritt {currentStep} von {STEP_COUNT}</p>
    </div>

    <!-- Step progress bar -->
    <nav aria-label="Einrichtungsschritte" class="mb-8">
      <ol class="flex items-center gap-0">
        {#each STEP_LABELS as label, i}
          {@const stepNum = i + 1}
          {@const isDone = stepNum < currentStep}
          {@const isActive = stepNum === currentStep}
          <li class="flex-1 flex flex-col items-center relative">
            <!-- Connector line (not on first item) -->
            {#if i > 0}
              <div
                class="absolute left-0 top-4 h-0.5 w-1/2 {isDone || isActive ? 'bg-accent' : 'bg-border'}"
                aria-hidden="true"
              ></div>
            {/if}
            {#if i < STEP_LABELS.length - 1}
              <div
                class="absolute right-0 top-4 h-0.5 w-1/2 {isDone ? 'bg-accent' : 'bg-border'}"
                aria-hidden="true"
              ></div>
            {/if}
            <!-- Step circle -->
            <div
              class="relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-medium
              {isDone ? 'bg-accent border-accent text-paper' : ''}
              {isActive ? 'bg-paper border-accent text-accent' : ''}
              {!isDone && !isActive ? 'bg-paper border-border text-ink-muted' : ''}"
              aria-current={isActive ? 'step' : undefined}
            >
              {#if isDone}✓{:else}{stepNum}{/if}
            </div>
            <span class="mt-1 text-xs text-center hidden sm:block {isActive ? 'text-ink font-medium' : 'text-ink-muted'}">
              {label}
            </span>
          </li>
        {/each}
      </ol>
    </nav>

    <!-- Step content -->
    <div class="rounded-xl border bg-surface shadow-xs p-6">
      {#if currentStep === 1}
        <Step1Health on:advance={advance} />
      {:else if currentStep === 2}
        <Step2Org org={data.org} deploymentMode={data.deploymentMode} on:advance={advance} on:back={goBack} />
      {:else if currentStep === 3}
        <Step3Admins on:advance={(e) => { itAdminEmail = e.detail?.itAdminEmail ?? ''; advance() }} on:back={goBack} />
      {:else if currentStep === 4}
        <Step4Smtp smtp={data.smtp} {itAdminEmail} on:advance={advance} on:back={goBack} />
      {:else if currentStep === 5}
        <StepBrandLegal
          brand={data.brand}
          legal={data.legal}
          on:golivechange={(e) => (goLiveReady = e.detail.ready)}
          on:advance={advance}
          on:back={goBack}
        />
      {:else if currentStep === 6}
        <Step5Done {goLiveReady} on:back={goBack} />
      {/if}
    </div>
  </div>
</div>
