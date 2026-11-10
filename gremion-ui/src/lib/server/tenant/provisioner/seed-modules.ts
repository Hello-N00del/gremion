// D-8: which modules a vertical seed may plan matrix rooms and Nextcloud folders for.
//
// The platform knows catalogue ids (`messaging`, `files`: plt.module_enablement, modules/<id>/module.json);
// the planner (@gremion/member-import seed-plan.ts) takes two flags. This is the one place the two meet, so
// the call site reads what the PLATFORM enabled for the customer (ProvisioningDeps.modules.enabled) and not
// cfg.modules, which carries the manifest ids (`messages`, not `messaging`) and defaults every toggleable
// module to on whether or not the platform enabled it.
import type { SeedModules } from '@gremion/member-import'

/** @param enabled the customer's enabled module keys (catalogue ids). */
export function seedModulesFor(enabled: readonly string[]): SeedModules {
  const on = new Set(enabled)
  return { messaging: on.has('messaging'), files: on.has('files') }
}
