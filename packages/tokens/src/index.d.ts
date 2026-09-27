// Hand-written declarations for the public entry (the sources are JSDoc-typed
// JavaScript; `pnpm --filter @gremion/tokens typecheck` checks them).
export type Declarations = [string, string][]
export interface BuiltCss {
  light: Declarations
  dark: Declarations
}
export interface TokenSets {
  base: Record<string, unknown>
  dark: Record<string, unknown>
}
export interface PaletteOverride {
  H: number
  hue?: string
  light: Record<string, string>
  dark: Record<string, string>
}
export interface FlatToken {
  path: string
  type: string | undefined
  value: unknown
  description?: string
  ext: { css?: string; handWritten?: boolean; palette?: boolean; defaultHue?: boolean; hue?: string }
}
export interface TierViolation {
  rule: string
  path: string
  target?: string
  message: string
}
export interface ValidationResult {
  ok: boolean
  errors: string[]
  tokenCount: number
}

export declare const EXT: 'org.gremion'
export declare const TIERS: readonly ['component', 'semantic', 'core']

export declare function loadTokens(): TokenSets
export declare function buildCss(sets: TokenSets): BuiltCss
export declare function buildPalettes(
  base: Record<string, unknown>,
  opts?: { engine?: (H: number) => { light: Record<string, string>; dark: Record<string, string> } },
): Record<string, PaletteOverride>
export declare function checkFences(css: string, built: BuiltCss): string[]
export declare function syncFences(css: string, built: BuiltCss): string
export declare function resolveTokenValue(universe: Map<string, FlatToken>, path: string): string
export declare function cssText(universe: Map<string, FlatToken>, path: string): string
export declare function literalText(universe: Map<string, FlatToken>, path: string): string
export declare function emitDeclarations(universe: Map<string, FlatToken>): Declarations
export declare function instanceAccentVars(H: number): { light: Record<string, string>; dark: Record<string, string> }
export declare function lintTiers(doc: Record<string, unknown>, opts?: { against?: Record<string, unknown> }): TierViolation[]
export declare function aliasTarget(v: unknown): string | null
export declare function aliasesIn(v: unknown): string[]
export declare function flatten(doc: Record<string, unknown>): Map<string, FlatToken>
export declare function mergeDocs(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown>
export declare function tierOf(path: string): string | null
export declare function findDuplicateKeys(text: string): { path: string; key: string }[]
export declare function parseStrictJson(text: string, source: string): unknown
export declare function validateTokenDocument(text: string, source: string): ValidationResult
export declare function validateResolverDocument(text: string, source: string): ValidationResult
