/// <reference types="node" />
// Pre-renders the home page into public/ so it is served as a free static asset.
// Usage: pnpm render:page   (re-run after changing src/settings.ts or src/page.ts)
import { writeFile } from 'node:fs/promises'
import { renderStatic } from '../src/page.ts'
import { TURNSTILE_SITE_KEY, WIN_ODDS } from '../src/settings.ts'

const { html, headers } = await renderStatic({
	siteKey: TURNSTILE_SITE_KEY,
	ladder: WIN_ODDS,
})
await writeFile(new URL('../public/index.html', import.meta.url), html)
await writeFile(new URL('../public/_headers', import.meta.url), headers)
console.log(
	`wrote public/index.html (${html.length} bytes) and public/_headers`,
)
