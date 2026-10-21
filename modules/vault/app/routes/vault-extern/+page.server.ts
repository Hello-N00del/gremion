import type { PageServerLoad } from './$types'
import { env } from '$env/dynamic/private'

/**
 * Kernel /vault-extern launch page — inert-until-configured governance stub.
 *
 * VAULTWARDEN_BASE_URL is an operator-provided pointer at an externally-run
 * Vaultwarden (shared council password-vault) instance. The kernel does not
 * provision or manage that instance; this route is a pure launcher. Until the
 * env var is set, the page renders a disabled "activation pending" state —
 * there is nothing to load, and load() must never throw so the explainer
 * always renders.
 */
export const load: PageServerLoad = async () => {
  const vaultUrl = env.VAULTWARDEN_BASE_URL
  if (!vaultUrl) {
    return { configured: false, vaultUrl: null }
  }
  return { configured: true, vaultUrl }
}
