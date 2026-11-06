# apple-stock-sg

Get a phone notification through [ntfy](https://ntfy.sh) when an iPhone (or any Apple product with a part number) can be picked up at an Apple Store in Singapore.

It runs in one of two ways. Both use the same check code and settings.

- **Cloudflare Worker** on your own Cloudflare account. The Workers Free plan is enough. Nothing runs on your machine.
- **Self-hosted**: one Node.js 22.9+ process on any always-on machine. It needs no npm packages.

To have a coding agent set it up for you, point Claude Code, Codex or a similar agent at this repo and say "set this up". [AGENTS.md](AGENTS.md) walks the agent through it. `CLAUDE.md` just imports that file. To set it up by hand, follow the same steps yourself.

Based on [kelindi/apple-stock](https://github.com/kelindi/apple-stock) by Kelindi, used under the MIT License. See [LICENSE](LICENSE).

## How a check works

Each check sends one HTTP GET to Apple's in-store pickup endpoint:

```
https://www.apple.com/sg/shop/retail/pickup-message?pl=true&location=<POSTAL_CODE>&parts.0=<PART>&parts.1=<PART>
```

Apple answers this from a plain HTTP client, so no browser is needed. The checker keeps the session cookies Apple sets and sends them back on the next check. `src/parse.js` turns `body.stores` into one row per store and part. An alert goes out when a store/part is `pickupDisplay: "available"` and was not available at the last clean check.

The defaults are conservative, because Apple and ntfy.sh both push back on frequent requests:

- **Cadence.** A check runs every `INTERVAL_SECONDS` (default 120, minimum 60) with ±20% jitter, so 96–144 s. At 15–20 s cadence Apple returned long runs of HTTP 541 ("Page Not Found" HTML). At around 2 minutes most checks came back clean.
- **Failures.** A 541, a timeout or non-JSON counts as unknown. The checker tries again at the normal cadence and changes no state. A 403 or 429 drops the session and doubles the wait, up to ×8. A `Retry-After` header is honoured, capped at 15 minutes.
- **Alert dedupe.** All new finds in one check go into one ntfy message, with no repeats. Only an explicit "unavailable" in a clean response clears a find. A failed check, or a response that leaves a store out, never re-arms an alert. The same store and model alerts at most once per `ALERT_COOLDOWN_MIN` (default 60), even if stock flaps. If ntfy rejects a send, for example with ntfy.sh's daily limit (HTTP 429), the find is retried on the next check.
- **Blind notice.** After `STALE_ALERT_MIN` (default 60) minutes without a clean answer, you get one low-priority "cannot read Apple" message. It says stock is unknown and is not a stock alert. It resets after the next clean check.

The same request to `/sg/shop/fulfillment-messages`, which also carries delivery and courier data, returned HTTP 541 every time it was tried, from a server, a Cloudflare Worker and a real browser. This checker therefore covers in-store pickup only.

```
src/core.js     config, the Apple request, alert rules, ntfy
src/parse.js    Apple response parsers
src/node.js     self-hosted loop and CLI (state in .state.json)
src/worker.js   Cloudflare Worker + Durable Object (state in Durable Object storage)
wrangler.jsonc  Worker config and non-secret settings
test/           node --test suite, with a trimmed live Apple response in test/fixtures/
```

## Settings

Self-hosted reads `.env` (copy `.env.example`). The Worker reads `vars` in `wrangler.jsonc` and secrets set with `npx wrangler secret put`.

| Name | Default | Meaning |
| --- | --- | --- |
| `POSTAL_CODE` | required | 6-digit Singapore postal code to search from. |
| `MODELS` | required | 1–10 comma-separated part numbers. `npm run models` lists them. |
| `NTFY_TOPIC` | required, secret | 16–64 letters, digits, `-` or `_`. Anyone who knows it can read your alerts. |
| `NTFY_SERVER` | `https://ntfy.sh` | ntfy server origin. |
| `NTFY_TOKEN` | empty, secret | Access token, only for a protected ntfy server. |
| `MAX_DISTANCE_KM` | `50` | Skip stores farther than this. 50 covers all of Singapore. |
| `INTERVAL_SECONDS` | `120` | Seconds between checks, ±20%. Minimum 60. |
| `ALERT_COOLDOWN_MIN` | `60` | Minimum minutes between alerts for the same store and model. |
| `STALE_ALERT_MIN` | `60` | Minutes of failures before the one-off "cannot read Apple" notice. `0` turns it off. |
| `PRODUCT_URL` | iPhone Duo page | Link in alerts. Also the page `npm run models` reads. |
| `ADMIN_TOKEN` | Worker only, secret | Bearer token for the Worker's `/status`, `/check` and `/test-notify`. |
| `STATE_FILE` | `.state.json` | Self-hosted only. Where state is saved. |

Part numbers seen on 6 Nov 2026 for iPhone Duo in Singapore:

| Part | Model |
| --- | --- |
| `MK2D4X/A` / `MK2E4X/A` | 256GB Star White / Night Sky |
| `MK2F4X/A` / `MK2G4X/A` | 512GB Star White / Night Sky |
| `MK2H4X/A` / `MK2J4X/A` | 1TB Star White / Night Sky |
| `MK2K4X/A` / `MK2L4X/A` | 2TB Star White / Night Sky |

Stores in the pickup response: Orchard Road `R669`, Marina Bay Sands `R633`, Jewel Changi Airport `R736`. From postal code 238857 they are 0.02, 3.21 and 18.2 km away.

## Commands

```sh
npm test                 # unit tests, no network
npm run models           # list part numbers on PRODUCT_URL
npm run test-notify      # self-hosted: send a test ntfy message
npm run check            # self-hosted: one check, exit 1 if Apple did not answer cleanly
npm start                # self-hosted: check on a loop
npm run cf:check-build   # Worker: build without deploying
npm run cf:deploy        # Worker: deploy to your Cloudflare account
```

A clean self-hosted check against Apple prints:

```
2026-11-06T13:17:12.985Z checked 2 model(s) at 3 store(s) within 50 km of 238857: 0 available, 0 new (e.g. "Currently unavailable")
```

## Not supported

The upstream project also has the US and Canada stores, a web UI, browser push, email and Discord. This fork supports only Singapore pickup and ntfy, so that one small codebase runs both on Cloudflare and on your own machine. Use [kelindi/apple-stock](https://github.com/kelindi/apple-stock) for the rest.
