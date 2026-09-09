import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { readConfig } from '$lib/server/config'
import { isGoLiveReady } from '$lib/server/setup-readiness'

export const load: PageServerLoad = async () => {
  const config = readConfig()

  // Wizard is locked once setup is complete
  if (config.setup_complete) {
    throw error(404, 'Setup already complete')
  }

  // Determine which step is currently pending
  const steps = config.wizard_steps
  let currentStep = 1
  if (steps.health_check === 'complete') currentStep = 2
  if (steps.org_info === 'complete') currentStep = 3
  if (steps.admin_accounts === 'complete') currentStep = 4
  if (steps.smtp === 'complete') currentStep = 5

  return {
    currentStep,
    wizardSteps: steps,
    org: config.org,
    smtp: config.smtp,
    // P2.1c (D-WIZARD/D2): pre-select the deployment toggle from the persisted
    // config (default 'single' via the config back-fill).
    deploymentMode: config.deployment.mode,
    // t291-setup-brand-legal: pre-fill the Marke + Rechtstexte step from the
    // persisted config (neutral defaults / placeholder legal on first run), and
    // surface the go-live readiness so the Abschluss action stays disabled until
    // the brand product is set AND all three legal texts are past the
    // placeholder. The client recomputes readiness live as the operator edits;
    // this is the initial server-resolved value.
    brand: { product: config.brand.product, palette: config.brand.palette },
    legal: config.legal,
    goLiveReady: isGoLiveReady(config),
  }
}
