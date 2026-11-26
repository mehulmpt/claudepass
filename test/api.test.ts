import { env, SELF, applyD1Migrations } from 'cloudflare:test'
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vite-plus/test'
import { z } from 'zod'
import { oddsOneIn, parseLadder, randomToken, sha256 } from '../src/lib.ts'
import { DONORS } from '../src/page.ts'

const ORIGIN = 'https://claudepass.mehulmohan.com'
const TEST_IP = '198.51.100.250'
const TOTAL = Number(env.TOTAL_PASSES)

// Each test uses fresh IPs so the per-network rate limiter never interferes.
let ipCounter = 0
const nextIp = () => `203.0.113.${++ipCounter}`

function api({
	path,
	ip,
	body,
	origin = ORIGIN,
}: {
	path: string
	ip: string
	body?: unknown
	origin?: string
}) {
	return SELF.fetch(`${ORIGIN}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: {
			'cf-connecting-ip': ip,
			origin,
			'content-type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

const PlayResult = z.object({
	won: z.boolean().optional(),
	test: z.boolean().optional(),
	token: z.string().optional(),
	error: z.string().optional(),
})
const Count = z.object({ n: z.number() })

async function count(sql: string): Promise<number> {
	return Count.parse(await env.DB.prepare(sql).first()).n
}

/** Fake siteverify. `success` controls whether the bot check passes. */
function mockTurnstile({ success }: { success: boolean }) {
	const realFetch = globalThis.fetch
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const url = input instanceof Request ? input.url : String(input)
		if (url.includes('challenges.cloudflare.com/turnstile')) {
			return Response.json({
				success,
				hostname: 'claudepass.mehulmohan.com',
				action: 'play',
			})
		}
		return realFetch(input, init)
	})
}

/** Force the draw: the roll is the only 1-element Uint32Array the worker asks for. */
function forceRoll({ win }: { win: boolean }) {
	const real = crypto.getRandomValues.bind(crypto)
	vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
		if (array instanceof Uint32Array && array.length === 1) {
			array[0] = win ? 0 : 0xffffffff
			return array
		}
		return real(array)
	})
}

async function play({ ip }: { ip: string }) {
	const res = await api({ path: '/api/play', ip, body: { turnstile: 'tok' } })
	return { status: res.status, data: PlayResult.parse(await res.json()) }
}

async function claim({
	ip,
	token,
	email,
}: {
	ip: string
	token: string
	email: string
}) {
	const res = await api({ path: '/api/claim', ip, body: { token, email } })
	return {
		status: res.status,
		data: z.record(z.string(), z.unknown()).parse(await res.json()),
	}
}

/** Insert a reservation directly, returning the plaintext token. */
async function reserve({ expiresIn = 300 }: { expiresIn?: number } = {}) {
	const token = randomToken()
	const t = Math.floor(Date.now() / 1000)
	await env.DB.prepare(
		'INSERT INTO claims (token_hash, ip_key, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)',
	)
		.bind(await sha256(token), `v4:${nextIp()}`, t, t + expiresIn)
		.run()
	return token
}

beforeAll(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM claims'),
		env.DB.prepare('DELETE FROM plays'),
		env.DB.prepare('DELETE FROM ip_limits'),
		env.DB.prepare('DELETE FROM counters'),
	])
	mockTurnstile({ success: true })
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('claiming', () => {
	it('rejects made-up tokens', async () => {
		const r = await claim({
			ip: nextIp(),
			token: randomToken(),
			email: 'a@example.com',
		})
		expect(r.status).toBe(400)
		expect(
			await count(
				'SELECT COUNT(*) n FROM claims WHERE redeemed_at IS NOT NULL',
			),
		).toBe(0)
	})

	it('redeems a real reservation exactly once', async () => {
		const token = await reserve()
		expect(
			(await claim({ ip: nextIp(), token, email: 'a@example.com' }))
				.status,
		).toBe(200)
		const again = await claim({
			ip: nextIp(),
			token,
			email: 'b@example.com',
		})
		expect(again.status).toBe(409)
		expect(
			await count(
				'SELECT COUNT(*) n FROM claims WHERE redeemed_at IS NOT NULL',
			),
		).toBe(1)
	})

	it('lets only one of many concurrent claims on the same token win', async () => {
		const token = await reserve()
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				claim({ ip: nextIp(), token, email: `racer${i}@example.com` }),
			),
		)
		expect(results.filter((r) => r.status === 200)).toHaveLength(1)
		expect(
			await count(
				'SELECT COUNT(*) n FROM claims WHERE redeemed_at IS NOT NULL',
			),
		).toBe(1)
	})

	it('rejects an expired reservation', async () => {
		const token = await reserve({ expiresIn: -1 })
		expect(
			(await claim({ ip: nextIp(), token, email: 'a@example.com' }))
				.status,
		).toBe(410)
	})

	it('gives one pass per inbox, ignoring gmail dots and +tags', async () => {
		const first = await reserve()
		const second = await reserve()
		expect(
			(
				await claim({
					ip: nextIp(),
					token: first,
					email: 'jane.doe@gmail.com',
				})
			).status,
		).toBe(200)
		const dup = await claim({
			ip: nextIp(),
			token: second,
			email: 'JaneDoe+x@googlemail.com',
		})
		expect(dup.status).toBe(409)
	})

	it('requires the site origin', async () => {
		const token = await reserve()
		const res = await api({
			path: '/api/claim',
			ip: nextIp(),
			origin: 'https://evil.example',
			body: { token, email: 'a@example.com' },
		})
		expect(res.status).toBe(403)
	})
})

describe('playing', () => {
	it('a win reserves a pass whose token can be claimed', async () => {
		forceRoll({ win: true })
		const ip = nextIp()
		const p = await play({ ip })
		expect(p.data.won).toBe(true)
		expect(await count('SELECT COUNT(*) n FROM claims')).toBe(1)
		expect(
			(
				await claim({
					ip,
					token: p.data.token ?? '',
					email: 'w@example.com',
				})
			).status,
		).toBe(200)
	})

	it('a loss reserves nothing', async () => {
		forceRoll({ win: false })
		const p = await play({ ip: nextIp() })
		expect(p.data.won).toBe(false)
		expect(p.data.token).toBeUndefined()
		expect(await count('SELECT COUNT(*) n FROM claims')).toBe(0)
	})

	it('allows one pull per cooldown per network', async () => {
		forceRoll({ win: false })
		const ip = nextIp()
		expect((await play({ ip })).status).toBe(200)
		expect((await play({ ip })).status).toBe(429)
	})

	it('treats an IPv6 /64 as one network', async () => {
		forceRoll({ win: false })
		expect((await play({ ip: '2001:db8:aa:1::1' })).status).toBe(200)
		expect((await play({ ip: '2001:db8:aa:1:ffff::9' })).status).toBe(429)
	})

	it('never reserves more passes than exist, even when everyone wins at once', async () => {
		forceRoll({ win: true })
		const results = await Promise.all(
			Array.from({ length: TOTAL + 7 }, () => play({ ip: nextIp() })),
		)
		expect(results.filter((r) => r.data.won === true)).toHaveLength(TOTAL)
		expect(await count('SELECT COUNT(*) n FROM claims')).toBe(TOTAL)
	})

	it('reports sold out once all passes are reserved', async () => {
		forceRoll({ win: true })
		for (let i = 0; i < TOTAL; i++) await play({ ip: nextIp() })
		expect((await play({ ip: nextIp() })).status).toBe(410)
	})

	it('returns an expired reservation to the pool', async () => {
		for (let i = 0; i < TOTAL; i++) await reserve({ expiresIn: -1 })
		forceRoll({ win: true })
		expect((await play({ ip: nextIp() })).data.won).toBe(true)
	})

	it('does not give a second pass to a network that already has one', async () => {
		forceRoll({ win: true })
		const ip = nextIp()
		const p = await play({ ip })
		await claim({
			ip,
			token: p.data.token ?? '',
			email: 'first@example.com',
		})
		// Pretend the cooldown has passed.
		await env.DB.prepare('UPDATE ip_limits SET last_play_at = 0').run()
		const again = await play({ ip })
		expect(again.data.won).toBe(false)
		expect(await count('SELECT COUNT(*) n FROM claims')).toBe(1)
	})

	it('does not let a network hold two unclaimed passes at once', async () => {
		forceRoll({ win: true })
		const ip = nextIp()
		expect((await play({ ip })).data.won).toBe(true)
		// Cooldown over, but the first pass is still waiting to be claimed.
		await env.DB.prepare('UPDATE ip_limits SET last_play_at = 0').run()
		const again = await play({ ip })
		expect(again.data.won).toBe(false)
		expect(await count('SELECT COUNT(*) n FROM claims')).toBe(1)
	})

	it('rejects a failed bot check without using up the cooldown', async () => {
		vi.restoreAllMocks()
		mockTurnstile({ success: false })
		const ip = nextIp()
		expect((await play({ ip })).status).toBe(403)
		expect(await count('SELECT COUNT(*) n FROM ip_limits')).toBe(0)
	})
})

describe('test mode', () => {
	it('always wins but writes nothing and claims nothing', async () => {
		forceRoll({ win: false })
		const p = await play({ ip: TEST_IP })
		expect(p.data).toMatchObject({ won: true, test: true })
		const c = await claim({
			ip: TEST_IP,
			token: p.data.token ?? '',
			email: 't@example.com',
		})
		expect(c.data).toMatchObject({ ok: true, test: true })
		expect(await count('SELECT COUNT(*) n FROM claims')).toBe(0)
		expect(await count('SELECT COUNT(*) n FROM plays')).toBe(0)
		expect(await count('SELECT COUNT(*) n FROM ip_limits')).toBe(0)
	})

	it('does not apply to other networks', async () => {
		forceRoll({ win: false })
		expect((await play({ ip: nextIp() })).data.won).toBe(false)
	})
})

describe('status', () => {
	it('counts every real pull from a running counter', async () => {
		forceRoll({ win: false })
		for (let i = 0; i < 3; i++) await play({ ip: nextIp() })
		const res = await api({ path: '/api/status', ip: nextIp() })
		const body = z.object({ pulls: z.number() }).parse(await res.json())
		expect(body.pulls).toBe(3)
		expect(await count('SELECT COUNT(*) n FROM plays')).toBe(3)
	})
})

describe('live stats', () => {
	it('serves only global numbers, cached briefly at the edge', async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/stats`)
		// Browsers must never cache it; only the edge does (s-maxage on the stored copy).
		expect(res.headers.get('cache-control')).toBe('no-store')
		expect(res.headers.get('x-generated-at')).toMatch(/^\d+$/)
		// strict(): no per-visitor fields (cooldown, clock) may leak into a cached response.
		z.object({
			open: z.boolean(),
			remaining: z.number(),
			total: z.number(),
			oddsOneIn: z.number(),
			pulls: z.number(),
			winners: z.array(
				z.object({ email: z.string(), at: z.number() }).strict(),
			),
		})
			.strict()
			.parse(await res.json())
	})
})

describe('config', () => {
	it('credits exactly as many passes as the giveaway has', () => {
		expect(DONORS.reduce((sum, d) => sum + d.passes, 0)).toBe(TOTAL)
	})

	it('has odds for every pass: 10k x3, 20k x3, 50k x3, 100k x3', () => {
		const ladder = parseLadder(env.WIN_ODDS)
		expect(ladder).toHaveLength(TOTAL)
		expect(
			Array.from({ length: TOTAL }, (_, taken) =>
				oddsOneIn({ ladder, taken }),
			),
		).toEqual([
			10000, 10000, 10000, 20000, 20000, 20000, 50000, 50000, 50000,
			100000, 100000, 100000,
		])
	})
})

describe('winners board', () => {
	it('lists claimed winners masked, never their full address', async () => {
		const token = await reserve()
		await claim({
			ip: nextIp(),
			token,
			email: 'Secret.Person@acme-corp.dev',
		})
		const res = await api({ path: '/api/status', ip: nextIp() })
		const text = await res.text()
		expect(text.toLowerCase()).not.toContain('secret.person')
		expect(text).not.toContain('acme-corp')
		const body = z
			.object({
				winners: z.array(
					z.object({ email: z.string(), at: z.number() }),
				),
			})
			.parse(JSON.parse(text))
		expect(body.winners.map((w) => w.email)).toEqual([
			'secret•••••••@••••••••.dev',
		])
	})

	it('does not list reservations that were never claimed', async () => {
		await reserve()
		const res = await api({ path: '/api/status', ip: nextIp() })
		const body = z
			.object({ winners: z.array(z.unknown()) })
			.parse(await res.json())
		expect(body.winners).toHaveLength(0)
	})
})
