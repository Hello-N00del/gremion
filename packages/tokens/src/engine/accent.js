// The OKLCH accent engine (UX-033 "kept"): one formula derives a whole
// light/dark accent ramp from a single hue, so every derived palette stays
// coherent by construction. Moved here from gremion-ui's
// lib/theme/instance-theme.ts (TASK-082), which re-exports it unchanged; the
// token build calls it for every palette hue in the core hue registry, so the
// build's per-palette override set IS this function's output, never a copy.
//
// Client-safe and dependency-free: gremion-ui bundles it into the browser
// (the setup wizard's palette picker) and into the server (hooks.server.ts
// injects the per-tenant <style> block).

/**
 * Accent ramp for a given hue. Only H varies; lightness/chroma per step are
 * fixed so every hue derives an AA-coherent ramp.
 * @param {number} H  OKLCH hue angle in degrees
 * @returns {{ light: Record<string, string>, dark: Record<string, string> }}
 */
export function instanceAccentVars(H) {
  return {
    light: {
      '--accent': `oklch(42% 0.11 ${H})`,
      '--accent-ink': `oklch(36% 0.11 ${H})`,
      '--accent-soft': `oklch(93% 0.035 ${H})`,
      '--accent-faint': `oklch(96% 0.02 ${H})`,
    },
    dark: {
      '--accent': `oklch(72% 0.13 ${H})`,
      '--accent-ink': `oklch(78% 0.11 ${H})`,
      '--accent-soft': `oklch(28% 0.06 ${H})`,
      '--accent-faint': `oklch(22% 0.04 ${H})`,
    },
  }
}
