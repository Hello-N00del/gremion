#!/usr/bin/env node
// TASK-015 scratch helper: one SMTP submission session, reporting the reply
// CODE of each step as JSON, so scratch-stalwart.sh asserts 235/535/5.7.1 on
// what the server said, not on a client's exit status.
//
//   SMTP_PROBE_PASSWORD=... node smtp-probe.mjs --host H --port P --user U
//        [--mail-from A] [--rcpt B] [--header-from C]
//
// The password is read from the environment, never from argv. STARTTLS is
// mandatory (the submission listener offers AUTH only over TLS); the scratch
// server's certificate is self-signed, so this helper -- and only this
// scratch helper -- does not verify it.
import net from 'node:net'
import tls from 'node:tls'

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`)
  return i > 0 ? process.argv[i + 1] : undefined
}
const host = arg('host')
const port = Number(arg('port'))
const user = arg('user')
const mailFrom = arg('mail-from')
const rcpt = arg('rcpt')
const headerFrom = arg('header-from')
const password = process.env.SMTP_PROBE_PASSWORD ?? ''

function session(sock) {
  let buf = ''
  let waiter = null
  const onData = (d) => {
    buf += d.toString('utf8')
    pump()
  }
  const pump = () => {
    if (!waiter) return
    const lines = buf.split('\r\n')
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const reply = lines.slice(0, i + 1).join('\n')
        buf = lines.slice(i + 1).join('\r\n')
        const w = waiter
        waiter = null
        w({ code: Number(lines[i].slice(0, 3)), text: reply })
        return
      }
    }
  }
  sock.on('data', onData)
  return {
    read: () => new Promise((res) => ((waiter = res), pump())),
    send: (line) => sock.write(`${line}\r\n`),
    detach: () => sock.off('data', onData),
  }
}

// --repeat N: N whole sessions in one process (the auth-failure probe),
// reported as a histogram of AUTH reply codes.
const repeat = Number(arg('repeat') ?? 1)

async function once() {
const out = {}
let timer
const timeout = new Promise((res) => {
  timer = setTimeout(() => res('timeout'), repeat > 1 ? 8000 : 20000)
})
const work = (async () => {
try {
  const raw = net.connect({ host, port })
  await new Promise((res, rej) => raw.once('connect', res).once('error', rej))
  let s = session(raw)
  out.greeting = (await s.read()).code
  s.send('EHLO probe.example.net')
  await s.read()
  s.send('STARTTLS')
  out.starttls = (await s.read()).code
  s.detach()
  const sock = tls.connect({ socket: raw, servername: 'mail.example.org', rejectUnauthorized: false })
  await new Promise((res, rej) => sock.once('secureConnect', res).once('error', rej))
  s = session(sock)
  s.send('EHLO probe.example.net')
  await s.read()
  s.send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString('base64')}`)
  const auth = await s.read()
  out.auth = auth.code
  out.authText = auth.text.replace(/\n/g, ' ')
  if (auth.code === 235 && mailFrom) {
    s.send(`MAIL FROM:<${mailFrom}>`)
    const r = await s.read()
    out.mailFrom = r.code
    out.mailFromText = r.text.replace(/\n/g, ' ')
    if (r.code === 250 && rcpt) {
      s.send(`RCPT TO:<${rcpt}>`)
      const q = await s.read()
      out.rcpt = q.code
      out.rcptText = q.text.replace(/\n/g, ' ')
      if (q.code === 250 && headerFrom) {
        s.send('DATA')
        out.dataStart = (await s.read()).code
        s.send(`From: ${headerFrom}\r\nTo: ${rcpt}\r\nSubject: t015 scratch probe\r\nMessage-ID: <t015-${Date.now()}@example.org>\r\n\r\nscratch probe\r\n.`)
        const d = await s.read()
        out.data = d.code
        out.dataText = d.text.replace(/\n/g, ' ')
      }
    }
  }
  s.send('QUIT')
  sock.end()
} catch (e) {
  out.error = e.code ?? e.message
}
})()
if ((await Promise.race([work, timeout])) === 'timeout') out.error = 'timeout'
clearTimeout(timer)
return out
}

if (repeat > 1) {
  // Stops early once three sessions in a row did not even reach a 535: the
  // source is banned (or the server gone), and waiting out every timeout
  // would only measure the timeout.
  const hist = {}
  let attempts = 0
  let streak = 0
  let firstNon535 = null
  for (let i = 0; i < repeat && streak < 3; i++) {
    // under the server's per-IP connection rate limit ([5, 1000ms] measured)
    if (i) await new Promise((res) => setTimeout(res, 250))
    const r = await once()
    attempts++
    const k = r.auth ?? r.error ?? 'none'
    hist[k] = (hist[k] ?? 0) + 1
    if (k === 535) streak = 0
    else {
      streak++
      firstNon535 ??= attempts
    }
  }
  console.log(JSON.stringify({ repeat, attempts, firstNon535, auth: hist }))
} else {
  console.log(JSON.stringify(await once()))
}
process.exit(0)
