// What a mail failure may put in a log. A mail error's message and response can
// echo the recipient address, so neither is ever read here: only the class name
// and the cause fields (nodemailer sets code, responseCode and command), and each
// only when it is a plain token. Keep the same rules in the kernel send-mail
// route and in modules/publishing/src/mail-error.ts.

export interface MailCause {
  code?: string
  responseCode?: number
  command?: string
}

export interface MailErrorFields extends MailCause {
  name: string
}

const TOKEN = /^[A-Za-z0-9_]{1,40}$/
const COMMAND = /^[A-Z][A-Z0-9 ]{0,19}$/

/** The cause fields of anything that carries them (an Error, or a parsed JSON body). */
export function mailCause(source: unknown): MailCause {
  if (source === null || typeof source !== 'object') return {}
  const s = source as { code?: unknown; responseCode?: unknown; command?: unknown }
  const out: MailCause = {}
  if (typeof s.code === 'string' && TOKEN.test(s.code)) out.code = s.code
  if (typeof s.responseCode === 'number' && Number.isInteger(s.responseCode) && s.responseCode >= 100 && s.responseCode <= 599) {
    out.responseCode = s.responseCode
  }
  if (typeof s.command === 'string' && COMMAND.test(s.command)) out.command = s.command
  return out
}

export function mailErrorFields(err: unknown): MailErrorFields {
  if (!(err instanceof Error)) return { name: typeof err }
  return { name: err.name, ...mailCause(err) }
}
