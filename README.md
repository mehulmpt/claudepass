# claudepass

A small giveaway for 6 Claude Code guest passes (1 free week each), shared by [@mehulmpt](https://x.com/mehulmpt) and [@YashSolanki_](https://x.com/YashSolanki_), live at **[claudepass.mehulmohan.com](https://claudepass.mehulmohan.com)**.

You pick one of three tickets. The server draws the result; the ticket you pick is just for fun. If you win, you have 5 minutes to leave your email, and the pass is sent to you personally.

This repo is public so anyone can check how the draw works.

## How the draw works

1. **One pull every 15 seconds per network.** Your IP is the key: IPv4 as-is, IPv6 grouped to its `/64` (one subscriber usually controls a whole `/64`, so a per-address limit would be easy to dodge). The check is a single atomic SQL statement, so parallel requests can't sneak in extra pulls.
2. **Bot check.** Every pull needs a fresh, single-use [Turnstile](https://developers.cloudflare.com/turnstile/) token, verified on the server.
3. **The roll.** The server draws from `crypto.getRandomValues`. Odds get harder as passes go:

    | Passes   | Odds         |
    | -------- | ------------ |
    | 1st, 2nd | 1 in 10,000  |
    | 3rd, 4th | 1 in 20,000  |
    | 5th, 6th | 1 in 100,000 |

4. **Claiming.** A win reserves a pass and returns a random 256-bit token. Only its SHA-256 hash is stored. The token works once, for 5 minutes. If nobody claims it in time, the pass goes back into the pool.
5. **One pass per inbox and per network.** Gmail dots and `+tags` count as the same inbox.
6. **Flood guard.** A [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) binding gives each network 60 units a minute across the API: `/api/status` costs 1, `/api/play` and `/api/claim` cost 10. It's approximate and counted per Cloudflare location, so it's only a second line of defense; the D1 cooldown check above is the strict one.

**Test mode.** Networks listed in the `TEST_IPS` secret always win so the full flow can be tested on the live site. Test mode never writes to D1 and never uses up a pass, and the page labels it clearly. It's off when the secret is `none`.

The winner gets a confirmation email and Mehul gets a notification with the list of winners. No pass link is stored or sent by this app.

All of this lives in [`src/index.ts`](src/index.ts). The odds and limits are in [`cloudflare.config.ts`](cloudflare.config.ts).

## Sharing your own passes

Got Claude Code guest passes to give away? DM [@mehulmpt](https://x.com/mehulmpt) on X and they'll be added to the pool.

## Stack

Cloudflare Workers, D1 (SQLite), Email Sending and Turnstile, deployed with the [`cf`](https://developers.cloudflare.com/cf/) CLI. Inputs are validated with [Zod](https://zod.dev).

```
src/index.ts     routes, rate limit, draw, claim
src/schemas.ts   Zod schemas for config, requests, D1 rows
src/lib.ts       IP grouping, email checks, tokens, odds ladder
src/email.ts     winner + admin emails
src/page.ts      the page (HTML/CSS/JS in one response)
migrations/      D1 schema
og/              source for public/og.png (./og/render.sh)
```

## Development

```sh
pnpm install
pnpm check        # typecheck + prettier + tests
pnpm dev          # local dev server
pnpm deploy       # deploy (needs TURNSTILE_SECRET and ADMIN_EMAIL secrets)
```

Dependencies are pinned exactly, and pnpm only installs versions published at least 7 days ago (`minimumReleaseAge` in `pnpm-workspace.yaml`).

## Disclaimer

Free to enter, no purchase necessary. This is a personal giveaway by Mehul Mohan and is not affiliated with, sponsored or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.

## License

[MIT](LICENSE) © Mehul Mohan
