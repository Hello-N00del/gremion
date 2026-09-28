/**
 * ORIGIN must be an absolute URL — at boot, and at every dispatch.
 *
 * ORIGIN is the public root every link in a rendered newsletter is built from,
 * including the UNSUBSCRIBE link, which carries legal weight (GDPR/CAN-SPAM).
 * `dispatch.ts` builds it as `${origin}/newsletter/unsubscribe?token=…`, so an
 * unset origin does not produce "no link": it produces the host-RELATIVE string
 * `/newsletter/unsubscribe?token=…`, which a mail client resolves against ITS
 * OWN host (https://mail.google.com/newsletter/unsubscribe?…). That is strictly
 * worse than the historical `http://localhost:3000` default it replaced — that
 * one failed visibly with a connection refused; this one looks live, lands on
 * the wrong host, and can trip phishing heuristics.
 *
 * ORIGIN is NOT declared for newsletter-service in docker-compose.yml, so the
 * unconfigured path is the DEPLOYED path, and before this guard the only signal
 * anywhere was a single boot-time console.warn while every subsequent send
 * proceeded silently.
 *
 * POST-CONDITIONS pinned here:
 *   1. BOOT FAILS CLOSED — `requireAbsoluteOrigin` throws on anything that is
 *      not an absolute http(s) URL, and src/index.ts resolves process.env.ORIGIN
 *      through it (no `?? ''`, no `?? 'http://localhost:3000'` left).
 *   2. DISPATCH REFUSES — a dispatch handed a non-absolute origin refuses
 *      BEFORE anything is claimed, rendered or mailed, and error-logs naming the
 *      tenant and the newsletter.
 *   3. A valid absolute origin is NOT refused (the guard is a gate, not a wall).
 *
 * PG-free: the refusal fires before the first sql use, so the stubs below never
 * need to behave like a database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatch, requireAbsoluteOrigin, type DispatchDeps } from '../src/dispatch.ts'
// Namespace import ON PURPOSE: `resolveLinkBase` is the seam this round adds,
// and a NAMED import of a missing export is an ESM link error that takes the
// whole file down with it. Reached through the namespace, its absence fails as
// an ASSERTION in the one describe that needs it — a guard that can go RED for
// the right reason instead of failing to load.
import * as dispatchModule from '../src/dispatch.ts'
import type { KernelClient } from '../src/kernel-client.ts'
import type { TenantRef, Sql } from '../src/tenant-store.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INDEX_TS = path.join(__dirname, '..', 'src', 'index.ts')

const TENANT: TenantRef = { id: '11111111-1111-1111-1111-111111111111', slug: 'demo' }

/**
 * A sql handle that proves the guard let the call through: reaching it at all
 * throws this marker, so "rejected with MARKER" means dispatch got PAST the
 * origin gate, and "rejected with the ORIGIN message" means it did not.
 */
const MARKER = 'SQL-REACHED-PAST-THE-ORIGIN-GATE'
function markerSql(): Sql {
  return (() => {
    throw new Error(MARKER)
  }) as unknown as Sql
}

let sent: number
function deps(origin: string): DispatchDeps {
  sent = 0
  return {
    sql: markerSql(),
    kernel: {
      render: async () => '<html><body>x</body></html>',
      resolveGroup: async () => [],
      sendMail: async () => ({ messageId: 'never' }),
    } as unknown as KernelClient,
    transport: {
      sendMail: async () => {
        sent += 1
        return { messageId: 'never' }
      },
    },
    origin,
  }
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

describe('requireAbsoluteOrigin — the boot guard', () => {
  it('refuses an unset ORIGIN', () => {
    expect(() => requireAbsoluteOrigin(undefined, 'boot')).toThrow(/ORIGIN/)
  })

  it('refuses an empty ORIGIN', () => {
    expect(() => requireAbsoluteOrigin('', 'boot')).toThrow(/absolute/)
  })

  it('refuses a host-relative ORIGIN (the shape that mails a broken link)', () => {
    expect(() => requireAbsoluteOrigin('/newsletter', 'boot')).toThrow(/absolute/)
  })

  it('refuses a bare host with no scheme', () => {
    expect(() => requireAbsoluteOrigin('news.example.org', 'boot')).toThrow(/absolute/)
  })

  it('refuses a non-http(s) scheme', () => {
    expect(() => requireAbsoluteOrigin('ftp://news.example.org', 'boot')).toThrow(/absolute/)
  })

  it('accepts an absolute http(s) ORIGIN and strips the trailing slash', () => {
    expect(requireAbsoluteOrigin('https://news.example.org/', 'boot')).toBe(
      'https://news.example.org',
    )
    expect(requireAbsoluteOrigin('http://localhost:3000', 'boot')).toBe('http://localhost:3000')
  })
})

describe('requireAbsoluteOrigin — it returns an ORIGIN, not the raw string', () => {
  it('normalises scheme and host case', () => {
    expect(
      requireAbsoluteOrigin('HTTPS://News.Example.ORG', 'boot'),
      'the value is concatenated into every link in every mail; returning the raw string ' +
        'means two deployments differing only in case build two different unsubscribe URLs',
    ).toBe('https://news.example.org')
  })

  it('refuses a path, so no link is ever built from a doubled prefix', () => {
    expect(() => requireAbsoluteOrigin('https://news.example.org/app', 'boot')).toThrow(
      /absolute/,
    )
  })

  it('refuses a query string or a fragment', () => {
    expect(() => requireAbsoluteOrigin('https://news.example.org/?a=1', 'boot')).toThrow(/absolute/)
    expect(() => requireAbsoluteOrigin('https://news.example.org/#x', 'boot')).toThrow(/absolute/)
  })

  it('refuses embedded credentials', () => {
    expect(
      () => requireAbsoluteOrigin('https://user:pass@news.example.org', 'boot'),
      'userinfo in a link base mails credentials to every subscriber and is a stock phishing ' +
        'shape (https://real.example.org@attacker.test)',
    ).toThrow(/absolute/)
  })

  it('refuses a protocol-relative origin', () => {
    expect(() => requireAbsoluteOrigin('//news.example.org', 'boot')).toThrow(/absolute/)
  })

  it('refuses whitespace and newlines instead of quietly trimming them', () => {
    expect(
      () => requireAbsoluteOrigin(' https://news.example.org ', 'boot'),
      'trimming hides the misconfiguration; a newline in a value that ends up in a header is ' +
        'an injection primitive',
    ).toThrow(/absolute/)
    expect(() => requireAbsoluteOrigin('https://news.example.org\n', 'boot')).toThrow(/absolute/)
    expect(() => requireAbsoluteOrigin('https://news .example.org', 'boot')).toThrow(/absolute/)
  })
})

describe('the link base is ORIGIN ?? PUBLIC_BASE_URL', () => {
  /**
   * ORIGIN is provisioned NOWHERE: not in the newsletter-service block of
   * docker-compose.yml, not in docker-compose.prod/override/smoke, not in
   * k8s/base/newsletter/configmap.yaml, not in .env.example. A boot guard that
   * requires ORIGIN alone is therefore a guaranteed crash-loop on the next
   * deploy (`restart: unless-stopped`). PUBLIC_BASE_URL *is* provisioned in
   * both compose and the k8s configmap, and is exactly this value.
   */
  const resolveLinkBase = dispatchModule.resolveLinkBase

  it('exposes a resolver seam the boot path can be tested through', () => {
    expect(
      typeof resolveLinkBase,
      'the fallback must live in a pure, callable function — a boot-only expression can only ' +
        'be tested by booting a server',
    ).toBe('function')
  })

  it('boots on PUBLIC_BASE_URL alone — the value compose and k8s already provide', () => {
    const res = resolveLinkBase({ PUBLIC_BASE_URL: 'https://news.example.org' }, 'boot')
    expect(res.usable).toBe(true)
    expect(res.base).toBe('https://news.example.org')
    expect(res.source, 'the resolver must RECORD which variable supplied the base').toBe(
      'PUBLIC_BASE_URL',
    )
  })

  it('lets ORIGIN override PUBLIC_BASE_URL', () => {
    const res = resolveLinkBase(
      { ORIGIN: 'https://mail.example.org', PUBLIC_BASE_URL: 'https://news.example.org' },
      'boot',
    )
    expect(res.base).toBe('https://mail.example.org')
    expect(res.source, 'ORIGIN wins, and the recorded source must say so').toBe('ORIGIN')
  })

  it('fails closed only when BOTH are missing, and names BOTH variables', () => {
    const res = resolveLinkBase({}, 'boot')
    expect(res.usable, 'an unset link base is not usable').toBe(false)
    const message = res.usable ? '' : res.reason
    expect(message, 'an unset link base must still be reported').not.toBe('')
    expect(message, 'the operator must be told about ORIGIN').toContain('ORIGIN')
    expect(
      message,
      'and about PUBLIC_BASE_URL — it is the one of the two that is actually provisioned, so ' +
        'an error naming only ORIGIN sends the operator to add an env key nothing else uses',
    ).toContain('PUBLIC_BASE_URL')
  })

  it('fails closed when the only value present is not absolute', () => {
    const a = resolveLinkBase({ PUBLIC_BASE_URL: '/newsletter' }, 'boot')
    expect(a.usable).toBe(false)
    expect(a.usable ? '' : a.reason).toMatch(/absolute/)
    const b = resolveLinkBase({ ORIGIN: 'news.example.org' }, 'boot')
    expect(b.usable).toBe(false)
    expect(b.usable ? '' : b.reason).toMatch(/absolute/)
  })
})

describe('boot — the leaf starts only with an absolute link base', () => {
  const source = fs.readFileSync(INDEX_TS, 'utf8')

  it('resolves the link base through the fail-closed resolver', () => {
    expect(
      source,
      'src/index.ts must resolve the link base through resolveLinkBase(process.env, …), not a ' +
        'bare env read',
    ).toMatch(/resolveLinkBase\(process\.env/)
  })

  it('keeps no silent fallback for an unset link base', () => {
    expect(
      source,
      "`process.env.ORIGIN ?? ''` boots a leaf that can only mail host-relative unsubscribe links",
    ).not.toMatch(/process\.env\.ORIGIN\s*\?\?\s*''/)
    expect(
      source,
      'the localhost default mailed http://localhost:3000 links to real subscribers',
    ).not.toContain('localhost:3000')
    const rawReads = source.match(/process\.env\.(ORIGIN|PUBLIC_BASE_URL)/g) ?? []
    expect(
      rawReads,
      'index.ts must hold NO raw read of either variable — the resolver owns both, so a ' +
        'second fallback cannot be reintroduced beside it',
    ).toHaveLength(0)
  })
})

describe('dispatch — refuses a non-absolute unsubscribe URL', () => {
  it('refuses an empty origin before anything is claimed or mailed', async () => {
    await expect(dispatch(TENANT, 42, 'actor', deps(''))).rejects.toThrow(/ORIGIN must be/)
    expect(sent, 'not one recipient may be mailed a host-relative unsubscribe link').toBe(0)
  })

  it('refuses a host-relative origin', async () => {
    await expect(dispatch(TENANT, 42, 'actor', deps('/newsletter'))).rejects.toThrow(/absolute/)
    expect(sent).toBe(0)
  })

  it('error-logs the refusal naming the tenant and the newsletter', async () => {
    await expect(dispatch(TENANT, 42, 'actor', deps(''))).rejects.toThrow()

    const messages = errorSpy.mock.calls.map((c: unknown[]) => c.map(String).join(' '))
    const refusal = messages.find((m: string) => m.includes('REFUSING'))
    expect(
      refusal,
      `the refusal must be logged, not only thrown; saw: ${JSON.stringify(messages)}`,
    ).toBeDefined()
    expect(refusal, 'the log must name the newsletter').toContain('#42')
    expect(refusal, 'the log must name the tenant').toContain('demo')
  })

  it('does NOT refuse a valid absolute origin', async () => {
    // Reaching the sql handle at all proves the gate opened; the marker is the
    // first thing dispatch touches after the guard.
    await expect(dispatch(TENANT, 42, 'actor', deps('https://news.example.org'))).rejects.toThrow(
      MARKER,
    )
  })
})

/**
 * ────────────────────────────────────────────────────────────────────────────
 * T05R5 — a SYNTACTICALLY VALID link base can still be unmailable.
 *
 * Round 4 accepted PUBLIC_BASE_URL because it parsed. Both provisioned defaults
 * in this repo are `http://localhost:3000` (docker-compose.yml's newsletter
 * block and k8s/base/newsletter/configmap.yaml), so the round-4 guard opened the
 * gate on exactly the value the deployment ships — and mailed
 * `http://localhost:3000/newsletter/unsubscribe?token=…` to real subscribers.
 * In a recipient's mail client that link resolves to THEIR machine.
 *
 * POST-CONDITIONS pinned here:
 *   1. The three unmailable host classes — LOOPBACK, UNSPECIFIED, LINK-LOCAL —
 *      are refused, and the refusal names the class.
 *   2. Boot does NOT crash on one: the leaf reports it and keeps serving; the
 *      refusal lands at dispatch(), before any transport call.
 *   3. NEWSLETTER_ALLOW_LOOPBACK_LINKS=1 unlocks LOOPBACK ONLY, and says so.
 *   4. A real public base is usable and its SOURCE is recorded.
 */
describe('classifyLinkHost — the three unmailable host classes', () => {
  const classify = dispatchModule.classifyLinkHost

  it('is exported as a callable seam', () => {
    expect(typeof classify).toBe('function')
  })

  it('names loopback hosts', () => {
    expect(classify('localhost')).toBe('loopback')
    expect(classify('LOCALHOST')).toBe('loopback')
    expect(classify('api.localhost')).toBe('loopback')
    expect(classify('127.0.0.1')).toBe('loopback')
    expect(classify('127.10.0.9')).toBe('loopback')
    expect(classify('[::1]')).toBe('loopback')
  })

  it('names the unspecified address', () => {
    expect(classify('0.0.0.0')).toBe('unspecified')
    expect(classify('[::]')).toBe('unspecified')
  })

  it('names link-local hosts', () => {
    expect(classify('169.254.10.5')).toBe('link-local')
    expect(classify('[fe80::1]')).toBe('link-local')
    expect(classify('[FE80::abcd]')).toBe('link-local')
  })

  it('lets a real public host through', () => {
    expect(classify('example.org')).toBeNull()
    expect(classify('news.example.org')).toBeNull()
    expect(classify('10.0.0.4'), 'a private LAN address is reachable from a LAN mail client').toBeNull()
  })
})

describe('resolveLinkBase — the deployed localhost default is UNUSABLE, and boot survives it', () => {
  const resolveLinkBase = dispatchModule.resolveLinkBase

  it('refuses the compose/k8s default and names both variables AND the value', () => {
    const res = resolveLinkBase({ PUBLIC_BASE_URL: 'http://localhost:3000' }, 'boot')
    expect(
      res.usable,
      'this is the value docker-compose.yml and k8s/base/newsletter/configmap.yaml actually ' +
        'provision — accepting it mails localhost links to every subscriber',
    ).toBe(false)
    const reason = res.usable ? '' : res.reason
    expect(reason, 'the operator must be told about ORIGIN').toContain('ORIGIN')
    expect(reason, 'and about PUBLIC_BASE_URL — the one that is actually provisioned').toContain(
      'PUBLIC_BASE_URL',
    )
    expect(reason, 'and shown the offending value').toContain('http://localhost:3000')
    expect(reason, 'and told which host class it fell into').toContain('loopback')
    expect(res.usable ? null : res.fault).toBe('loopback')
  })

  it('never throws — a crash-loop under `restart: unless-stopped` is not a guard', () => {
    for (const env of [
      {},
      { PUBLIC_BASE_URL: 'http://localhost:3000' },
      { ORIGIN: '/relative' },
      { ORIGIN: 'http://0.0.0.0:8080' },
      { PUBLIC_BASE_URL: 'http://169.254.1.1' },
    ]) {
      expect(() => resolveLinkBase(env, 'boot')).not.toThrow()
    }
  })

  it('unlocks LOOPBACK — and only loopback — behind NEWSLETTER_ALLOW_LOOPBACK_LINKS', () => {
    const on = resolveLinkBase(
      { PUBLIC_BASE_URL: 'http://localhost:3000', NEWSLETTER_ALLOW_LOOPBACK_LINKS: '1' },
      'boot',
    )
    expect(on.usable, 'the dev override must unlock a loopback base').toBe(true)
    expect(on.base).toBe('http://localhost:3000')
    expect(on.usable && on.loopbackOverride, 'the override must be visible on the resolution').toBe(
      true,
    )

    for (const bad of ['http://0.0.0.0:8080', 'http://169.254.1.1', 'http://[fe80::1]']) {
      const res = resolveLinkBase(
        { PUBLIC_BASE_URL: bad, NEWSLETTER_ALLOW_LOOPBACK_LINKS: '1' },
        'boot',
      )
      expect(
        res.usable,
        `${bad} is not a loopback address — the loopback override must not unlock it`,
      ).toBe(false)
    }
  })

  it('accepts a real public base and records where it came from', () => {
    const res = resolveLinkBase({ PUBLIC_BASE_URL: 'https://example.org' }, 'boot')
    expect(res.usable).toBe(true)
    expect(res.base).toBe('https://example.org')
    expect(res.source).toBe('PUBLIC_BASE_URL')
    expect(res.usable && res.loopbackOverride).toBe(false)

    const overridden = resolveLinkBase(
      { ORIGIN: 'https://mail.example.org', PUBLIC_BASE_URL: 'https://example.org' },
      'boot',
    )
    expect(overridden.base, 'ORIGIN wins').toBe('https://mail.example.org')
    expect(overridden.source).toBe('ORIGIN')
  })
})

describe('logLinkBaseResolution — ONE line, on the right channel', () => {
  const { resolveLinkBase, logLinkBaseResolution } = dispatchModule

  function sink(): { errors: string[]; warns: string[]; infos: string[] } {
    return { errors: [], warns: [], infos: [] }
  }
  function logger(s: ReturnType<typeof sink>) {
    return {
      error: (m: string) => s.errors.push(m),
      warn: (m: string) => s.warns.push(m),
      info: (m: string) => s.infos.push(m),
    }
  }

  it('logs exactly ONE error for an unusable base and does not throw', () => {
    const s = sink()
    expect(() =>
      logLinkBaseResolution(
        resolveLinkBase({ PUBLIC_BASE_URL: 'http://localhost:3000' }, 'boot'),
        logger(s),
      ),
    ).not.toThrow()
    expect(s.errors, `one error, not a stream; saw ${JSON.stringify(s.errors)}`).toHaveLength(1)
    expect(s.errors[0]).toContain('PUBLIC_BASE_URL')
    expect(s.errors[0]).toContain('http://localhost:3000')
    expect(s.warns).toHaveLength(0)
  })

  it('warns — not errors — when the loopback override is what let it through', () => {
    const s = sink()
    logLinkBaseResolution(
      resolveLinkBase(
        { PUBLIC_BASE_URL: 'http://localhost:3000', NEWSLETTER_ALLOW_LOOPBACK_LINKS: '1' },
        'boot',
      ),
      logger(s),
    )
    expect(s.errors).toHaveLength(0)
    expect(s.warns).toHaveLength(1)
    expect(s.warns[0]).toContain('NEWSLETTER_ALLOW_LOOPBACK_LINKS')
  })

  it('records the SOURCE on the happy path', () => {
    const s = sink()
    logLinkBaseResolution(resolveLinkBase({ PUBLIC_BASE_URL: 'https://example.org' }, 'boot'), logger(s))
    expect(s.errors).toHaveLength(0)
    expect(s.warns).toHaveLength(0)
    expect(s.infos).toHaveLength(1)
    expect(s.infos[0]).toContain('https://example.org')
    expect(s.infos[0], 'which variable supplied it is the fact an operator needs').toContain(
      'PUBLIC_BASE_URL',
    )
  })
})

describe('dispatch — an unmailable link base refuses BEFORE the transport', () => {
  it('throws LinkBaseUnusableError on the deployed localhost default, mailing nobody', async () => {
    const d = deps('http://localhost:3000')
    await expect(dispatch(TENANT, 42, 'actor', d)).rejects.toBeInstanceOf(
      dispatchModule.LinkBaseUnusableError,
    )
    expect(sent, 'not one recipient may be mailed a localhost unsubscribe link').toBe(0)
  })

  it('refuses unspecified and link-local bases too', async () => {
    for (const bad of ['http://0.0.0.0:8080', 'http://169.254.1.1', 'http://[fe80::1]']) {
      await expect(dispatch(TENANT, 42, 'actor', deps(bad))).rejects.toBeInstanceOf(
        dispatchModule.LinkBaseUnusableError,
      )
      expect(sent).toBe(0)
    }
  })

  it('opens the gate for loopback when the dispatch is told the override is on', async () => {
    const d = { ...deps('http://localhost:3000'), allowLoopbackLinks: true }
    // Reaching the sql handle at all proves the gate opened.
    await expect(dispatch(TENANT, 42, 'actor', d)).rejects.toThrow(MARKER)
  })

  it('keeps unspecified and link-local shut even with the loopback override on', async () => {
    const d = { ...deps('http://0.0.0.0:8080'), allowLoopbackLinks: true }
    await expect(dispatch(TENANT, 42, 'actor', d)).rejects.toBeInstanceOf(
      dispatchModule.LinkBaseUnusableError,
    )
    expect(sent).toBe(0)
  })
})

describe('boot — the leaf REPORTS an unusable link base instead of crash-looping', () => {
  const source = fs.readFileSync(INDEX_TS, 'utf8')

  it('routes the boot report through logLinkBaseResolution', () => {
    expect(
      source,
      'the boot log must be the tested function, not an ad-hoc console.error beside it — ' +
        '"logs ONE error" is only assertable when the logging is a seam',
    ).toMatch(/logLinkBaseResolution\(/)
  })

  it('hands dispatch the loopback override decision instead of re-reading the env', () => {
    expect(
      source,
      'dispatch must be TOLD whether the override is on; a second env read beside the resolver ' +
        'is exactly the duplicated fallback this file already forbids',
    ).toMatch(/allowLoopbackLinks/)
    expect(source).not.toMatch(/process\.env\.NEWSLETTER_ALLOW_LOOPBACK_LINKS/)
  })
})
