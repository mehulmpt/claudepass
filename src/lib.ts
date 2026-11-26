import { z } from 'zod'
import { OddsLadder } from './schemas.ts'

/**
 * Pure helpers: no bindings, so they are easy to unit test.
 */

/**
 * Collapse a client IP into the key we rate-limit on.
 * - IPv4: the full address.
 * - IPv4-mapped IPv6 (::ffff:1.2.3.4): treated as the IPv4 address.
 * - IPv6: the /64 prefix. ISPs hand a whole /64 (or more) to one subscriber,
 *   so limiting per full IPv6 address would let anyone rotate through 2^64 tries.
 */
export function ipKey(ip: string): string | null {
	ip = ip.trim()
	if (isIPv4(ip)) return `v4:${ip}`
	const groups = expandIPv6(ip)
	if (!groups) return null
	// ::ffff:a.b.c.d
	if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
		const v4 = [
			groups[6] >> 8,
			groups[6] & 0xff,
			groups[7] >> 8,
			groups[7] & 0xff,
		].join('.')
		return `v4:${v4}`
	}
	return `v6:${groups
		.slice(0, 4)
		.map((g) => g.toString(16).padStart(4, '0'))
		.join(':')}::/64`
}

function isIPv4(ip: string): boolean {
	const parts = ip.split('.')
	return (
		parts.length === 4 &&
		parts.every(
			(p) =>
				/^\d{1,3}$/.test(p) &&
				Number(p) <= 255 &&
				String(Number(p)) === p,
		)
	)
}

/** Expand an IPv6 address into 8 numeric groups, or null if it is not valid. */
export function expandIPv6(ip: string): number[] | null {
	ip = ip.split('%')[0] // drop zone id
	if (!/^[0-9a-fA-F:.]+$/.test(ip)) return null

	// Trailing embedded IPv4 (e.g. ::ffff:1.2.3.4) becomes two groups.
	const lastColon = ip.lastIndexOf(':')
	const tail = ip.slice(lastColon + 1)
	if (tail.includes('.')) {
		if (!isIPv4(tail)) return null
		const o = tail.split('.').map(Number)
		ip = `${ip.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
	}

	const halves = ip.split('::')
	if (halves.length > 2) return null
	const parse = (s: string) => (s === '' ? [] : s.split(':'))
	const head = parse(halves[0])
	const rest = halves.length === 2 ? parse(halves[1]) : []
	const missing = 8 - head.length - rest.length
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null

	const all = [
		...head,
		...Array(halves.length === 2 ? missing : 0).fill('0'),
		...rest,
	]
	if (all.length !== 8 || !all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g)))
		return null
	return all.map((g) => parseInt(g, 16))
}

export type EmailCheck =
	| { ok: true; address: string; canonical: string }
	| { ok: false; error: string }

const EmailAddress = z.string().trim().pipe(z.email())

/**
 * Validate an email and derive a canonical form used for "one pass per inbox":
 * lowercase, +tags stripped, and dots removed for Gmail.
 */
export function checkEmail(raw: string): EmailCheck {
	const parsed = EmailAddress.safeParse(raw)
	if (!parsed.success) {
		return {
			ok: false,
			error: "That doesn't look like a valid email address.",
		}
	}
	const address = parsed.data
	let [local, domain] = splitEmail(address.toLowerCase())
	local = local.split('+')[0]
	if (domain === 'googlemail.com') domain = 'gmail.com'
	if (domain === 'gmail.com') local = local.replaceAll('.', '')
	if (!local)
		return {
			ok: false,
			error: "That doesn't look like a valid email address.",
		}
	return { ok: true, address, canonical: `${local}@${domain}` }
}

function splitEmail(e: string): [string, string] {
	const at = e.lastIndexOf('@')
	return [e.slice(0, at), e.slice(at + 1)]
}

/** Uniform float in [0, 1) from the CSPRNG. */
export function secureRandom(): number {
	const buf = new Uint32Array(1)
	crypto.getRandomValues(buf)
	return buf[0] / 2 ** 32
}

export function randomToken(bytes = 32): string {
	const buf = new Uint8Array(bytes)
	crypto.getRandomValues(buf)
	return base64url(buf)
}

export async function sha256(s: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(s),
	)
	return base64url(new Uint8Array(digest))
}

function base64url(buf: Uint8Array): string {
	let bin = ''
	for (const b of buf) bin += String.fromCharCode(b)
	return btoa(bin)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '')
}

const HTML_ESCAPES = new Map([
	['&', '&amp;'],
	['<', '&lt;'],
	['>', '&gt;'],
	['"', '&quot;'],
	["'", '&#39;'],
])

export function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES.get(c) ?? c)
}

/**
 * Odds get harder as passes go. `ladder` is "1 in N" per pass, e.g. [10000, 20000, 100000]:
 * while 0 passes are taken the odds are 1 in 10,000, after 1 is taken 1 in 20,000, and so on.
 * Past the end of the ladder the last value is used.
 */
export function oddsOneIn({
	ladder,
	taken,
}: {
	ladder: number[]
	taken: number
}): number {
	return ladder[Math.min(Math.max(0, taken), ladder.length - 1)]
}

export function parseLadder(raw: string): number[] {
	return OddsLadder.parse(raw)
}

// Big consumer providers: showing these domains reveals nothing about the person.
const COMMON_DOMAINS = new Set([
	'gmail.com',
	'googlemail.com',
	'proton.me',
	'protonmail.com',
	'pm.me',
	'outlook.com',
	'hotmail.com',
	'live.com',
	'msn.com',
	'yahoo.com',
	'ymail.com',
	'icloud.com',
	'me.com',
	'mac.com',
	'aol.com',
	'gmx.com',
	'zoho.com',
	'fastmail.com',
	'hey.com',
	'mail.com',
	'yandex.com',
	'qq.com',
	'163.com',
	'rediffmail.com',
])

/**
 * Public form of a winner's email: the back half of the local part is masked, and
 * the domain is masked down to its TLD unless it is a common provider.
 * "mehulmohan@gmail.com" -> "mehul•••••@gmail.com", "jo@acme.io" -> "j•@••••.io"
 */
export function maskEmail(address: string): string {
	const lower = address.trim().toLowerCase()
	const at = lower.lastIndexOf('@')
	const local = lower.slice(0, at)
	const domain = lower.slice(at + 1)
	const keep = Math.floor(local.length / 2)
	const maskedLocal = local.slice(0, keep) + '•'.repeat(local.length - keep)
	if (COMMON_DOMAINS.has(domain)) return `${maskedLocal}@${domain}`
	const tld = domain.slice(domain.lastIndexOf('.') + 1)
	const rest = domain.length - tld.length - 1
	return `${maskedLocal}@${'•'.repeat(Math.min(Math.max(rest, 3), 8))}.${tld}`
}
