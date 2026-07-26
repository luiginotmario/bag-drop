# bag-drop

Playwright bot for a Shopify limited drop: detects storefront unlock, finds the
target product (Fendi bag), cart-adds via permalink, reaches the tokenized
checkout URL, and hands it to you **locally**. It enters nothing — no shipping,
no card — you finish the purchase yourself.

## Setup

```sh
npm install && npx playwright install chromium
cp config.example.json config.json   # edit: dropTimeISO, productKeyword
```

## Run

```sh
npm start
```

## How it works

1. Sleeps until `dropTimeISO - preRollSeconds`, then polls `GET /` every
   `pollIntervalMs`. Locked = `302 → /password`; the moment that redirect
   disappears, the store is open.
2. Resolves the variant from `/products.json`, filtered by `productKeyword`
   (default `"fendi"`, matched against title/type/vendor/tags). Picks the first
   available variant. Set `variantId` in config to skip this and save ~400ms.
3. Adds via cart permalink `/cart/{variantId}:1` (no UI clicks), then navigates
   to `/checkout` → Shopify 302s to the tokenized checkout URL
   (`.../checkouts/cn/<token>` or `checkouts.shopify.com/c/<token>`).
4. Prints the checkout URL and opens it in your local browser, rings the
   terminal bell, and idles with the browser open. You pay from there.

## Notes

- **No data entry, no payment automation.** The bot never fills shipping or card
  fields. It stops at the checkout link.
- **Queue-it / CAPTCHA**: detected and alerted, never bypassed — solve manually
  in the open browser window.
- **Sold out**: no available matching variant → logs and exits.
- Shopify holds checkout inventory only briefly (~10 min once the checkout is
  reached) — finish payment immediately.
- `config.json` is gitignored.
