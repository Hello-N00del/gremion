// See https://svelte.dev/docs/kit/types#app.d.ts
import type { Operator } from '$lib/server/gate'

declare global {
  namespace App {
    interface Locals {
      /** Set by hooks.server.ts ONLY after the TRD-048 gate passed. */
      operator?: Operator
    }
  }
}

export {}
