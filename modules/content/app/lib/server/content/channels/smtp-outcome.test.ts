// @vitest-environment node
// R29-LOW-07 L3 (round 2): the outcome classifier is proven against the REAL
// nodemailer transport talking to a local net SMTP stub, not against hand-written
// error shapes. nodemailer stamps command 'CONN' on every socket-level error
// whatever the SMTP phase, so only the real library shows what a stall or a drop
// after the message body ('.') actually looks like.
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import nodemailer from 'nodemailer'
import { isOutcomeUnknown } from './smtp-outcome'

type Mode = 'stall-after-dot' | 'drop-after-dot' | 'drop-after-data-cmd' | 'reject-rcpt' | 'reject-data-end' | 'accept'

const servers: net.Server[] = []

function stub(mode: Mode): Promise<net.Server> {
	return new Promise((resolve) => {
		const srv = net.createServer((s) => {
			s.write('220 stub ESMTP\r\n')
			let inData = false
			let buf = ''
			s.on('data', (d) => {
				buf += d.toString()
				let i: number
				while ((i = buf.indexOf('\r\n')) >= 0) {
					const line = buf.slice(0, i)
					buf = buf.slice(i + 2)
					if (inData) {
						if (line === '.') {
							if (mode === 'drop-after-dot') s.destroy()
							else if (mode === 'reject-data-end') s.write('554 message refused\r\n')
							else if (mode === 'accept') s.write('250 queued\r\n')
							// stall-after-dot: never answer
						}
						continue
					}
					const u = line.toUpperCase()
					if (u.startsWith('EHLO') || u.startsWith('HELO')) s.write('250 ok\r\n')
					else if (u.startsWith('MAIL')) s.write('250 ok\r\n')
					else if (u.startsWith('RCPT')) s.write(mode === 'reject-rcpt' ? '550 no such user\r\n' : '250 ok\r\n')
					else if (u === 'DATA') {
						if (mode === 'drop-after-data-cmd') {
							s.destroy()
							return
						}
						inData = true
						s.write('354 go\r\n')
					} else if (u === 'QUIT') {
						s.write('221 bye\r\n')
						s.end()
					}
				}
			})
			s.on('error', () => {})
		})
		servers.push(srv)
		srv.listen(0, '127.0.0.1', () => resolve(srv))
	})
}

async function sendTo(port: number): Promise<unknown> {
	const transport = nodemailer.createTransport({
		host: '127.0.0.1',
		port,
		secure: false,
		ignoreTLS: true,
		socketTimeout: 800,
		greetingTimeout: 2000,
		connectionTimeout: 2000,
	})
	try {
		await transport.sendMail({ from: 'a@x.de', to: 'b@x.de', subject: 's', html: '<p>h</p>' })
	} catch (err) {
		return err
	} finally {
		transport.close()
	}
	throw new Error('the stub was expected to make the send fail')
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))))
})

describe('isOutcomeUnknown against the real nodemailer transport', () => {
	it('a stall AFTER the message body was handed over (no answer to ".") is UNKNOWN', async () => {
		const srv = await stub('stall-after-dot')
		const err = await sendTo((srv.address() as net.AddressInfo).port)
		expect(isOutcomeUnknown(err)).toBe(true)
	})

	it('a connection DROP after the message body was handed over is UNKNOWN', async () => {
		const srv = await stub('drop-after-dot')
		const err = await sendTo((srv.address() as net.AddressInfo).port)
		expect(isOutcomeUnknown(err)).toBe(true)
	})

	it('a drop right after the DATA command (body possibly in flight) is UNKNOWN (conservative)', async () => {
		const srv = await stub('drop-after-data-cmd')
		const err = await sendTo((srv.address() as net.AddressInfo).port)
		expect(isOutcomeUnknown(err)).toBe(true)
	})

	it('a refused connection (nothing listening) is DEFINITIVE', async () => {
		const srv = await stub('accept')
		const port = (srv.address() as net.AddressInfo).port
		await new Promise((r) => srv.close(() => r(undefined)))
		const err = await sendTo(port)
		expect(isOutcomeUnknown(err)).toBe(false)
	})

	it('a 550 rejection of the recipient is DEFINITIVE', async () => {
		const srv = await stub('reject-rcpt')
		const err = await sendTo((srv.address() as net.AddressInfo).port)
		expect(isOutcomeUnknown(err)).toBe(false)
	})

	it('a 554 rejection of the message at the end of DATA is DEFINITIVE', async () => {
		const srv = await stub('reject-data-end')
		const err = await sendTo((srv.address() as net.AddressInfo).port)
		expect(isOutcomeUnknown(err)).toBe(false)
	})
})

describe('isOutcomeUnknown on the other nodemailer shapes', () => {
	const e = (over: Record<string, unknown>) => Object.assign(new Error('x'), over)

	it('a call on an already destroyed connection (ECONNECTION, command API) is DEFINITIVE', () => {
		expect(isOutcomeUnknown(e({ code: 'ECONNECTION', command: 'API' }))).toBe(false)
	})

	it('a connection or greeting timeout (the session never started) is DEFINITIVE', () => {
		expect(isOutcomeUnknown(e({ code: 'ETIMEDOUT', command: 'CONN', message: 'Connection timeout' }))).toBe(false)
		expect(isOutcomeUnknown(e({ code: 'ETIMEDOUT', command: 'CONN', message: 'Greeting never received' }))).toBe(false)
	})

	it('a socket error from the connect syscall (EHOSTUNREACH) is DEFINITIVE', () => {
		expect(isOutcomeUnknown(e({ code: 'ESOCKET', command: 'CONN', syscall: 'connect', errno: 'EHOSTUNREACH' }))).toBe(false)
	})

	it('a socket reset mid-session (ECONNRESET on read) is UNKNOWN', () => {
		expect(isOutcomeUnknown(e({ code: 'ESOCKET', command: 'CONN', syscall: 'read', errno: 'ECONNRESET' }))).toBe(true)
	})

	it('non-transport errors and non-errors are DEFINITIVE', () => {
		expect(isOutcomeUnknown(e({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }))).toBe(false)
		expect(isOutcomeUnknown(e({ code: 'EAUTH' }))).toBe(false)
		expect(isOutcomeUnknown(new Error('smtp-unconfigured'))).toBe(false)
		expect(isOutcomeUnknown('boom')).toBe(false)
	})
})
