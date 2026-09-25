// Content Engine (Pillar-1 kernel) — deterministic Instagram caption composer.
//
// Instagram has no rich text: the caption is one plain-text blob with a hard
// length cap. This composes a caption by rule from a post + its segmented
// sections (see segment.ts) — never an LLM — and surfaces the cap as a warning
// rather than silently dropping text. Pure and deterministic.

import type { Post } from './types'
import type { Section } from './segment'
// jsdom is imported untyped (no `@types/jsdom` dependency added for this pure
// helper); its window is re-typed to the standard DOM lib types below.
// @ts-expect-error -- jsdom has no bundled types and we add none on purpose.
import { JSDOM } from 'jsdom'

interface JsdomWindow {
	document: Document
}
interface JsdomInstance {
	window: JsdomWindow
}

/** Instagram caption hard limit (characters). */
export const IG_CAPTION_MAX = 2200

/** Instagram carousel hard limit (slides per post). */
export const IG_MAX_SLIDES = 10

/** A composed caption plus any caps/warnings the editor should surface. */
export interface CaptionResult {
	caption: string
	warnings: string[]
}

/** Fixed call-to-action / handle line appended to every caption. */
const CTA_LINE = 'Mehr auf dem Portal — Link in Bio.'

/**
 * Strip all tags from a fragment of HTML to plain text, deterministically.
 * Uses jsdom (not a regex) so entities decode and nested tags flatten the
 * same way under Node SSR and the jsdom test env. Whitespace is collapsed.
 */
function htmlToPlainText(html: string): string {
	if (!html || html.trim() === '') return ''
	const { window } = new JSDOM('<!DOCTYPE html><body></body>') as JsdomInstance
	window.document.body.innerHTML = html
	const text = window.document.body.textContent ?? ''
	return text.replace(/\s+/g, ' ').trim()
}

/**
 * Truncate `text` to at most `max` characters on a word boundary, appending a
 * single-character ellipsis '…'. The returned string (including the ellipsis)
 * never exceeds `max`. If no word boundary exists within the budget, a hard
 * cut is taken so the cap is always honored.
 */
function truncateOnWord(text: string, max: number): string {
	if (text.length <= max) return text
	// Reserve one char for the ellipsis.
	const budget = max - 1
	const slice = text.slice(0, budget)
	const lastSpace = slice.lastIndexOf(' ')
	const head = lastSpace > 0 ? slice.slice(0, lastSpace) : slice
	return head.trimEnd() + '…'
}

/**
 * Compose the Instagram caption: title, a blank line, the plain-text lead
 * (tags stripped from the first section's html), a blank line, then the
 * handle/CTA line. If the result exceeds `IG_CAPTION_MAX` it is truncated on a
 * word boundary with an ellipsis and a 'caption truncated' warning is pushed.
 *
 * Pure — no network, filesystem, clock, or randomness.
 */
export function composeCaption(post: Post, sections: Section[]): CaptionResult {
	const warnings: string[] = []

	const title = (post.title ?? '').trim()
	const lead = sections.length > 0 ? htmlToPlainText(sections[0].html) : ''

	const parts: string[] = []
	if (title !== '') parts.push(title)
	if (lead !== '') parts.push(lead)
	parts.push(CTA_LINE)

	// Title and lead are separated from each other and from the CTA by a blank
	// line (\n\n); the CTA always trails.
	const caption = parts.join('\n\n')

	if (caption.length > IG_CAPTION_MAX) {
		warnings.push(
			`caption truncated to ${IG_CAPTION_MAX} characters (was ${caption.length})`,
		)
		return { caption: truncateOnWord(caption, IG_CAPTION_MAX), warnings }
	}

	return { caption, warnings }
}
