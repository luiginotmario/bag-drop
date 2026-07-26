import { chromium } from "playwright";
import { readFileSync, existsSync } from "fs";
import { spawn } from "child_process";

const CONFIG_PATH = existsSync("./config.json") ? "./config.json" : "./config.example.json";
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const BASE = cfg.baseUrl.replace(/\/$/, "");

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alertLoud(msg) {
  console.log("\n" + "!".repeat(60));
  console.log("!!", msg);
  console.log("!".repeat(60) + "\n");
  process.stdout.write("\x07\x07\x07"); // terminal bell
}

function openLocally(url) {
  // pop the checkout in the default browser so you can pay immediately
  try {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch (e) {
    log("auto-open failed (copy the URL above):", e.message);
  }
}

function detectChallenge(pageUrl, html) {
  const u = pageUrl.toLowerCase();
  const h = (html || "").toLowerCase();
  if (u.includes("queue-it") || h.includes("queue-it") || h.includes("queue.it")) return "Queue-it waiting room";
  // Only treat it as a challenge if we actually got bounced to a challenge URL.
  // Shopify checkout HTML always embeds hCaptcha scripts, so matching the HTML gives false positives.
  if (u.includes("/challenge") || u.includes("_ab_challenge") || u.includes("cf_challenge"))
    return "CAPTCHA / bot challenge";
  return null;
}

// ---- Phase 1: poll for unlock (redirect to /password disappears) ----
async function waitForUnlock(request) {
  if (cfg.dropTimeISO) {
    const startAt = new Date(cfg.dropTimeISO).getTime() - (cfg.preRollSeconds ?? 30) * 1000;
    const wait = startAt - Date.now();
    if (wait > 0) {
      log(`Sleeping ${(wait / 1000).toFixed(0)}s until pre-roll (drop ${cfg.dropTimeISO})...`);
      await sleep(wait);
    }
  }
  const deadline = Date.now() + (cfg.maxPollMinutes ?? 20) * 60_000;
  log(`Polling ${BASE}/ every ${cfg.pollIntervalMs}ms for unlock...`);
  let n = 0;
  while (Date.now() < deadline) {
    try {
      const res = await request.get(`${BASE}/?_=${Date.now()}`, { maxRedirects: 0, timeout: 5000 });
      const loc = res.headers()["location"] || "";
      const locked = res.status() >= 300 && res.status() < 400 && loc.includes("password");
      if (!locked && res.status() < 400) {
        log(`UNLOCKED (status ${res.status()}) after ${n} polls.`);
        return true;
      }
      log(`still locked (poll ${++n}, status ${res.status()})...`);
    } catch (e) {
      log("poll error:", e.message);
    }
    await sleep(cfg.pollIntervalMs ?? 300);
  }
  return false;
}

// ---- Phase 2: resolve variant id from /products.json ----
async function resolveVariant(request) {
  if (cfg.variantId) return String(cfg.variantId);
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const res = await request.get(`${BASE}/products.json?limit=250&_=${Date.now()}`, { timeout: 5000 });
      if (res.ok()) {
        const { products = [] } = await res.json();
        const tokens = (cfg.productKeyword || "").toLowerCase().split(/\s+/).filter(Boolean);
        // Fuzzy score: how many keywords appear in the product's searchable text.
        const scored = products
          .map((p) => {
            const hay = `${p.title} ${p.product_type} ${p.vendor} ${(p.tags || []).join(" ")} ${p.handle}`.toLowerCase();
            const score = tokens.length ? tokens.filter((t) => hay.includes(t)).length : 1;
            return { p, score };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score); // best match first

        // Take the highest-scoring product that has an available variant.
        for (const { p, score } of scored) {
          const v = p.variants.find((v) => v.available);
          if (v) {
            log(`SNIPED: "${p.title}" (match ${score}/${tokens.length || 1}) -> variant ${v.id} ($${v.price})`);
            return String(v.id);
          }
        }
        if (scored.length) {
          log(`Found ${scored.length} candidate(s) (best: "${scored[0].p.title}") but none available yet...`);
        } else {
          log(`No product matching "${cfg.productKeyword}" yet...`);
        }
      }
    } catch (e) {
      log("products.json error:", e.message);
    }
    await sleep(150);
  }
  log("Could not resolve a variant id. Exiting.");
  return null;
}

// ---- Phase 3: add to cart + reach tokenized checkout ----
async function main() {
  const browser = await chromium.launch({ headless: !!cfg.headless });
  const context = await browser.newContext();
  const request = context.request; // shares cookies with the browser pages

  const unlocked = await waitForUnlock(request);
  if (!unlocked) {
    log("Never unlocked within maxPollMinutes. Exiting.");
    await browser.close();
    process.exit(1);
  }

  const variantId = await resolveVariant(request);
  if (!variantId) {
    await browser.close();
    process.exit(2);
  }

  // FAST PATH: reserve over raw HTTP — no page rendering, no networkidle waits.
  // GET /cart/{variant}:{qty} adds the line item, then GET /checkout follows the
  // 302s straight to the tokenized checkout URL, which is what actually holds stock.
  const qty = cfg.quantity ?? 1;
  const t0 = Date.now();
  log(`Reserving via HTTP: /cart/${variantId}:${qty} -> /checkout`);

  let checkoutUrl = "";
  let checkoutBody = "";
  try {
    await request.get(`${BASE}/cart/${variantId}:${qty}`, { timeout: 8000 });
    const res = await request.get(`${BASE}/checkout`, { timeout: 15000 });
    checkoutUrl = res.url();
    checkoutBody = await res.text().catch(() => "");
  } catch (e) {
    log("reserve error:", e.message);
  }
  log(`Reservation round-trip: ${Date.now() - t0}ms -> ${checkoutUrl || "(no url)"}`);

  const challenge = detectChallenge(checkoutUrl, checkoutBody);
  if (challenge) {
    alertLoud(`${challenge} detected. NOT bypassing — open the URL below and solve it manually.`);
  }

  const won = /\/checkouts?\/(c|cn)\//i.test(checkoutUrl) || (/checkout/i.test(checkoutUrl) && !/\/cart(\/|\?|$)/i.test(checkoutUrl));
  if (won) {
    console.log("\n" + "=".repeat(70));
    console.log("CHECKOUT URL:");
    console.log(checkoutUrl);
    console.log("=".repeat(70) + "\n");
    openLocally(checkoutUrl);
    alertLoud("GOT THE TOKEN — checkout opened locally. Go finish payment NOW.");
    log("Token URL is shareable to any device. Cart held ~10 min. Ctrl+C to quit.");
    await new Promise(() => {}); // stay alive so the link/session persists
  } else {
    alertLoud(`Did NOT get a checkout token (landed on ${checkoutUrl || "nothing"}). Item likely already gone.`);
    await browser.close();
    process.exit(3);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
