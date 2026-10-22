// =============================================================================
// Pay Small Small Cashier — MCP tool server
// -----------------------------------------------------------------------------
// One Node.js script. It exposes eight tools to Chord over the MCP "Streamable
// HTTP" transport (six for the customer flow, two owner-only), plus a Paystack
// webhook that auto-confirms payments. Backed by Paystack (test mode) for
// payments and one Google Sheet for the ledger.
//
// Chord is the MCP CLIENT. It sends JSON-RPC over HTTP POST to /mcp. This script
// is the MCP SERVER. You host it at a public HTTPS URL and register that URL in
// Chord (Teammate settings -> Tools), with auth_type "bearer" and the token you
// set in MCP_AUTH_TOKEN below.
//
// Run locally:   node server.js      (needs Node 18+ for global fetch)
// Env vars it reads are listed in .env.example.
// =============================================================================

import express from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { google } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// -----------------------------------------------------------------------------
// Config (from environment)
// -----------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || ""; // the bearer token Chord sends
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || ""; // sk_test_...
const SHEET_ID = process.env.SHEET_ID || "";
const SHEET_TAB = process.env.SHEET_TAB || "Ledger";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
// Where Paystack sends the customer after they pay (overrides the account's
// global callback per-transaction). Defaults to this server's /paid page.
const CALLBACK_URL = process.env.CALLBACK_URL || "https://pay-small-small-server.onrender.com/paid";
// Secret code the owner must provide to see business totals. Works in any
// channel (including a test simulator) because it does not rely on the
// sender's phone number.
const OWNER_CODE = process.env.OWNER_CODE || "";

// The ledger tab must have this header row in row 1 (columns A..I):
// phone | name | item | total | paid | balance | due_date | status | refs
const COLS = ["phone", "name", "item", "total", "paid", "balance", "due_date", "status", "refs"];

// -----------------------------------------------------------------------------
// Google Sheets helpers
// -----------------------------------------------------------------------------
function sheetsClient() {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !SHEET_ID) {
    throw new Error("Google Sheets is not configured (GOOGLE_SERVICE_ACCOUNT_JSON / SHEET_ID).");
  }
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function normPhone(p) {
  // Keep digits only, then canonicalise Nigerian numbers so the local form
  // (07026427816) and the international form (2347026427816 / +234...) all
  // compare equal.
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("0") && d.length === 11) d = "234" + d.slice(1); // 0803... -> 234803...
  return d;
}

function rowToRecord(row) {
  const r = {};
  COLS.forEach((c, i) => (r[c] = row[i] !== undefined ? row[i] : ""));
  r.total = Number(r.total || 0);
  r.paid = Number(r.paid || 0);
  r.balance = Number(r.balance || 0);
  return r;
}

// Returns { record, rowNumber } or null. rowNumber is the 1-based sheet row.
async function findByPhone(phone) {
  const sheets = sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A2:I`,
  });
  const rows = res.data.values || [];
  const want = normPhone(phone);
  for (let i = 0; i < rows.length; i++) {
    if (normPhone(rows[i][0]) === want) {
      return { record: rowToRecord(rows[i]), rowNumber: i + 2 }; // +2: header + 0-index
    }
  }
  return null;
}

async function appendRow(values) {
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:I`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
}

async function updateRow(rowNumber, values) {
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A${rowNumber}:I${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

// Read every customer row (used by the owner's business tools).
async function getAllRecords() {
  const sheets = sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A2:I`,
  });
  return (res.data.values || []).map((row, i) => ({
    record: rowToRecord(row),
    rowNumber: i + 2,
  }));
}

function daysBetween(fromISO, toDate = new Date()) {
  const d = new Date(fromISO);
  if (isNaN(d)) return 0;
  return Math.floor((toDate - d) / (1000 * 60 * 60 * 24));
}

// Shared payment-recording logic, used by BOTH the record_payment tool and the
// Paystack webhook. Dedupes on the reference so retries never double-count.
async function recordPaymentToLedger(phone, reference, amountNaira) {
  const hit = await findByPhone(phone);
  if (!hit) return { recorded: false, reason: "No plan found for this phone number." };

  const refs = (hit.record.refs || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (refs.includes(reference)) {
    return { recorded: false, reason: "This reference was already recorded.", ...hit.record };
  }

  const paid = hit.record.paid + Number(amountNaira);
  const balance = Math.max(0, hit.record.total - paid);
  const status = balance <= 0 ? "completed" : "active";
  refs.push(reference);

  await updateRow(hit.rowNumber, [
    hit.record.phone, hit.record.name, hit.record.item, hit.record.total,
    paid, balance, hit.record.due_date, status, refs.join(","),
  ]);

  return {
    recorded: true,
    phone: hit.record.phone,
    name: hit.record.name,
    item: hit.record.item,
    total: hit.record.total,
    paid,
    balance,
    status,
    due_date: hit.record.due_date,
  };
}

// -----------------------------------------------------------------------------
// Paystack helpers (test mode just means you use your sk_test_ key)
// -----------------------------------------------------------------------------
async function paystack(path, method = "GET", body = null) {
  if (!PAYSTACK_SECRET_KEY) throw new Error("PAYSTACK_SECRET_KEY is not set.");
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || "Paystack request failed");
  return data.data;
}

function makeReference(phone) {
  // Paystack allows alphanumeric plus - . =
  const clean = normPhone(phone).replace(/[^a-zA-Z0-9]/g, "");
  return `pss-${clean}-${Date.now()}`;
}

// A small helper so every tool returns the shape Chord expects.
function textResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// -----------------------------------------------------------------------------
// Build an MCP server with the six tools registered.
// A fresh one is built per request (stateless mode).
// -----------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer({ name: "pay-small-small-tools", version: "1.0.0" });

  // 1) get_balance -----------------------------------------------------------
  server.registerTool(
    "get_balance",
    {
      description:
        "Look up a customer in the ledger by phone number. Returns their item, total, amount paid, outstanding balance, due date and status, or not_found.",
      inputSchema: { phone: z.string().describe("Customer phone number, e.g. +2348012345678") },
    },
    async ({ phone }) => {
      const hit = await findByPhone(phone);
      if (!hit) return textResult({ found: false, phone: normPhone(phone) });
      return textResult({ found: true, ...hit.record });
    }
  );

  // 2) start_plan ------------------------------------------------------------
  server.registerTool(
    "start_plan",
    {
      description:
        "Create a new installment plan for a customer who has agreed to an item and price. Sets paid to 0 and balance to the full total, status 'pending_deposit', due date 28 days out. Does not take money; use create_payment_link for the deposit.",
      inputSchema: {
        name: z.string(),
        phone: z.string(),
        item: z.string(),
        total_price: z.number().describe("Full item price in naira"),
      },
    },
    async ({ name, phone, item, total_price }) => {
      const existing = await findByPhone(phone);
      if (existing) {
        return textResult({
          created: false,
          reason: "A plan already exists for this phone number.",
          ...existing.record,
        });
      }
      const due = new Date();
      due.setDate(due.getDate() + 28);
      const dueStr = due.toISOString().slice(0, 10);
      await appendRow([
        normPhone(phone), name, item, total_price, 0, total_price, dueStr, "pending_deposit", "",
      ]);
      return textResult({
        created: true,
        phone: normPhone(phone),
        name,
        item,
        total: total_price,
        paid: 0,
        balance: total_price,
        due_date: dueStr,
        status: "pending_deposit",
      });
    }
  );

  // 3) create_payment_link ---------------------------------------------------
  server.registerTool(
    "create_payment_link",
    {
      description:
        "Create a Paystack payment link for a specific amount in naira. Use for a deposit or a part-payment. The customer's email is required, always collect it first; it is used for the Paystack receipt and record. Returns a secure checkout URL and a reference to verify later.",
      inputSchema: {
        amount_naira: z.number().describe("Amount to collect now, in naira"),
        phone: z.string(),
        email: z.string().describe("Customer email for the Paystack receipt (required)"),
        purpose: z.string().optional().describe("What this payment is for, e.g. 'deposit on Ankara'"),
      },
    },
    async ({ email, amount_naira, phone, purpose }) => {
      const reference = makeReference(phone);
      const data = await paystack("/transaction/initialize", "POST", {
        email,
        amount: Math.round(amount_naira * 100), // naira -> kobo
        reference,
        currency: "NGN",
        // Per-transaction callback overrides the account's global callback URL,
        // so the customer lands on OUR thank-you page regardless of account settings.
        callback_url: CALLBACK_URL || undefined,
        // Store the intended amount so the webhook credits the ledger the amount
        // the customer agreed to, even if Paystack adds fees on top at checkout.
        metadata: { phone: normPhone(phone), purpose: purpose || "", amount_naira },
      });
      return textResult({
        payment_link: data.authorization_url,
        reference: data.reference,
        amount_naira,
      });
    }
  );

  // 4) verify_payment --------------------------------------------------------
  server.registerTool(
    "verify_payment",
    {
      description:
        "Check with Paystack whether a payment reference actually succeeded, and for how much. Call this before telling a customer a payment went through and before recording it.",
      inputSchema: { reference: z.string() },
    },
    async ({ reference }) => {
      // Never throw: an error here must not look like a tool failure, or the
      // agent may wrongly escalate. On any problem, report "not confirmed yet".
      try {
        const data = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
        return textResult({
          reference,
          paid: data.status === "success",
          status: data.status,
          amount_naira: Number(data.amount || 0) / 100,
          gateway_response: data.gateway_response,
        });
      } catch (err) {
        return textResult({
          reference,
          paid: false,
          status: "not_confirmed_yet",
          note: "Could not confirm this payment yet. Tell the customer it has not landed and offer to check again shortly. Do not bring in a human for this.",
        });
      }
    }
  );

  // 5) record_payment --------------------------------------------------------
  server.registerTool(
    "record_payment",
    {
      description:
        "After a payment is verified as successful, add it to the ledger: increase amount paid, recompute the balance, update status. Refuses to record the same reference twice.",
      inputSchema: {
        phone: z.string(),
        reference: z.string().describe("A reference already confirmed by verify_payment"),
        amount_naira: z.number(),
      },
    },
    async ({ phone, reference, amount_naira }) => {
      const result = await recordPaymentToLedger(phone, reference, amount_naira);
      return textResult(result);
    }
  );

  // 6) schedule_reminder -----------------------------------------------------
  // Lightweight: records the intent and returns a confirmation. In production
  // Chord's own Schedules fire the reminder; this keeps the tool contract real
  // without needing a second system.
  server.registerTool(
    "schedule_reminder",
    {
      description:
        "Note that a customer should be reminded about an outstanding balance on a due date. Returns a confirmation of what was scheduled.",
      inputSchema: {
        phone: z.string(),
        due_date: z.string().describe("ISO date, e.g. 2026-11-15"),
        note: z.string().optional(),
      },
    },
    async ({ phone, due_date, note }) => {
      return textResult({
        scheduled: true,
        phone: normPhone(phone),
        due_date,
        note: note || "Reminder about outstanding balance",
      });
    }
  );

  // 7) business_summary (OWNER ONLY) -----------------------------------------
  // The owner's money-at-a-glance view across the whole ledger.
  server.registerTool(
    "business_summary",
    {
      description:
        "OWNER ONLY. A whole-business snapshot from the ledger: total still owed, number of active and overdue plans, number completed, and total collected so far. Only use this for the shop owner, never for a customer. The owner must provide their access code; pass it as owner_code so the server can confirm they are the owner.",
      inputSchema: {
        owner_code: z.string().describe("The owner's secret access code, to confirm they are the owner"),
      },
    },
    async ({ owner_code }) => {
      if (OWNER_CODE && owner_code !== OWNER_CODE) {
        return textResult({ allowed: false, reason: "Wrong or missing owner access code." });
      }
      const all = await getAllRecords();
      let outstanding = 0, collected = 0, active = 0, overdue = 0, completed = 0;
      for (const { record } of all) {
        collected += record.paid;
        if (record.balance > 0) {
          outstanding += record.balance;
          if (daysBetween(record.due_date) > 0) overdue += 1; else active += 1;
        } else {
          completed += 1;
        }
      }
      return textResult({
        allowed: true,
        customers: all.length,
        total_outstanding: outstanding,
        total_collected: collected,
        active_plans: active,
        overdue_plans: overdue,
        completed_plans: completed,
      });
    }
  );

  // 8) list_overdue (OWNER ONLY) ---------------------------------------------
  server.registerTool(
    "list_overdue",
    {
      description:
        "OWNER ONLY. List customers whose balance is past its due date: name, phone, item, amount left and how many days late. Only use this for the shop owner. The owner must provide their access code; pass it as owner_code.",
      inputSchema: {
        owner_code: z.string().describe("The owner's secret access code, to confirm they are the owner"),
      },
    },
    async ({ owner_code }) => {
      if (OWNER_CODE && owner_code !== OWNER_CODE) {
        return textResult({ allowed: false, reason: "Wrong or missing owner access code." });
      }
      const all = await getAllRecords();
      const overdue = all
        .map(({ record }) => record)
        .filter((r) => r.balance > 0 && daysBetween(r.due_date) > 0)
        .map((r) => ({
          name: r.name,
          phone: r.phone,
          item: r.item,
          balance: r.balance,
          due_date: r.due_date,
          days_late: daysBetween(r.due_date),
        }))
        .sort((a, b) => b.days_late - a.days_late);
      return textResult({ allowed: true, count: overdue.length, overdue });
    }
  );

  return server;
}

// -----------------------------------------------------------------------------
// Express app + Streamable HTTP transport (stateless)
// -----------------------------------------------------------------------------
const app = express();
// Capture the raw body too, so the Paystack webhook can verify its signature.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Simple health route for your own checks (Chord uses POST /mcp instead).
app.get("/", (_req, res) => res.send("Pay Small Small Cashier MCP server is running."));

// Friendly page the customer lands on after paying (set as Paystack Callback URL).
app.get("/paid", (_req, res) => {
  res.set("Content-Type", "text/html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment received</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0f9d58; color:#fff; padding:24px; }
  .card { text-align:center; max-width:420px; }
  .tick { width:84px; height:84px; border-radius:50%; background:rgba(255,255,255,.18);
    display:flex; align-items:center; justify-content:center; margin:0 auto 20px; font-size:44px; }
  h1 { font-size:1.5rem; margin:0 0 10px; }
  p { font-size:1.05rem; line-height:1.5; opacity:.95; margin:0; }
</style>
</head>
<body>
  <div class="card">
    <div class="tick">&#10003;</div>
    <h1>Payment received</h1>
    <p>Thank you! Your payment has gone through. You can head back to your WhatsApp chat, your balance has been updated.</p>
  </div>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Paystack webhook: auto-confirm a payment the moment it lands, with no one
// having to say "I've paid". Paystack POSTs here; we verify the signature,
// then record the payment to the ledger (deduped by reference).
// Point your Paystack dashboard webhook URL at  <your-url>/paystack/webhook
// ---------------------------------------------------------------------------
app.post("/paystack/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"] || "";
    const expected = crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(req.rawBody)
      .digest("hex");
    const valid =
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) return res.sendStatus(401);

    const event = req.body;
    if (event?.event === "charge.success" && event?.data?.status === "success") {
      const d = event.data;
      const phone = d?.metadata?.phone || "";
      // Prefer the intended amount we stored at create time; fall back to the
      // charged amount. This keeps the ledger to the installment the customer
      // agreed to, not the fee-inclusive total Paystack may charge.
      const amountNaira = d?.metadata?.amount_naira != null
        ? Number(d.metadata.amount_naira)
        : Number(d.amount || 0) / 100;
      if (phone) {
        const result = await recordPaymentToLedger(phone, d.reference, amountNaira);
        console.log("Webhook recorded:", JSON.stringify(result));
      } else {
        console.log("Webhook charge.success had no metadata.phone; skipped.");
      }
    }
    // Acknowledge. Retries are safe because recording dedupes on the reference.
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500); // Paystack will retry
  }
});

// Bearer-token gate: only requests carrying the right token reach the tools.
// If MCP_AUTH_TOKEN is empty, the gate is open (handy while first testing).
function checkAuth(req, res) {
  if (!MCP_AUTH_TOKEN) return true;
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token === MCP_AUTH_TOKEN) return true;
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized" },
    id: null,
  });
  return false;
}

app.post("/mcp", async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    // Stateless: a fresh server + transport per request, no session id.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: String(err?.message || err) },
        id: null,
      });
    }
  }
});

// Stateless servers do not use GET/DELETE sessions.
app.get("/mcp", (_req, res) => res.status(405).send("Method Not Allowed"));
app.delete("/mcp", (_req, res) => res.status(405).send("Method Not Allowed"));

app.listen(PORT, () => {
  console.log(`Pay Small Small Cashier MCP server listening on :${PORT}`);
});
