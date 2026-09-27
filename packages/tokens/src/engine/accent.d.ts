/**
 * Accent ramp for a given hue (the OKLCH instance engine, UX-033). Only H
 * varies; lightness/chroma per step are fixed.
 */
export declare function instanceAccentVars(H: number): {
  light: Record<string, string>
  dark: Record<string, string>
}
