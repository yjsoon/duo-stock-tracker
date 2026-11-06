# Agent guide: set up apple-stock-sg

This repo watches Apple Singapore in-store pickup stock and sends alerts through ntfy. When the user asks you to "set this up", follow this file from top to bottom. Read [README.md](README.md) for how checks and alerts work.

## Rules

- Never commit, print in full, or paste into chat the ntfy topic, `ADMIN_TOKEN`, `NTFY_TOKEN`, or Cloudflare credentials. `.env`, `.dev.vars` and `.state.json` are gitignored, so keep them that way. When you show a command that contains a secret, refer to it by its variable name.
- Generate the ntfy topic randomly. Never use a guessable word such as `iphone`: anyone who knows the topic can read the alerts or post fake ones. The code rejects topics shorter than 16 characters.
- Deploy only to the Cloudflare account the user names, and only after they confirm. Don't use credentials you find in the environment unless the user says they belong to the account they want.
- Don't set `INTERVAL_SECONDS` below 120 to "catch stock faster". Shorter gaps make Apple return HTTP 541 for long stretches and can use up ntfy.sh's free daily quota. Never call Apple in a loop to debug. One manual check every couple of minutes is the limit.
- Send ntfy messages only to the user's new topic.

## 1. Ask the user

Ask these together and wait for the answers:

1. **Where to run it.** Choose Cloudflare Worker (their own Cloudflare account, nothing to keep running) or self-hosted (a machine that stays on, with Node.js 22.9+).
2. **Postal code.** The 6-digit Singapore postal code to search from. The default `238857` is the Orchard Road store. Distance only filters stores, and `MAX_DISTANCE_KM=50` covers all three Singapore stores.
3. **Models.** Which product, capacity and colour they want. Map the answer to part numbers: run `npm run models` (or `node src/node.js --models <product page URL>` for a product other than iPhone Duo), show the user the list, and confirm the part numbers. The limit is 10. If they want another product, also set `PRODUCT_URL` to its `https://www.apple.com/sg/shop/buy-...` page.
4. **ntfy.** Will they use the public `https://ntfy.sh` (the default) or their own ntfy server? Tell them to install the ntfy app (iOS, Android, or https://ntfy.sh/app in a browser). After you generate the topic, they subscribe to it.

## 2. Prepare (both targets)

```sh
node --version                     # must be v22.9 or newer
npm install                        # wrangler, needed for the Worker and harmless otherwise
npm test                           # all tests must pass
node -e "console.log('apple-stock-' + crypto.randomUUID())"   # the ntfy topic
```

Give the topic to the user once, privately, and have them subscribe to it in the ntfy app: tap "+" and enter the topic, using a custom server if needed. Don't continue until they say they are subscribed.

## 3a. Self-hosted

```sh
cp .env.example .env
```

Edit `.env` and set `POSTAL_CODE`, `MODELS`, `NTFY_TOPIC`, plus `NTFY_SERVER`/`NTFY_TOKEN` if they run their own server. Leave the other values at their defaults unless the user asked otherwise. Then verify:

```sh
npm run test-notify   # expect: "sent a test notification to https://ntfy.sh/<NTFY_TOPIC>", exit 0
npm run check         # expect: "checked N model(s) at 3 store(s) within 50 km of ...: 0 available, 0 new ...", exit 0
```

Ask the user to confirm that the "apple-stock test notification" reached their phone. If `npm run check` exits 1, see "When Apple fails" below.

Keep it running:

- **Linux with systemd.** Copy [examples/apple-stock.service](examples/apple-stock.service) and set `WorkingDirectory` to this checkout's absolute path and `ExecStart` to the output of `command -v node`. The comments in the file list the install commands. Verify with `systemctl --user status apple-stock` and `journalctl --user -u apple-stock -n 20`.
- **Anything else**, such as macOS, a Raspberry Pi without systemd, or Docker: run `npm start` under whatever keeps processes alive there (launchd, pm2, tmux on a server, a container with `restart: unless-stopped`). It logs one line per check and `next check in Ns`.

State is in `.state.json`. Deleting it while stock is available makes the next check alert again.

## 3b. Cloudflare Worker

1. **Log in.** Run `npx wrangler login`, which opens a browser for the user, or have them export a `CLOUDFLARE_API_TOKEN` with "Edit Cloudflare Workers" permission for their account. Then run `npx wrangler whoami` and confirm the account name with the user before deploying. If they have several accounts, set `CLOUDFLARE_ACCOUNT_ID`.
2. **Settings.** Edit `vars` in [wrangler.jsonc](wrangler.jsonc): `POSTAL_CODE`, `MODELS`, and `NTFY_SERVER` or `PRODUCT_URL` if needed. These values are not secret. `wrangler deploy` replaces any vars edited in the dashboard.
3. **Build check, then deploy.**

   ```sh
   npm run cf:check-build   # no upload; lists the WATCHER Durable Object and the vars
   npm run cf:deploy        # prints https://apple-stock-sg.<subdomain>.workers.dev
   ```

   If the account has no workers.dev subdomain yet, wrangler asks the user to choose one.
4. **Secrets.** Generate `ADMIN_TOKEN` with `node -e "console.log(crypto.randomUUID())"`. Pipe each secret in so it never appears in shell history or chat:

   ```sh
   printf %s "$NTFY_TOPIC"  | npx wrangler secret put NTFY_TOPIC
   printf %s "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN
   # only for a protected ntfy server:
   printf %s "$NTFY_TOKEN"  | npx wrangler secret put NTFY_TOKEN
   ```

   Tell the user to save `ADMIN_TOKEN`, for example in their password manager. They need it for `/status`.
5. **Verify.** With `URL` set to the deployed URL:

   ```sh
   curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/test-notify"   # {"ok":true,...}
   curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/check"         # {"ok":true,"line":"checked ..."}
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/status"                # lastStatus 200, nextCheckAt about 2 min out
   curl -s -o /dev/null -w '%{http_code}\n' "$URL/status"                       # 401 without the token
   ```

   Have the user confirm the test notification arrived. `POST /check` also starts the schedule. After that, a Durable Object alarm runs each check, and the `*/30 * * * *` cron only re-arms the alarm if it is ever missing. Watch it live with `npx wrangler tail`.

`npx wrangler dev` (local mode) can't reach Apple: Apple answers HTTP 403 because local workerd adds a `CF-Worker` header to requests leaving a non-Cloudflare IP. The deployed Worker gets HTTP 200 from Cloudflare's Singapore edge. Use `wrangler dev` only with a mock Apple server, by setting `APPLE_ORIGIN` in `.dev.vars`, and verify against the deployed Worker.

To stop it, run `npx wrangler delete`. This deletes the Worker and its stored state.

## When Apple fails

`check failed: HTTP 541 (not JSON)` means Apple's shield returned a "Page Not Found" page. It comes and goes, and it is not a ban.

1. Treat one 541 as normal. Wait at least 2 minutes and run one more check (`npm run check`, or `POST /check`). Don't retry faster, and don't lower `INTERVAL_SECONDS`.
2. If several manual checks over about 10 minutes all return 541, the setup is still complete. Leave it running: it keeps checking at the normal cadence and recovers by itself. Tell the user it is running but Apple is refusing requests right now, and that one "apple-stock: cannot read Apple" notice arrives after `STALE_ALERT_MIN` minutes if that continues.
3. For self-hosted, if every check from that network gets 541 for hours, the network's IP is probably flagged, which is common for cloud/VPS ranges. Suggest the Cloudflare Worker or a home connection instead.

`HTTP 403` or `HTTP 429` means rate limiting. The checker already drops the session and backs off (up to ×8, honouring `Retry-After`). Don't run manual checks for at least 15 minutes. `HTTP 0`/`timeout` is a network problem on the host.

A ntfy error such as `ntfy HTTP 429` means the ntfy.sh daily quota for that IP is used up. Stock finds are retried on the next check. If it keeps happening, the user can run their own ntfy server or use an ntfy.sh account token (`NTFY_TOKEN`).

## Done means

Tell the user which target you set up, the postal code and part numbers, and the actual output of the test notification and the one-off check. Also tell them where to see logs (`journalctl` / `npx wrangler tail`) and how to stop it. Don't print the topic or tokens.

## Working on the code

- `npm test` runs the unit tests, which make no network calls. `npm run cf:check-build` must succeed for any change to `src/`.
- `src/core.js` holds everything shared by both targets and only uses `fetch`. Keep Node-only APIs in `src/node.js` and Workers-only APIs in `src/worker.js`.
- Don't add other notification channels or non-Singapore stores here. Upstream [kelindi/apple-stock](https://github.com/kelindi/apple-stock) has them.
