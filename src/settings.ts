/**
 * Public tunables. The single source for both the Worker's config (cloudflare.config.ts)
 * and the pre-rendered home page (scripts/render-page.ts), so they can't drift apart.
 * After changing anything here, run `pnpm render:page`.
 */

/** Total passes in the pool. */
export const TOTAL_PASSES = 18

/**
 * "1 in N" odds for each pass in order (1st, 2nd, ...). Every pass is 1 in 1,000;
 * give later passes bigger numbers to make them harder.
 */
export const WIN_ODDS = Array.from({ length: TOTAL_PASSES }, () => 1_000)

/** Each network (IPv4 address or IPv6 /64) gets one pull per cooldown. */
export const COOLDOWN_SECONDS = 3

/** How long a winner has to claim before the pass returns to the pool. */
export const CLAIM_WINDOW_SECONDS = 300

export const TURNSTILE_SITE_KEY = '0x4AAAAAAGTCTKlBQ9uJLIpN'
