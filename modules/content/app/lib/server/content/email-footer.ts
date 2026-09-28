// Content Engine (L2) — the unsubscribe-footer injector for the self-contained
// email channel. Mirrors services/newsletter/src/dispatch.ts::injectUnsubscribeFooter:
// insert an "Abmelden" link before </body> (or append when there is no body tag).
//
// The unsubscribe URL is URI-encoded so a token (or any query value) can never
// break out of the href attribute or smuggle markup into the email body.

/**
 * Insert the unsubscribe footer linking `unsubscribeUrl` just before `</body>`
 * (case-insensitive); when there is no closing body tag, append it. The URL is
 * URI-encoded (its `&`/`<`/`"` etc. escaped) so it is safe inside the href.
 */
export function injectUnsubscribeFooter(html: string, unsubscribeUrl: string): string {
	const href = encodeURI(unsubscribeUrl)
	const footer =
		`<p style="font-size:12px;color:#888;">` + `<a href="${href}">Abmelden</a></p>`
	const idx = html.toLowerCase().lastIndexOf('</body>')
	if (idx === -1) return html + footer
	return html.slice(0, idx) + footer + html.slice(idx)
}
