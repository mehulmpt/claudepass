import { bindings, defineConfig } from 'cf/config'
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' }

export default defineConfig({
	worker: {
		name: 'claudepass-giveaway',
		compatibilityDate: '2026-11-23',
		entrypoint,
		// Only reachable on the custom domain, never on *.workers.dev.
		domains: ['claudepass.mehulmohan.com'],
		workersDev: false,
		previewUrls: false,
		observability: { enabled: true },
		env: {
			DB: bindings.d1({
				id: 'ba9c0784-2d2e-4e45-b3e4-f7e1e64fcd3d',
				name: 'claudepass-giveaway',
			}),
			// Secondary flood guard in front of /api/*. Approximate and per Cloudflare location
			// (see docs), so the strict limit stays the atomic D1 check. One allowance per network,
			// with weighted calls: status = 1, play = 3, claim = 5 units. Sized so a player
			// pulling at the full cooldown rate (20/min) plus status refreshes stays under it.
			API_LIMITER: bindings.rateLimit({
				namespace: '72601',
				simple: { limit: 120, period: 60 },
			}),
			EMAIL: bindings.sendEmail({
				allowedSenderAddresses: ['giveaway@mehulmohan.com'],
			}),

			// Tunables. Each IP (IPv6: per /64) gets one play per cooldown.
			TOTAL_PASSES: bindings.text('9'),
			// "1 in N" odds for each pass in order (1st, 2nd, ...): it gets harder as passes go.
			WIN_ODDS: bindings.text(
				'10000,10000,10000,20000,20000,20000,100000,100000,100000',
			),
			COOLDOWN_SECONDS: bindings.text('3'),
			CLAIM_WINDOW_SECONDS: bindings.text('300'),
			FROM_ADDRESS: bindings.text('giveaway@mehulmohan.com'),
			TURNSTILE_SITE_KEY: bindings.text('0x4AAAAAAGTCTKlBQ9uJLIpN'),

			// Set to "false" to close the giveaway without taking the site down.
			OPEN: bindings.text('true'),
			// Secrets (set with `cf workers secrets update`).
			TURNSTILE_SECRET: bindings.secret(),
			// Gets a notification with the full winner list every time someone claims.
			ADMIN_EMAIL: bindings.secret(),
			// Comma-separated IPs that run in test mode: always win, never write to D1, never
			// use up a pass. A secret so personal IPs stay out of the repo. "none" disables it.
			TEST_IPS: bindings.secret(),
		},
	},
})
