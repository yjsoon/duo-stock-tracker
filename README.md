# apple-stock

Get an alert when an Apple product can be picked up at a store near a postal code. This is the MIT-licensed checker from [kelindi/apple-stock](https://github.com/kelindi/apple-stock) (Copyright (c) 2026 Kelindi), with the Singapore store added. The license is in [LICENSE](LICENSE).

## How a check works

On a timer, the process opens the product page in headless Chromium and reads each model's part number from that page. It then calls Apple's fulfillment endpoint from inside the page. For the United States that URL is `https://www.apple.com/shop/fulfillment-messages`. For Singapore the checker asks `https://www.apple.com/sg/shop/fulfillment-messages` from the same page. When that response is HTTP 541 or not JSON, it calls `https://www.apple.com/sg/shop/retail/pickup-message` and reads `body.stores`. A direct request from a script gets HTTP 541 from Apple's shield, so both calls are made by the page itself.

`parseFulfillment` turns the JSON into one row per store and part. Distances are stored in kilometres. The United States display is miles. Canada and Singapore display kilometres. If a part goes from unavailable to available, you get one alert. You get another alert if it sells out and comes back.

```
src/index.js    starts the check loop
src/apple.js    product pages and the fulfillment request
src/parse.js    part numbers and availability
src/checker.js  settings, what changed since last time, when to alert
src/notify.js   email, ntfy, and Discord
```

## Parts and stores

These values were read from Apple on 29 Oct 2026. Set the part numbers with `MODELS`. The checker does not hardcode them.

Part numbers are the `partNumber` fields in the `metrics` JSON on [the Singapore iPhone Duo page](https://www.apple.com/sg/shop/buy-iphone/iphone-duo). The same two numbers are on `productSelectionData` for `dimensionCapacity` `512gb`.

| Part number | Model |
| --- | --- |
| `MK2F4X/A` | iPhone Duo 512GB Star White |
| `MK2G4X/A` | iPhone Duo 512GB Night Sky |

Store numbers are `data-store-number` on each store link at [Apple's Singapore store list](https://www.apple.com/sg/retail/storelist/), and the same ids appear as `RgdsStore.id` in that page.

| Store | Store number | Postal code |
| --- | --- | --- |
| Apple Orchard Road | `R669` | 238857 |
| Apple Marina Bay Sands | `R633` | 018972 |
| Apple Jewel Changi Airport | `R736` | 819666 |

A live request from this environment to `/sg/shop/fulfillment-messages` for `MK2F4X/A` and `MK2G4X/A` at postal code `238857` returned HTTP 541 and an HTML document titled "Page Not Found". The same browser session got HTTP 200 JSON from `/sg/shop/retail/pickup-message`. The body has `head.status` `200` and `body.stores`. Orchard Road `R669` is 0.02 km, Marina Bay Sands `R633` is 3.21 km, and Jewel Changi Airport `R736` is 18.2 km. Both parts were `pickupDisplay` `unavailable` with quote "Currently unavailable". A trimmed copy of that response is `test/fixtures/sg-pickup-message.json`. The test passes that file to `parseFulfillment` as Apple returned it.

## Run a Singapore check on Linux

You need Node.js 22 or newer.

```sh
npm install
npx playwright install --with-deps chromium
cp .env.example .env
```

Edit `.env` and set `NTFY_TOPIC` to a long random string. `.env` is listed in `.gitignore`. Do not commit it.

```sh
POSTAL_CODE=238857
COUNTRY=SG
PRODUCT=iphone-duo
MODELS=MK2F4X/A,MK2G4X/A
PICKUP_ONLY=true
MAX_DISTANCE_KM=50
INTERVAL_SECONDS=120
NTFY_SERVER=https://ntfy.sh
NTFY_TOPIC=replace-with-a-long-random-topic
```

`238857` is the Orchard Road store's postal code. `MAX_DISTANCE_KM=50` includes Jewel Changi Airport, which the live pickup response placed 18.2 km from that code. `PICKUP_ONLY=true` alerts when a part is available for in-store pickup. Delete that line if you also want an alert for 2-hour courier delivery.

`COUNTRY=us` still takes a ZIP code such as `10001` and shows miles. `COUNTRY=ca` still takes a Canadian postal code such as `M5V3L9`.

Send a test alert, then run one check, then leave it running.

```sh
npm run test-notify
npm run check
npm start
```

`npm run test-notify` logs `notified via ntfy` when the topic accepts the post. The phone shows the title "apple-stock test notification".

`npm start` checks about every `INTERVAL_SECONDS`, with a small random jitter, and serves the UI at http://127.0.0.1:4321. The minimum interval is 30 seconds. To keep the process up after you log out, install [`examples/apple-stock.service`](examples/apple-stock.service) as a user systemd unit.

A check that reaches Apple and finds these two parts unavailable logs a line in this shape.

```
2026-10-29T04:19:56.135Z checked 2 model(s) at 3 store(s) within 50 km of 238857: 0 available, 0 new (e.g. "Currently unavailable")
```

That line is the output of `npm run check` on 29 Oct 2026 with the Singapore `.env` above. Both parts were unavailable at all three stores.

When a part is newly available for pickup, the log prints a subject like `In stock: iPhone Duo 512GB Star White, pickup at Orchard Road` and the ntfy message lists the store and the distance in km.

## Alerts with ntfy

1. Install the ntfy app from https://ntfy.sh on the phone that should buzz.
2. In the app, subscribe to the same topic you put in `NTFY_TOPIC`.
3. Leave `NTFY_SERVER` as `https://ntfy.sh`, or set it to the origin of a server you run. No trailing slash.
4. Run `npm run test-notify` and confirm the phone shows the test.

The checker sends `POST {NTFY_SERVER}/{NTFY_TOPIC}`. The body is the alert text. The headers are `Title` (the subject), `Priority: high`, `Tags: iphone`, and `Click` set to the product URL. Anyone who knows the topic can read the alerts, so keep the topic random. There is no token in this setup.

Email via Resend (`RESEND_API_KEY`, `EMAIL_TO`, optional `EMAIL_FROM`) and Discord (`DISCORD_WEBHOOK_URL`) still work, in any combination with ntfy. Leave them empty if you only want ntfy.

## Configuration

| Variable | Default in code | Role |
| --- | --- | --- |
| `POSTAL_CODE` | required | Search location. Singapore accepts 6 digits, including a leading zero. |
| `COUNTRY` | `ca` | `SG` or `sg` uses the Singapore store. `us` and `ca` behave as before. |
| `PRODUCT` | `iphone-duo` | Store page. A bare slug means `buy-iphone/<slug>`. |
| `MODELS` | `all` | Comma-separated part numbers or words that must all appear in the model name. |
| `PICKUP_ONLY` | off | `true` or `1` alerts on pickup only. |
| `MAX_DISTANCE_KM` | `50` | Skip stores farther than this. The value is always kilometres, including for the US. |
| `INTERVAL_SECONDS` | `30` | Gap between checks for `npm start`. Minimum 30. |
| `NTFY_TOPIC` | empty | ntfy topic. Empty means ntfy is off. |
| `NTFY_SERVER` | `https://ntfy.sh` | ntfy server origin. |
| `HEADLESS` | `true` | Set `false` to watch the browser. |

## Tests

```sh
npm test
```

The suite includes the trimmed Singapore pickup response and the existing US and Canada cases.
