require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

// Use node-fetch v3 in CommonJS via dynamic import
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();

// Capture raw body (we're not using signature validation yet, but this is fine)
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
 * Helper: fetch latest observation value for a FRED series
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
 * No signature check yet, just log errors.
 */
app.get("/hubspot/rates", async (req, res) => {
  console.log("GET /hubspot/rates called");

  try {
    const [sofr, prime, dgs5, dgs10] = await Promise.all([
      fetchLatestFredValue("SOFR"),
      fetchLatestFredValue("DPRIME"),
      fetchLatestFredValue("DGS5"),
      fetchLatestFredValue("DGS10"),
    ]);

    console.log("Rates fetched from FRED:", {
      SOFR: sofr,
      PRIME: prime,
      TREASURY_5Y: dgs5,
      TREASURY_10Y: dgs10,
    });

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
 */
app.post("/hubspot/update-deal-rates", async (req, res) => {
  console.log("POST /hubspot/update-deal-rates called, body:", req.body);

  const { dealId, properties } = req.body || {};
  if (!dealId || !properties) {
    console.error("Missing dealId/properties");
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

    const text = await hsRes.text();
    console.log("HubSpot API response:", hsRes.status, text.slice(0, 200));

    if (!hsRes.ok) {
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
