import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { sendAdminNotice, sendWinnerEmail } from './email.ts'
import {
	checkEmail,
	ipKey,
	maskEmail,
	oddsOneIn,
	randomToken,
	rollWin,
	sha256,
} from './lib.ts'
import {
	ClaimBody,
	ClaimStateRow,
	Config,
	CountRow,
	EmailError,
	IdRow,
	LastPlayRow,
	PassCountsRow,
	PlayBody,
	TurnstileResult,
	WinnerRow,
} from './schemas.ts'

const HOST = 'claudepass.mehulmohan.com'

// Parsed once per isolate; a bad value fails loudly instead of silently becoming NaN.
let config: Config | undefined
const cfg = (): Config => (config ??= Config.parse(env))

const now = () => Math.floor(Date.now() / 1000)

function json({
	body,
	status = 200,
	headers = {},
}: {
	body: unknown
	status?: number
	headers?: Record<string, string>
}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...headers,
		},
	})
}

// --- validated I/O helpers ---------------------------------------------------------

async function first<T>({
	stmt,
	schema,
}: {
	stmt: D1PreparedStatement
	schema: z.ZodType<T>
}): Promise<T | null> {
	const row = await stmt.first()
	return row === null ? null : schema.parse(row)
}

async function all<T>({
	stmt,
	schema,
}: {
	stmt: D1PreparedStatement
	schema: z.ZodType<T>
}): Promise<T[]> {
	const { results } = await stmt.all()
	return z.array(schema).parse(results)
}

async function readJson<T>({
	req,
	schema,
}: {
	req: Request
	schema: z.ZodType<T>
}): Promise<T | null> {
	const raw: unknown = await req.json().catch(() => null)
	const parsed = schema.safeParse(raw)
	return parsed.success ? parsed.data : null
}

function describeError(err: unknown): string {
	const parsed = EmailError.safeParse(err)
	return parsed.success
		? `${parsed.data.code ?? 'unknown'} ${parsed.data.message ?? ''}`
		: String(err)
}

// --- domain --------------------------------------------------------------------------

/**
 * Test mode: networks listed in the TEST_IPS secret always win and run the whole pipeline
 * (rate limit, Turnstile, win, claim, emails) but never write to D1 or use up a pass.
 */
function isTestNetwork(key: string): boolean {
	return cfg().TEST_IPS.some((ip) => ipKey(ip) === key)
}

function clientIp(req: Request): string | null {
	// Set by Cloudflare's edge; clients cannot spoof it on a proxied hostname.
	return req.headers.get('cf-connecting-ip')
}

/** Passes still available: total minus delivered minus currently-held reservations. */
/**
 * One pass over the (tiny) claims table:
 * - remaining: passes not claimed and not held by a live reservation
 * - expiredWins: wins whose 5-minute claim window ran out ("foolish bot attempts")
 */
async function passCounts(
	t: number,
): Promise<{ remaining: number; expiredWins: number }> {
	const row = await first({
		stmt: env.DB.prepare(
			`SELECT
				COALESCE(SUM(CASE WHEN redeemed_at IS NOT NULL OR expires_at > ?1 THEN 1 ELSE 0 END), 0) AS taken,
				COALESCE(SUM(CASE WHEN redeemed_at IS NULL AND expires_at <= ?1 THEN 1 ELSE 0 END), 0) AS expired
			 FROM claims`,
		).bind(t),
		schema: PassCountsRow,
	})
	return {
		remaining: Math.max(0, cfg().TOTAL_PASSES - (row?.taken ?? 0)),
		expiredWins: row?.expired ?? 0,
	}
}

async function remainingPasses(t: number): Promise<number> {
	return (await passCounts(t)).remaining
}

/** Every real pull so far (test mode never writes, so it isn't counted). */
async function totalPulls(): Promise<number> {
	// A one-row counter, not COUNT(*): D1 bills every row a query reads.
	const row = await first({
		stmt: env.DB.prepare(
			"SELECT value AS n FROM counters WHERE name = 'pulls'",
		),
		schema: CountRow,
	})
	return row?.n ?? 0
}

async function nextPlayAt(key: string): Promise<number | null> {
	const row = await first({
		stmt: env.DB.prepare(
			'SELECT last_play_at FROM ip_limits WHERE ip_key = ?1',
		).bind(key),
		schema: LastPlayRow,
	})
	if (!row) return null
	const at = row.last_play_at + cfg().COOLDOWN_SECONDS
	return at > now() ? at : null
}

async function verifyTurnstile({
	token,
	ip,
}: {
	token: string
	ip: string
}): Promise<boolean> {
	const body = new FormData()
	body.append('secret', env.TURNSTILE_SECRET)
	body.append('response', token)
	body.append('remoteip', ip)
	const res = await fetch(
		'https://challenges.cloudflare.com/turnstile/v0/siteverify',
		{ method: 'POST', body },
	)
	if (!res.ok) return false
	const out = TurnstileResult.safeParse(await res.json())
	return (
		out.success &&
		out.data.success &&
		out.data.hostname === HOST &&
		out.data.action === 'play'
	)
}

/** Global numbers only: identical for every visitor, so safe to cache at the edge. */
async function stats(t: number) {
	const { OPEN, TOTAL_PASSES, WIN_ODDS } = cfg()
	const [{ remaining, expiredWins }, pulls, claimed] = await Promise.all([
		passCounts(t),
		totalPulls(),
		winners(),
	])
	return {
		open: OPEN,
		remaining,
		total: TOTAL_PASSES,
		oddsOneIn: oddsOneIn({
			ladder: WIN_ODDS,
			taken: TOTAL_PASSES - remaining,
		}),
		pulls,
		expiredWins,
		// Masked here, so full addresses never leave the Worker or reach the edge cache.
		winners: claimed.map((w) => ({
			email: maskEmail(w.email),
			at: w.redeemed_at,
		})),
	}
}

// GET /api/status: stats plus this network's cooldown and the server clock.
async function status(req: Request): Promise<Response> {
	const ip = clientIp(req)
	const key = ip ? ipKey(ip) : null
	const t = now()
	const [global, next] = await Promise.all([
		stats(t),
		key && !isTestNetwork(key) ? nextPlayAt(key) : null,
	])
	return json({ body: { ...global, nextPlayAt: next, now: t } })
}

const STATS_TTL_SECONDS = 5

// GET /api/stats: polled by every open page to keep the counters live. Cached per
// Cloudflare location for a few seconds, so D1 sees at most one query per location
// per TTL no matter how many people are watching.
async function cachedStats(ctx: ExecutionContext): Promise<Response> {
	const cache = caches.default
	const cacheKey = new Request(`https://${HOST}/api/stats`)
	let res = await cache.match(cacheKey)
	if (!res) {
		res = json({
			body: await stats(now()),
			headers: {
				// Edge TTL only. The zone's Browser Cache TTL would otherwise stretch
				// max-age on cache hits, so browsers always get no-store below.
				'cache-control': `public, s-maxage=${STATS_TTL_SECONDS}`,
				'x-generated-at': String(now()),
			},
		})
		ctx.waitUntil(cache.put(cacheKey, res.clone()))
	}
	const out = new Response(res.body, res)
	out.headers.set('cache-control', 'no-store')
	return out
}

// POST /api/play
async function play(req: Request): Promise<Response> {
	const ip = clientIp(req)
	const key = ip ? ipKey(ip) : null
	if (!ip || !key)
		return json({
			body: { error: "Couldn't identify your network." },
			status: 400,
		})

	const { COOLDOWN_SECONDS, CLAIM_WINDOW_SECONDS, WIN_ODDS, TOTAL_PASSES } =
		cfg()
	const t = now()

	const test = isTestNetwork(key)

	// 1. IP check first: cheap read, rejects repeat players before anything else.
	const next = test ? null : await nextPlayAt(key)
	if (next)
		return json({
			body: { error: 'cooldown', nextPlayAt: next, now: t },
			status: 429,
		})

	if (!cfg().OPEN)
		return json({
			body: { error: "The giveaway isn't open yet." },
			status: 503,
		})
	const remaining = await remainingPasses(t)
	if (remaining === 0)
		return json({ body: { error: 'soldout' }, status: 410 })

	// 2. Bot check.
	const body = await readJson({ req, schema: PlayBody })
	if (!body || !(await verifyTurnstile({ token: body.turnstile, ip }))) {
		return json({
			body: { error: 'Bot check failed. Reload the page and try again.' },
			status: 403,
		})
	}

	// Test mode stops here: a guaranteed win, with nothing written and no pass reserved.
	if (test)
		return json({
			body: {
				won: true,
				test: true,
				token: randomToken(),
				expiresAt: t + CLAIM_WINDOW_SECONDS,
				now: t,
			},
		})

	// 3. Atomically take this network's play for the cooldown window. If two requests race, only one
	//    row update succeeds; the other gets nothing back and is rejected.
	const took = await first({
		stmt: env.DB.prepare(
			`INSERT INTO ip_limits (ip_key, last_play_at, plays) VALUES (?1, ?2, 1)
			 ON CONFLICT(ip_key) DO UPDATE SET last_play_at = excluded.last_play_at, plays = plays + 1
			 WHERE ip_limits.last_play_at <= ?3
			 RETURNING ip_key`,
		).bind(key, t, t - COOLDOWN_SECONDS),
		schema: z.object({ ip_key: z.string() }),
	})
	if (!took)
		return json({
			body: {
				error: 'cooldown',
				nextPlayAt: (await nextPlayAt(key)) ?? t + COOLDOWN_SECONDS,
				now: t,
			},
			status: 429,
		})

	// 4. Roll on the server with the CSPRNG, at the odds set for the next pass (WIN_ODDS).
	const oneIn = oddsOneIn({
		ladder: WIN_ODDS,
		taken: TOTAL_PASSES - remaining,
	})
	let token: string | null = null
	if (rollWin(oneIn)) {
		// Counted before reserving, so a winning roll that somehow fails to reserve still
		// shows up (roll_wins > reservations). Wins are rare, so this write costs nothing.
		await env.DB.prepare(
			"INSERT INTO counters (name, value) VALUES ('roll_wins', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1",
		).run()
		const candidate = randomToken()
		// Reserve a pass only if one is free and this network holds none: not one already
		// claimed, and not one still waiting to be claimed (the claim window outlasts the
		// cooldown, so a network could otherwise win twice before claiming).
		const reserved = await first({
			stmt: env.DB.prepare(
				`INSERT INTO claims (token_hash, ip_key, created_at, expires_at)
				 SELECT ?1, ?2, ?3, ?4
				 WHERE (SELECT COUNT(*) FROM claims WHERE redeemed_at IS NOT NULL OR expires_at > ?3) < ?5
				   AND NOT EXISTS (SELECT 1 FROM claims WHERE ip_key = ?2 AND (redeemed_at IS NOT NULL OR expires_at > ?3))
				 RETURNING id`,
			).bind(
				await sha256(candidate),
				key,
				t,
				t + CLAIM_WINDOW_SECONDS,
				TOTAL_PASSES,
			),
			schema: IdRow,
		})
		if (reserved) token = candidate
	}

	await env.DB.batch([
		env.DB.prepare(
			'INSERT INTO plays (ip_key, ip, country, won, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
		).bind(key, ip, req.cf?.country ?? null, token ? 1 : 0, t),
		env.DB.prepare(
			"INSERT INTO counters (name, value) VALUES ('pulls', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1",
		),
	])

	return token
		? json({
				body: {
					won: true,
					token,
					expiresAt: t + CLAIM_WINDOW_SECONDS,
					now: t,
					nextPlayAt: t + COOLDOWN_SECONDS,
				},
			})
		: json({
				body: {
					won: false,
					now: t,
					nextPlayAt: t + COOLDOWN_SECONDS,
					remaining: await remainingPasses(t),
				},
			})
}

// POST /api/claim
async function claim({
	req,
	ctx,
}: {
	req: Request
	ctx: ExecutionContext
}): Promise<Response> {
	const body = await readJson({ req, schema: ClaimBody })
	if (!body)
		return json({ body: { error: 'Invalid claim token.' }, status: 400 })
	const email = checkEmail(body.email)
	if (!email.ok) return json({ body: { error: email.error }, status: 400 })

	const ip = clientIp(req)
	const key = ip ? ipKey(ip) : null
	if (key && isTestNetwork(key))
		return testClaim({ address: email.address, ctx })

	const tokenHash = await sha256(body.token)
	const t = now()

	// Atomically bind the email to the reservation. Fails if the token is unknown, used,
	// expired, or this inbox already received a pass.
	const row = await first({
		stmt: env.DB.prepare(
			`UPDATE claims SET email = ?1, redeemed_at = ?2, sent_to = ?4
			 WHERE token_hash = ?3 AND redeemed_at IS NULL AND expires_at > ?2
			   AND NOT EXISTS (SELECT 1 FROM claims WHERE email = ?1)
			 RETURNING id`,
		).bind(email.canonical, t, tokenHash, email.address),
		schema: IdRow,
	}).catch(() => null) // a UNIQUE(email) race lands here too

	if (!row) {
		const c = await first({
			stmt: env.DB.prepare(
				'SELECT redeemed_at, expires_at FROM claims WHERE token_hash = ?1',
			).bind(tokenHash),
			schema: ClaimStateRow,
		})
		if (!c)
			return json({
				body: { error: 'Invalid claim token.' },
				status: 400,
			})
		if (c.redeemed_at)
			return json({
				body: { error: 'This pass was already claimed.' },
				status: 409,
			})
		if (c.expires_at <= t)
			return json({
				body: {
					error: 'Your 5 minutes ran out, so the pass went back in the pool.',
				},
				status: 410,
			})
		return json({
			body: { error: 'That inbox already received a pass.' },
			status: 409,
		})
	}

	let messageId: string
	try {
		const sent = await sendWinnerEmail({ to: email.address })
		messageId = sent.messageId
	} catch (err) {
		console.error('email send failed', describeError(err))
		// Release the email so the winner can retry with a different address inside the window.
		await env.DB.prepare(
			'UPDATE claims SET email = NULL, redeemed_at = NULL, sent_to = NULL WHERE id = ?1',
		)
			.bind(row.id)
			.run()
		return json({
			body: {
				error: "We couldn't email that address. Check it and try again.",
			},
			status: 502,
		})
	}

	// The email is out, so the claim stands even if recording the message id fails.
	await env.DB.prepare('UPDATE claims SET message_id = ?1 WHERE id = ?2')
		.bind(messageId, row.id)
		.run()
		.catch((err: unknown) =>
			console.error('message id not saved', describeError(err)),
		)

	// Tell Mehul, with everyone who has claimed so far. Best effort: never blocks the winner.
	ctx.waitUntil(
		winners()
			.then((list) =>
				sendAdminNotice({
					latest: email.address,
					winners: list,
					total: cfg().TOTAL_PASSES,
				}),
			)
			.catch((err: unknown) =>
				console.error('admin notice failed', describeError(err)),
			),
	)

	return json({ body: { ok: true } })
}

/**
 * How many rate-limit units each API route costs. Reads are cheap; anything that verifies
 * Turnstile, writes to D1 or sends email costs more.
 */
function apiWeight(pathname: string): number {
	if (pathname === '/api/status') return 1
	return pathname === '/api/play' ? 3 : 5
}

/** Workers Rate Limiting binding, keyed by network so one allowance covers all routes. */
async function rateLimited({
	req,
	delta,
}: {
	req: Request
	delta: number
}): Promise<boolean> {
	const ip = clientIp(req)
	const key = (ip ? ipKey(ip) : null) ?? 'unknown'
	const { success } = await env.API_LIMITER.limit({ key, delta })
	// Rate-limit hits aren't shown in the dashboard, so log them for Workers Logs.
	if (!success) console.warn('rate limited', key)
	return !success
}

/** Test-mode claim: sends the real emails, writes nothing. */
async function testClaim({
	address,
	ctx,
}: {
	address: string
	ctx: ExecutionContext
}): Promise<Response> {
	try {
		await sendWinnerEmail({ to: address, test: true })
	} catch (err) {
		console.error('test email send failed', describeError(err))
		return json({
			body: {
				error: "We couldn't email that address. Check it and try again.",
			},
			status: 502,
		})
	}
	ctx.waitUntil(
		winners()
			.then((list) =>
				sendAdminNotice({
					latest: address,
					winners: list,
					total: cfg().TOTAL_PASSES,
					test: true,
				}),
			)
			.catch((err: unknown) =>
				console.error('admin notice failed', describeError(err)),
			),
	)
	return json({ body: { ok: true, test: true } })
}

function winners(): Promise<WinnerRow[]> {
	return all({
		stmt: env.DB.prepare(
			'SELECT sent_to AS email, redeemed_at FROM claims WHERE redeemed_at IS NOT NULL ORDER BY redeemed_at',
		),
		schema: WinnerRow,
	})
}

function sameOrigin(req: Request): boolean {
	return req.headers.get('origin') === `https://${HOST}`
}

export default {
	// The (request, env, ctx) signature is fixed by the Workers runtime.
	async fetch(
		req: Request,
		_env: unknown,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(req.url)

		// "/" never reaches here: the home page is a static asset (public/index.html)
		// that Cloudflare serves before the Worker runs.

		// Cached and identical for everyone, so it skips the per-network rate limiter.
		if (url.pathname === '/api/stats' && req.method === 'GET')
			return cachedStats(ctx)

		const isRead = url.pathname === '/api/status'
		const isWrite =
			url.pathname === '/api/play' || url.pathname === '/api/claim'
		if (!isRead && !isWrite)
			return new Response('Not found', { status: 404 })

		if (req.method !== (isRead ? 'GET' : 'POST'))
			return json({ body: { error: 'Method not allowed' }, status: 405 })
		if (
			isWrite &&
			(!sameOrigin(req) ||
				!req.headers
					.get('content-type')
					?.startsWith('application/json'))
		) {
			return json({ body: { error: 'Forbidden' }, status: 403 })
		}

		if (await rateLimited({ req, delta: apiWeight(url.pathname) })) {
			return json({
				body: {
					error: 'rate_limited',
					message: 'Too many requests. Wait a minute and try again.',
				},
				status: 429,
				headers: { 'retry-after': '60' },
			})
		}

		if (isRead) return status(req)
		return url.pathname === '/api/play' ? play(req) : claim({ req, ctx })
	},
} satisfies ExportedHandler
