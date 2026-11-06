# Agent guide: set up apple-stock-sg

This repo watches Apple Store in-store pickup stock (Singapore by default; the US and Canada are verified too) and sends alerts through ntfy. When the user asks you to "set this up", follow this file from top to bottom. Read [README.md](README.md) for how checks and alerts work.

## Rules

- Never commit, print in full, or paste into chat the ntfy topic, `ADMIN_TOKEN`, `NTFY_TOKEN`, or Cloudflare credentials. `.env`, `.dev.vars` and `.state.json` are gitignored, so keep them that way. When you show a command that contains a secret, refer to it by its variable name.
- Generate the ntfy topic randomly. Never use a guessable word such as `iphone`: anyone who knows the topic can read the alerts or post fake ones. The code rejects topics shorter than 16 characters.
- Deploy only to the Cloudflare account the user names, and only after they confirm. Don't use credentials you find in the environment unless the user says they belong to the account they want.
- Don't set `INTERVAL_SECONDS` below 120 to "catch stock faster". Shorter gaps make Apple return HTTP 541 for long stretches and can use up ntfy.sh's free daily quota. Never call Apple in a loop to debug. One manual check every couple of minutes is the limit.
- Send ntfy messages only to the user's new topic.

## 1. Ask the user

Ask these together and wait for the answers:

1. **Where to run it.** Choose Cloudflare Worker (their own Cloudflare account, nothing to keep running) or self-hosted (a machine that stays on, with Node.js 22.9+).
2. **Country and postal code.** `COUNTRY` is `sg` (default), `us` or `ca`, which are verified, or another Apple Store country (see "Another country" below). Postal code examples: `238857` (SG, the Orchard Road store), `10001` (US ZIP), `M5V3L9` (CA). Distance only filters stores. `MAX_DISTANCE_KM` is always kilometres, and the default 50 covers all three Singapore stores.
3. **Models.** Which product, capacity and colour they want. Map the answer to part numbers for *their country*: run `COUNTRY=<cc> npm run models` (or `node src/node.js --models <product page URL>` for a product other than iPhone Duo), show the user the list, and confirm the part numbers. Part numbers differ per country. The limit is 10. If they want another product, also set `PRODUCT_URL` to its `https://www.apple.com/<cc>/shop/buy-...` page (US: `https://www.apple.com/shop/buy-...`).
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

Edit `.env` and set `COUNTRY`, `POSTAL_CODE`, `MODELS`, `NTFY_TOPIC`, plus `NTFY_SERVER`/`NTFY_TOKEN` if they run their own server. Leave the other values at their defaults unless the user asked otherwise. Then verify:

```sh
npm run test-notify   # expect: "sent a test notification to https://ntfy.sh/<NTFY_TOPIC>", exit 0
npm run check         # expect: "checked N model(s) at M store(s) within 50 km of ...: 0 available, 0 new ...", exit 0
```

Ask the user to confirm that the "apple-stock test notification" reached their phone. If `npm run check` exits 1, see "When Apple fails" below.

Keep it running:

- **Linux with systemd.** Copy [examples/apple-stock.service](examples/apple-stock.service) and set `WorkingDirectory` to this checkout's absolute path and `ExecStart` to the output of `command -v node`. The comments in the file list the install commands. Verify with `systemctl --user status apple-stock` and `journalctl --user -u apple-stock -n 20`.
- **Anything else**, such as macOS, a Raspberry Pi without systemd, or Docker: run `npm start` under whatever keeps processes alive there (launchd, pm2, tmux on a server, a container with `restart: unless-stopped`). It logs one line per check and `next check in Ns`.

State is in `.state.json`. Deleting it while stock is available makes the next check alert again. Only one process can use a state file at a time. Any existing `.state.json.lock` makes `npm start` and `npm run check` refuse to run (exit 1, "is locked by process N"), so stop the service first or set `STATE_FILE=/tmp/check.json` for a one-off check. The lock is never taken over automatically. If a checker crashed or the machine rebooted, first make sure none is running (`systemctl --user status apple-stock`, `pgrep -af src/node.js`), then delete `.state.json.lock` (or `STATE_FILE.lock` if you set a custom `STATE_FILE`).

## 3b. Cloudflare Worker

1. **Log in.** Run `npx wrangler login`, which opens a browser for the user, or have them export a `CLOUDFLARE_API_TOKEN` with "Edit Cloudflare Workers" permission for their account. Then run `npx wrangler whoami` and confirm the account name with the user before deploying. If they have several accounts, set `CLOUDFLARE_ACCOUNT_ID`.
2. **Settings.** Edit `vars` in [wrangler.jsonc](wrangler.jsonc): `COUNTRY`, `POSTAL_CODE`, `MODELS`, and `NTFY_SERVER` if needed. Alert links and the request Referer default to iPhone Duo in `COUNTRY`'s store. Add a `PRODUCT_URL` var only for a different product. These values are not secret. `wrangler deploy` replaces any vars edited in the dashboard.
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

`npx wrangler dev` (local mode) can't reach Apple: Apple answers HTTP 403 because local workerd adds a `CF-Worker` header to requests leaving a non-Cloudflare IP. The deployed Worker got HTTP 200 from Cloudflare's Singapore edge. A US or CA Worker has not been tried deployed. Verify it with `POST /check` before relying on it. Use `wrangler dev` only with a mock Apple server, by setting `APPLE_ORIGIN` in `.dev.vars`, and verify against the deployed Worker.

To stop it, run `npx wrangler delete`. This deletes the Worker and its stored state.

## Another country

`COUNTRY` is the path segment of that country's Apple Store, such as `uk` for `https://www.apple.com/uk/shop`. Only `sg`, `us` and `ca` have been verified. For any other code, the postal code gets only a loose check and the result is unverified. To set one up:

1. Confirm the store path exists. `curl -s -o /dev/null -w '%{http_code}\n' https://www.apple.com/<cc>/shop/buy-iphone` should print `200`.
2. Find part numbers with `COUNTRY=<cc> npm run models`. It reads the `metrics` JSON on the product page. If it finds none, the page layout differs. Ask the user for the part number, which is shown in the URL or on the page after choosing a model.
3. Run one `npm run check` with a postal code near a store. A clean result lists the nearby stores, as `M store(s)`. Store numbers (`R###`) are the `storeNumber` field of the pickup response, and the Worker's `/status` shows them in `available` once found. The country's store list is at `https://www.apple.com/<cc>/retail/storelist/`.
4. If the check fails with 541 or 404 every time, pickup-message may not exist for that country. Tell the user it is unsupported instead of guessing.

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
- Don't add other notification channels or delivery/courier alerts here. Upstream [kelindi/apple-stock](https://github.com/kelindi/apple-stock) has them.
- Keep test commands as explicit file globs (`node --test test/*.test.js`). `node --test test/` fails on Node 22.9.
