// Content Engine — classify a sendMailForTenant throw (R29-LOW-07 L3).
//
// The email renderer must decide, per recipient, whether a failed send is
// DEFINITIVE (the server provably did not accept the message: mark the delivery
// failed so a re-publish retries it) or UNKNOWN (the message may already have been
// accepted: keep the claim, never re-send, count it as unrecorded).
//
// nodemailer cannot tell the two apart by `err.command`: smtp-connection stamps
// command 'CONN' on EVERY socket-level error (a socket error, an unexpected close
// and a timeout alike) whatever the SMTP phase, so a stall or a drop AFTER the
// message body was handed over also says 'CONN'. smtp-transport and smtp-pool never
// rewrite it. The classifier therefore treats a transport error as UNKNOWN unless
// it carries a signature that PROVES nothing was handed over.

/** nodemailer transport-level error codes (connection drop, timeout, socket error). */
const TRANSPORT_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNECTION', 'ESOCKET'])

/** Node/OS error names that mean the TCP connection was never established. */
const NO_CONNECTION_ERRNO = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'])

/** nodemailer's own messages for a timeout BEFORE the session started. */
const PRE_SESSION_MESSAGES = ['Connection timeout', 'Greeting never received']

/**
 * Whether a sendMailForTenant throw leaves the delivery outcome UNKNOWN: a
 * transport error (ETIMEDOUT / ECONNECTION / ESOCKET) with no SMTP rejection that
 * is not provably from before the message was handed over.
 *
 * Definitive (the mail was not accepted):
 * - an SMTP rejection (a 4xx/5xx `responseCode`) on any command;
 * - a non-transport error (EENVELOPE, EMESSAGE, EAUTH, EDNS, ETLS, unconfigured,
 *   a plain Error);
 * - a transport error from before the session started: the connect itself failed
 *   (`syscall` connect, or an ECONNREFUSED / ENOTFOUND / EHOSTUNREACH errno), the
 *   connection or greeting timed out, or a call on a connection that was already
 *   destroyed (command 'API': nothing was handed over).
 */
export function isOutcomeUnknown(err: unknown): boolean {
	if (typeof err !== 'object' || err === null) return false
	const { code, command, responseCode, syscall, errno, message } = err as {
		code?: unknown
		command?: unknown
		responseCode?: unknown
		syscall?: unknown
		errno?: unknown
		message?: unknown
	}
	if (typeof code !== 'string' || !TRANSPORT_ERROR_CODES.has(code)) return false
	if (typeof responseCode === 'number' && responseCode >= 400) return false // the server answered: rejected
	if (command === 'API') return false // nothing was handed to a destroyed connection
	if (syscall === 'connect') return false // the TCP connect itself failed
	if (typeof errno === 'string' && NO_CONNECTION_ERRNO.has(errno)) return false
	if (typeof message === 'string' && PRE_SESSION_MESSAGES.some((m) => message === m)) return false
	return true
}
