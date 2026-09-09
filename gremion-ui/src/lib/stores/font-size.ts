/**
 * Font-size scale for the accessibility "Schriftgröße" control.
 * Kept in its own side-effect-free module so it can be imported (and unit
 * tested) without evaluating the store side effects in theme.ts.
 */
export const FONT_SIZE_MAP: Record<string, string> = {
	normal: '14px',
	large: '16px',
	xlarge: '18px',
}

/** Pure helper: maps a font-size key to its CSS px value (falls back to the base). */
export function fontSizePx(key: string): string {
	return FONT_SIZE_MAP[key] ?? FONT_SIZE_MAP.normal
}
