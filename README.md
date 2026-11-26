# claudepass

9 Claude Code guest passes (1 free week each), shared by [@mehulmpt](https://x.com/mehulmpt), [@YashSolanki_](https://x.com/YashSolanki_) and [@MaheshBauti](https://x.com/MaheshBauti). Live at **[claudepass.mehulmohan.com](https://claudepass.mehulmohan.com)**.

Pick a ticket and the server draws. Win, and you have 5 minutes to leave your email.

## How the draw works

- **One pull every 3 seconds per network** (IPv4 address or IPv6 `/64`), enforced atomically in D1, plus a per-network rate limit.
- **A fresh Turnstile check** on every pull.
- **Server-side roll** with `crypto.getRandomValues`. Odds: 1 in 10,000 for passes 1–3, 20,000 for 4–6, 100,000 for 7–9.
- **A win reserves a pass** behind a single-use token for 5 minutes. Unclaimed passes go back in the pool.
- **One pass per inbox and per network.**
- **Test mode:** IPs in the `TEST_IPS` secret always win but never save anything or use a pass. Off when set to `none`.

The logic is in [`src/index.ts`](src/index.ts); odds and limits are in [`cloudflare.config.ts`](cloudflare.config.ts).

## Share your passes

DM [@mehulmpt](https://x.com/mehulmpt) on X.

## Develop

```sh
pnpm install
pnpm check   # typecheck, prettier, tests
```

Free to enter. Not affiliated with Anthropic; Claude is a trademark of Anthropic, PBC. [MIT](LICENSE) licensed.
