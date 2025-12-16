// server.js

require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

// Use node-fetch v3 in CommonJS via dynamic import
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();

// -----------------------------
// Configurable property names
// -----------------------------
const COLLATERAL_TYPE_PROPERTY =
  process.env.COLLATERAL_TYPE_PROPERTY || "deal_collateral_type";

const CHECKLIST_COMPLETE_PROPERTY =
  process.env.CHECKLIST_COMPLETE_PROPERTY || "collateral_checklist_complete";

const DEAL_OVERALL_STATUS_PROPERTY =
  process.env.DEAL_OVERALL_STATUS_PROPERTY || "deal_collateral_dropdown";

// Primary + fallback JSON property (because your message mentions a different name)
const CHECKLIST_STATE_PROPERTY =
  process.env.CHECKLIST_STATE_PROPERTY || "collateral_checklist_state_json";

const ALT_CHECKLIST_STATE_PROPERTY =
  process.env.ALT_CHECKLIST_STATE_PROPERTY || "deal_collateral_state_json";

// -----------------------------
// Middleware
// -----------------------------

// Basic request logger (helps confirm traffic is reaching Render)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Capture raw body (fine even if you’re not doing signature validation yet)
app.use(
  bodyParser.json({
    limit: "2mb",
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// Simple healthcheck
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// -----------------------------
// Helpers
// -----------------------------
function requireHubSpotToken() {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) {
    throw new Error("HUBSPOT_ACCESS_TOKEN not set");
  }
  return token;
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== "string") return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtmlTags(str) {
  if (!str || typeof str !== "string") return str;
  return str.replace(/<\/?[^>]+(>|$)/g, "");
}

function safeParseStateJson(raw) {
  if (!raw || typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Attempt 1: parse as-is
  try {
    return JSON.parse(trimmed);
  } catch (_) {}

  // Attempt 2: rich text might store HTML or entities
  const noTags = stripHtmlTags(trimmed).trim();
  const decoded = decodeHtmlEntities(noTags).trim();

  try {
    return JSON.parse(decoded);
  } catch (_) {}

  return null;
}

async function fetchDealProperties(dealId, propertyNames) {
  const token = requireHubSpotToken();

  const qs = propertyNames
    .filter(Boolean)
    .map((p) => `properties=${encodeURIComponent(p)}`)
    .join("&");

  const url = `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(
    dealId
  )}?${qs}`;

  const hsRes = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const text = await hsRes.text();
  if (!hsRes.ok) {
    throw new Error(`HubSpot GET failed ${hsRes.status}: ${text}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`HubSpot GET returned non-JSON: ${text.slice(0, 200)}`);
  }

  return json.properties || {};
}

async function patchDealProperties(dealId, properties) {
  const token = requireHubSpotToken();

  const hsRes = await fetch(
    `https://api.hubapi.com/crm/v3/objects/deals/${encodeURIComponent(dealId)}`,
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
  return { ok: hsRes.ok, status: hsRes.status, text };
}

async function patchWithStatePropertyFallback(dealId, buildPropertiesFn) {
  // Try primary
  const primaryProps = buildPropertiesFn(CHECKLIST_STATE_PROPERTY);
  const primaryRes = await patchDealProperties(dealId, primaryProps);

  if (primaryRes.ok) {
    return { ...primaryRes, statePropertyUsed: CHECKLIST_STATE_PROPERTY };
  }

  // If primary fails, try fallback property name (common "property not found" case)
  // Only attempt fallback if it’s different
  if (
    ALT_CHECKLIST_STATE_PROPERTY &&
    ALT_CHECKLIST_STATE_PROPERTY !== CHECKLIST_STATE_PROPERTY
  ) {
    const maybeInvalidProp =
      (primaryRes.text || "").includes(CHECKLIST_STATE_PROPERTY) ||
      (primaryRes.text || "").toLowerCase().includes("property");

    if (maybeInvalidProp) {
      const fallbackProps = buildPropertiesFn(ALT_CHECKLIST_STATE_PROPERTY);
      const fallbackRes = await patchDealProperties(dealId, fallbackProps);

      if (fallbackRes.ok) {
        return {
          ...fallbackRes,
          statePropertyUsed: ALT_CHECKLIST_STATE_PROPERTY,
        };
      }

      // If fallback also fails, return fallback result (more likely aligned with your actual property)
      return {
        ...fallbackRes,
        statePropertyUsed: ALT_CHECKLIST_STATE_PROPERTY,
      };
    }
  }

  return { ...primaryRes, statePropertyUsed: CHECKLIST_STATE_PROPERTY };
}

// -----------------------------
// Collateral Checklist Routes
// -----------------------------

/**
 * GET  /hubspot/collateral-checklist?dealId=123
 * Reads from HubSpot Deal properties (persistent)
 */
app.get("/hubspot/collateral-checklist", async (req, res) => {
  const dealId = req.query.dealId;
  if (!dealId) return res.status(400).json({ error: "Missing dealId" });

  try {
    // Try reading using primary state property
    let props = await fetchDealProperties(dealId, [
      COLLATERAL_TYPE_PROPERTY,
      CHECKLIST_COMPLETE_PROPERTY,
      CHECKLIST_STATE_PROPERTY,
    ]);

    let rawState = props[CHECKLIST_STATE_PROPERTY];

    // If primary state property empty/undefined, try fallback property
    if (
      (!rawState || !String(rawState).trim()) &&
      ALT_CHECKLIST_STATE_PROPERTY &&
      ALT_CHECKLIST_STATE_PROPERTY !== CHECKLIST_STATE_PROPERTY
    ) {
      const props2 = await fetchDealProperties(dealId, [
        COLLATERAL_TYPE_PROPERTY,
        CHECKLIST_COMPLETE_PROPERTY,
        ALT_CHECKLIST_STATE_PROPERTY,
      ]);
      // merge/favor second response for state
      props = { ...props, ...props2 };
      rawState = props2[ALT_CHECKLIST_STATE_PROPERTY];
    }

    const parsed = safeParseStateJson(rawState) || {};

    const collateralType =
      parsed.collateralType || props[COLLATERAL_TYPE_PROPERTY] || null;

    const itemStatuses = parsed.itemStatuses || {};

    const completeRaw = props[CHECKLIST_COMPLETE_PROPERTY];
    const isSaved =
      completeRaw === true ||
      completeRaw === "true" ||
      completeRaw === "TRUE" ||
      completeRaw === "True";

    // Optional: return lastSavedAt if you want to show it in the UI
    const lastSavedAt = parsed.updatedAt || null;

    return res.json({
      collateralType,
      itemStatuses,
      isSaved,
      lastSavedAt,
    });
  } catch (err) {
    console.error("GET /hubspot/collateral-checklist error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /hubspot/collateral-checklist
 * Saves partial state to HubSpot Deal JSON property,
 * and ONLY marks complete if markComplete === true.
 */
app.post("/hubspot/collateral-checklist", async (req, res) => {
  const { dealId, collateralType, itemStatuses, markComplete } = req.body || {};

  if (!dealId) return res.status(400).json({ error: "Missing dealId" });

  const state = {
    version: 1,
    updatedAt: new Date().toISOString(),
    collateralType: collateralType || null,
    itemStatuses: itemStatuses || {},
  };

  const stateJson = JSON.stringify(state);

  try {
    const result = await patchWithStatePropertyFallback(dealId, (stateProp) => {
      const properties = {
        // always store JSON state (partial or complete)
        [stateProp]: stateJson,
      };

      // Persist collateral type as a Deal property too (optional but helpful)
      if (collateralType) {
        properties[COLLATERAL_TYPE_PROPERTY] = collateralType;
      }

      // Only set "complete" + overall status when explicitly marking complete
      if (markComplete) {
        properties[CHECKLIST_COMPLETE_PROPERTY] = "true";
        properties[DEAL_OVERALL_STATUS_PROPERTY] = "Complete";
      } else {
        // make sure "complete" is false during partial saves
        properties[CHECKLIST_COMPLETE_PROPERTY] = "false";
        // (deliberately not touching deal_collateral_dropdown on partial saves)
      }

      return properties;
    });

    console.log(
      "PATCH deal properties:",
      {
        dealId,
        ok: result.ok,
        status: result.status,
        statePropertyUsed: result.statePropertyUsed,
      },
      (result.text || "").slice(0, 200)
    );

    if (!result.ok) {
      return res.status(result.status).json({
        error: "HubSpot update failed",
        details: result.text,
        statePropertyUsed: result.statePropertyUsed,
      });
    }

    return res.json({
      success: true,
      markComplete: Boolean(markComplete),
      statePropertyUsed: result.statePropertyUsed,
    });
  } catch (err) {
    console.error("POST /hubspot/collateral-checklist error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// -----------------------------
// Existing FRED + rate routes (unchanged)
// -----------------------------

async function fetchLatestFredValue(seriesId) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error("FRED_API_KEY not set");

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
  if (!obs || obs.value === "." || obs.value == null) return null;

  const num = parseFloat(obs.value);
  return Number.isNaN(num) ? null : num;
}

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

app.post("/hubspot/update-deal-rates", async (req, res) => {
  console.log("POST /hubspot/update-deal-rates called, body:", req.body);

  const { dealId, properties } = req.body || {};
  if (!dealId || !properties) {
    console.error("Missing dealId/properties");
    return res.status(400).json({ error: "Missing dealId or properties" });
  }

  try {
    const result = await patchDealProperties(dealId, properties);
    console.log(
      "HubSpot API response:",
      result.status,
      (result.text || "").slice(0, 400)
    );

    if (!result.ok) {
      return res.status(result.status).json({
        error: "HubSpot update failed",
        details: result.text,
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
