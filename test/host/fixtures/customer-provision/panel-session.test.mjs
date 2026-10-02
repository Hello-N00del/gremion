// node --test test/host/fixtures/customer-provision/panel-session.test.mjs
//
// The pure halves of panel-session.mjs that the customer-admins phase of
// customer-provision-proof.sh depends on (brief section 1 "Admins sign in"):
// the execute-actions link is read out of the RAW message Keycloak submitted
// (MIME, quoted-printable or base64, the link in the text and the HTML part),
// bound to the sender kc-<token>@<PLATFORM_DOMAIN> and to the customer's own
// realm URL on its own host (Q16); and the TOTP of a first sign-in waits for a
// time step the enrolment did not use.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { actionLinkFromMail, decodeQuotedPrintable, mailFromAddress, msUntilFreshTotpStep, totp } from './panel-session.mjs'

const REALM = 'https://rat.proof-x.proof.example.org/auth/realms/proof-x'
const FROM = 'kc-proof_x@proof.example.org'
const KEY = 'eyJhbGciOiJIUzUxMiIsInR5cCIgOiAiSldUIiwia2lkIiA6ICI0ZjE2In0.eyJleHAiOjE3OTA4MTE0NzMsImlhdCI6MTc5MDgxMTQ3M30.c2lnbmF0dXJlLXZhbHVlLWZvci1wcm9vZg'
const LINK = `${REALM}/login-actions/action-token?key=${KEY}&client_id=account-console&tab_id=Xy_Z-1`

/** Quoted-printable as Jakarta Mail writes it: =3D for '=', soft breaks at 76. */
function qp(text) {
  const enc = text.replaceAll('=', '=3D')
  const out = []
  for (const line of enc.split('\n')) {
    let l = line
    while (l.length > 75) {
      let cut = 75
      // never split an =XX escape
      if (l[cut - 1] === '=') cut -= 1
      else if (l[cut - 2] === '=') cut -= 2
      out.push(`${l.slice(0, cut)}=`)
      l = l.slice(cut)
    }
    out.push(l)
  }
  return out.join('\r\n')
}

function kcMail({ from = `"Rat proof-x" <${FROM}>`, text = null, html = null, encoding = 'quoted-printable' } = {}) {
  const b = '----=_Part_7_1052117133.1790811473527'
  const body = (t) => (encoding === 'base64' ? Buffer.from(t, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n') : qp(t))
  const plain = text ?? `Ihr Administrator hat soeben angefordert, dass Sie Ihr Konto aktualisieren: Passwort aktualisieren, OTP konfigurieren.\n\n${LINK}\n\nDieser Link läuft in 72 Stunden ab.`
  const rich = html ?? `<html><body><p>Ihr Administrator hat angefordert:</p><p><a href="${LINK.replaceAll('&', '&amp;')}">Link zur Kontoaktualisierung</a></p></body></html>`
  return [
    `Return-Path: <${FROM}>`,
    `From: ${from}`,
    'To: roles+proof-x-it@proof.example.org',
    'Subject: =?UTF-8?Q?Kontoaktualisierung?=',
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; \r\n\tboundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=UTF-8',
    `Content-Transfer-Encoding: ${encoding}`,
    '',
    body(plain),
    `--${b}`,
    'Content-Type: text/html; charset=UTF-8',
    `Content-Transfer-Encoding: ${encoding}`,
    '',
    body(rich),
    `--${b}--`,
    '',
  ].join('\r\n')
}

describe('decodeQuotedPrintable', () => {
  it('joins soft line breaks and decodes =XX as UTF-8 bytes', () => {
    assert.equal(decodeQuotedPrintable('key=3Dab=\r\ncd l=C3=A4uft'), 'key=abcd läuft')
  })
})

describe('mailFromAddress', () => {
  it('reads the address of a display-name From, lower-cased', () => {
    assert.equal(mailFromAddress(kcMail()), FROM)
    assert.equal(mailFromAddress(kcMail({ from: 'KC-Proof_X@Proof.Example.Org' })), FROM)
  })
  it('a folded From header is unfolded', () => {
    assert.equal(mailFromAddress(kcMail({ from: `"Rat"\r\n <${FROM}>` })), FROM)
  })
  it('no From header is null', () => {
    assert.equal(mailFromAddress('To: x@y.example\r\n\r\nbody'), null)
  })
})

describe('actionLinkFromMail', () => {
  it('finds the link in a quoted-printable message (text and HTML parts agree)', () => {
    assert.equal(actionLinkFromMail(kcMail(), { from: FROM, realmUrl: REALM }), LINK)
  })
  it('finds the link in a base64 message', () => {
    assert.equal(actionLinkFromMail(kcMail({ encoding: 'base64' }), { from: FROM, realmUrl: REALM }), LINK)
  })
  it('refuses a message from any other sender (platform@, another customer)', () => {
    assert.throws(() => actionLinkFromMail(kcMail({ from: 'platform@proof.example.org' }), { from: FROM, realmUrl: REALM }), /sender platform@proof\.example\.org, want kc-proof_x@/)
    assert.throws(() => actionLinkFromMail(kcMail({ from: 'kc-proof_y@proof.example.org' }), { from: FROM, realmUrl: REALM }), /sender kc-proof_y@/)
  })
  it("refuses a link that is not on the customer's own realm URL (Q16: never the apex, never another realm)", () => {
    const apex = LINK.replace('https://rat.proof-x.proof.example.org', 'https://proof.example.org')
    assert.throws(() => actionLinkFromMail(kcMail({ text: `x\n${apex}\n`, html: `<a href="${apex}">x</a>` }), { from: FROM, realmUrl: REALM }), /no execute-actions link under https:\/\/rat\.proof-x/)
    const other = LINK.replace('/realms/proof-x/', '/realms/proof-y/')
    assert.throws(() => actionLinkFromMail(kcMail({ text: `x\n${other}\n`, html: `<a href="${other}">x</a>` }), { from: FROM, realmUrl: REALM }), /no execute-actions link/)
  })
  it('refuses a message whose parts carry two different links', () => {
    const second = LINK.replace('tab_id=Xy_Z-1', 'tab_id=other')
    assert.throws(() => actionLinkFromMail(kcMail({ html: `<a href="${second}">x</a>` }), { from: FROM, realmUrl: REALM }), /2 different execute-actions links/)
  })
  it('refuses a message without any link', () => {
    assert.throws(() => actionLinkFromMail(kcMail({ text: 'nothing', html: '<p>nothing</p>' }), { from: FROM, realmUrl: REALM }), /no execute-actions link/)
  })
})

describe('msUntilFreshTotpStep', () => {
  it('waits for the next 30 s step when the code was already used in this one', () => {
    const now = 1_790_811_490_000 // 10 s into a step (1_790_811_480_000 is a step boundary)
    const used = now - 5_000
    assert.equal(msUntilFreshTotpStep(used, now), 20_000 + 1_000)
  })
  it('does not wait when the last use was in an earlier step', () => {
    const now = 1_790_811_480_000
    assert.equal(msUntilFreshTotpStep(now - 31_000, now), 0)
    assert.equal(msUntilFreshTotpStep(null, now), 0)
  })
  it('the fresh step yields a different code', () => {
    const key = Buffer.from('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'utf8')
    const now = 1_790_811_490_000
    assert.notEqual(totp(key, now), totp(key, now + msUntilFreshTotpStep(now - 1_000, now)))
  })
})
