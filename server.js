require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const fetch = require("node-fetch");

const app = express();

// Capture raw body for signature validation
app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// Simple healthcheck
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * Helpers: validate HubSpot v3 signature for hubspot.fetch calls
 * Docs: v3 signature -> HMAC SHA256 over method + url + body + timestamp, base64
 * with your app's client secret.
 */

// protect against replay
function isRecentTimestamp(timestampMs) {
  const FIVE_MINUTES = 5 * 60 * 1000;
  const now = Date.now();
  const ts = Number(timestampMs);
  return Math.abs(now - ts) <= FIVE_MINUTES;
}

function validateHubSpotSignature(req) {
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!clientSecret) {
    console.error("HUBSPOT_CLIENT_SECRET not set");
    return false;
  }

  const signature = req.headers["x-hubspot-signature-v3"];
  const timestamp = req.headers["x-hubspot-request-timestamp"];

  if (!signature || !timestamp) {
    console.error("Missing signature/timestamp");
    return false;
  }

  if (!isRecentTimestamp(timestamp)) {
    console.error("Timestamp too old");
    return false;
  }

  const method = req.method;
  const hostname = req.headers["x-forwarded-host"] || req.hostname;
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const uri = `${protocol}://${hostname}${req.originalUrl}`;

  const rawBody = req.rawBody || "";
  const canonical = `${method}${uri}${rawBody}${timestamp}`;

  const expected = crypto
    .createHmac("sha256", clientSecret)
    .update(canonical)
    .digest("base64");

  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    console.error("Signature mismatch");
    return false;
  }

  // Optional: lock to a single portal
  const allowedPortalId = process.env.ALLOWED_PORTAL_ID;
  const portalId = req.query.portalId;
  if (allowedPortalId && portalId && portalId !== allowedPortalId) {
    console.error("Portal ID mismatch:", portalId);
    return false;
  }

  return true;
}

/**
 * Helper: fetch latest observation value for a FRED series
 * We use fred/series/observations, descending, limit=1.
 */

async function fetchLatestFredValue(seriesId) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    throw new Error("FRED_API_KEY not set");
  }

  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "1");

  const res = await fetch(url.href);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FRED error for ${seriesId}: ${res.status} ${text}`);
  }

  const json = await res.json();
  const obs = json.observations && json.observations[0];
  if (!obs || obs.value === "." || obs.value == null) {
    return null;
  }

  const num = parseFloat(obs.value);
  return Number.isNaN(num) ? null : num;
}

/**
 * GET /hubspot/rates
 * Used by your card to get live rates:
 *  - SOFR      → series_id "SOFR"
 *  - PRIME     → series_id "DPRIME" (Bank Prime Loan Rate, daily)
 *  - 5Y UST    → series_id "DGS5"
 *  - 10Y UST   → series_id "DGS10"
 */

app.get("/hubspot/rates", async (req, res) => {
  if (!validateHubSpotSignature(req)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  try {
    const [sofr, prime, dgs5, dgs10] = await Promise.all([
      fetchLatestFredValue("SOFR"),
      fetchLatestFredValue("DPRIME"),
      fetchLatestFredValue("DGS5"),
      fetchLatestFredValue("DGS10"),
    ]);

    res.json({
      SOFR: sofr,
      PRIME: prime,
      TREASURY_5Y: dgs5,
      TREASURY_10Y: dgs10,
    });
  } catch (err) {
    console.error("Error fetching rates:", err);
    res.status(500).json({ error: "Failed to fetch rates" });
  }
});

/**
 * POST /hubspot/update-deal-rates
 * Body: { dealId: string, properties: { ... } }
 * Uses HUBSPOT_ACCESS_TOKEN to PATCH /crm/v3/objects/deals/{dealId}
 */

app.post("/hubspot/update-deal-rates", async (req, res) => {
  if (!validateHubSpotSignature(req)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { dealId, properties } = req.body || {};
  if (!dealId || !properties) {
    return res.status(400).json({ error: "Missing dealId or properties" });
  }

  try {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) {
      console.error("HUBSPOT_ACCESS_TOKEN not set");
      return res.status(500).json({ error: "Server not configured" });
    }

    const hsRes = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(
        dealId
      )}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ properties }),
      }
    );

    if (!hsRes.ok) {
      const text = await hsRes.text();
      console.error("HubSpot API error:", hsRes.status, text);
      return res.status(hsRes.status).json({ error: "HubSpot update failed" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Server error updating deal:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
