import { z } from 'zod'

// --- config ------------------------------------------------------------------

const positiveInt = z.coerce.number().int().positive()

/** "10000,20000,100000" -> [10000, 20000, 100000]: "1 in N" odds for each successive pass. */
export const OddsLadder = z
	.string()
	.transform((raw) => raw.split(',').map((s) => Number(s.trim())))
	.pipe(z.array(z.number().int().positive()).min(1))

export const Config = z.object({
	TOTAL_PASSES: positiveInt,
	WIN_ODDS: OddsLadder,
	COOLDOWN_SECONDS: positiveInt,
	CLAIM_WINDOW_SECONDS: positiveInt,
	OPEN: z.enum(['true', 'false']).transform((v) => v === 'true'),
	TEST_IPS: z.string().transform((raw) =>
		raw
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean),
	),
})
export type Config = z.infer<typeof Config>

// --- request bodies ------------------------------------------------------------

export const PlayBody = z.object({
	turnstile: z.string().min(1).max(4096),
})

export const ClaimBody = z.object({
	// 32 random bytes, base64url without padding.
	token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
	email: z.string().max(320),
})

// --- third-party responses ------------------------------------------------------

export const TurnstileResult = z.object({
	success: z.boolean(),
	hostname: z.string().optional(),
	action: z.string().optional(),
})

/** Errors thrown by the send_email binding carry a `code`, e.g. E_RECIPIENT_NOT_ALLOWED. */
export const EmailError = z.object({
	code: z.string().optional(),
	message: z.string().optional(),
})

// --- D1 rows -----------------------------------------------------------------------

export const CountRow = z.object({ n: z.number() })
export const PassCountsRow = z.object({
	taken: z.number(),
	expired: z.number(),
})
export const LastPlayRow = z.object({ last_play_at: z.number() })
export const IdRow = z.object({ id: z.number() })
export const ClaimStateRow = z.object({
	redeemed_at: z.number().nullable(),
	expires_at: z.number(),
})
export const WinnerRow = z.object({
	email: z.string(),
	redeemed_at: z.number(),
})
export type WinnerRow = z.infer<typeof WinnerRow>
