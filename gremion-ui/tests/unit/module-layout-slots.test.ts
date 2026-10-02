// TASK-205b: the interim client-side composition seam (src/lib/modules/layout-slot.ts).
//
// The root layout composes the chrome the module halves contribute from `lib/modules/slots/*.slot.ts`. Two
// guards: the layout really consumes the slots (glob, topbarModules handed to AppShell, overlays mounted),
// and every slot file the build carries default-exports only the four documented parts, each a component.
// The rendered result (chips hidden below 768 px, live-call and bell kept, popover width) is the browser
// suite's (modules/messaging/app/lib/components/messaging/messaging-topbar.browser.test.ts).
import { describe, it, expect, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// the messaging slot imports the call picture-in-picture, which reads its public Element Call URL at load
vi.mock('$env/dynamic/public', () => ({ env: {} }))

const UI_ROOT = resolve(process.cwd())
const SLOTS_DIR = join(UI_ROOT, 'src', 'lib', 'modules', 'slots')
const ALLOWED = new Set(['chips', 'liveCall', 'bell', 'overlay'])

describe('the root layout consumes the module slots', () => {
  const layout = readFileSync(join(UI_ROOT, 'src', 'routes', '+layout.svelte'), 'utf8')

  it('globs lib/modules/slots/*.slot.ts eagerly and hands only the parts some module provides to AppShell', () => {
    expect(layout).toMatch(/import\.meta\.glob<[^>]*>\('\.\.\/lib\/modules\/slots\/\*\.slot\.ts',\s*\{\s*eager:\s*true\s*\}\)/)
    expect(layout).toContain('{topbarModules}')
    expect(layout).toMatch(/chipSlots\.length \? chips : undefined/)
    expect(layout).toMatch(/liveCallSlots\.length \? liveCall : undefined/)
    expect(layout).toMatch(/bellSlots\.length \? bell : undefined/)
  })

  it('mounts every overlay a module provides beside the shell, with the session user', () => {
    expect(layout).toMatch(/\{#each overlaySlots as Overlay[^}]*\}<Overlay \{user\} \/>\{\/each\}/)
  })
})

describe('every slot file in the build', () => {
  const files = existsSync(SLOTS_DIR) ? readdirSync(SLOTS_DIR).filter((f) => f.endsWith('.slot.ts')) : []

  it('exists for each module that contributes chrome (the build carries at least the messaging slot)', () => {
    expect(files).toContain('messaging.slot.ts')
  })

  for (const f of files) {
    it(`${f} default-exports only chips / liveCall / bell / overlay, each a component`, async () => {
      const mod = (await import(/* @vite-ignore */ `../../src/lib/modules/slots/${f}`)) as { default: Record<string, unknown> }
      expect(Object.keys(mod.default).length).toBeGreaterThan(0)
      for (const [key, value] of Object.entries(mod.default)) {
        expect(ALLOWED.has(key), `unknown slot part "${key}" in ${f}`).toBe(true)
        expect(typeof value, `${f}: ${key} must be a component`).toBe('function')
      }
    })
  }
})
