import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vite-plus/test'
import headers from '../public/_headers?raw'
import html from '../public/index.html?raw'
import { parseLadder } from '../src/lib.ts'
import { renderStatic } from '../src/page.ts'

async function sha256Base64(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	)
	let bin = ''
	for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b)
	return btoa(bin)
}

describe('pre-rendered home page', () => {
	it('matches what the generator produces from the current config (run `pnpm render:page`)', async () => {
		const fresh = await renderStatic({
			siteKey: env.TURNSTILE_SITE_KEY,
			ladder: parseLadder(env.WIN_ODDS),
		})
		expect(html).toBe(fresh.html)
		expect(headers).toBe(fresh.headers)
	})

	it('allows every inline script and style by hash, and nothing inline otherwise', async () => {
		const csp = headers.match(/Content-Security-Policy: (.*)/)?.[1] ?? ''
		expect(csp).not.toContain('unsafe-inline')
		expect(html).not.toContain('nonce=')
		const blocks = [
			...html.matchAll(
				/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g,
			),
			...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g),
		].map((m) => m[1] ?? '')
		expect(blocks.length).toBeGreaterThanOrEqual(3)
		for (const block of blocks) {
			expect(csp).toContain(`'sha256-${await sha256Base64(block)}'`)
		}
	})
})
