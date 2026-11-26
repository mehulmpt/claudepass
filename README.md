# claudepass

21 Claude Code guest passes (1 free week each), shared by [@mehulmpt](https://x.com/mehulmpt), [@YashSolanki_](https://x.com/YashSolanki_), [@MaheshBauti](https://x.com/MaheshBauti), [@BhagyaMudgal](https://x.com/BhagyaMudgal), [@sachingurjar_4](https://x.com/sachingurjar_4), [@mohittwwt](https://x.com/mohittwwt) and [@deveshb15](https://x.com/deveshb15). Live at **[claudepass.mehulmohan.com](https://claudepass.mehulmohan.com)**.

Pick a ticket and the server draws. Win, and you have 5 minutes to leave your email.

## How the draw works

- **One pull every 3 seconds per network** (IPv4 address or IPv6 `/64`), enforced atomically in D1, plus a per-network rate limit.
- **A fresh Turnstile check** on every pull.
- **Server-side roll** with `crypto.getRandomValues`. Odds: 1 in 1,000 for every pass.
- **A win reserves a pass** behind a single-use token for 5 minutes. Unclaimed passes go back in the pool.
- **One pass per inbox and per network.**
- **Test mode:** IPs in the `TEST_IPS` secret always win but never save anything or use a pass. Off when set to `none`.

The logic is in [`src/index.ts`](src/index.ts); odds and limits are in [`cloudflare.config.ts`](cloudflare.config.ts).

## Share your passes

DM [@mehulmpt](https://x.com/mehulmpt) on X.

## Develop

```sh
pnpm install
pnpm check        # typecheck, prettier, tests
pnpm render:page  # after editing src/settings.ts or src/page.ts
```

Free to enter. Not affiliated with Anthropic; Claude is a trademark of Anthropic, PBC. [MIT](LICENSE) licensed.
