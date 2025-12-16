// server.js

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

// Use node-fetch v3 in CommonJS via dynamic import
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();

// Temporary in-memory store for collateral checklist state.
// Shape: { [dealId]: { collateralType, itemStatuses, overallStatus, isSaved } }
const checklistStore = {};

// Basic request logger (helps confirm traffic is reaching Render)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Capture raw body (fine even if you’re not doing signature validation yet)
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
 * Collateral Checklist
 * GET  /hubspot/collateral-checklist?dealId=123
 * POST /hubspot/collateral-checklist
 */

// GET saved state
app.get("/hubspot/collateral-checklist", async (req, res) => {
  const dealId = req.query.dealId;
  if (!dealId) {
    return res.status(400).json({ error: "Missing dealId" });
  }

  const entry = checklistStore[dealId];
  if (!entry) {
    // No saved state yet
    return res.json({});
  }

  return res.json(entry);
});

// POST save state + update HubSpot Deal properties
app.post("/hubspot/collateral-checklist", async (req, res) => {
  const { dealId, collateralType, itemStatuses, overallStatus } =
    req.body || {};

  if (!dealId) {
    return res.status(400).json({ error: "Missing dealId" });
  }

  // 1) Store checklist state in memory (for demo; DB later)
  checklistStore[dealId] = {
    collateralType: collateralType || null,
    itemStatuses: itemStatuses || {},
    overallStatus: overallStatus || "Complete",
    isSaved: true,
  };

  // 2) Update HubSpot Deal properties
  try {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!token) {
      console.error("HUBSPOT_ACCESS_TOKEN not set");
      return res.status(500).json({ error: "Server not configured" });
    }

    const properties = {
      // Enumeration property: Complete / Waiting on Customer / Waiting on Us / Not Needed
      deal_collateral_dropdown: overallStatus || "Complete",
      // Boolean flag
      collateral_checklist_complete: true,
      // If you created this property, uncomment:
      // collateral_checklist_last_updated: new Date().toISOString(),
    };

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
    console.log(
      "HubSpot collateral dropdown update:",
      hsRes.status,
      text.slice(0, 200)
    );

    if (!hsRes.ok) {
      return res
        .status(hsRes.status)
        .json({ error: "HubSpot update failed", details: text });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("Error updating HubSpot collateral dropdown:", err);
    return res.status(500).json({ error: "Server error" });
  }
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
    console.log("HubSpot API response:", hsRes.status, text.slice(0, 400));

    if (!hsRes.ok) {
      return res.status(hsRes.status).json({
        error: "HubSpot update failed",
        details: text,
      });
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
