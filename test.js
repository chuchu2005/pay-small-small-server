// Quick integration test. Run with:
//   node --env-file=env-values.txt test.js
// It checks (1) Google Sheets read, (2) Paystack initialize, (3) Paystack verify.
// It does NOT need the MCP server to be running.

import { google } from "googleapis";

const { PAYSTACK_SECRET_KEY, SHEET_ID, SHEET_TAB = "Sheet1", GOOGLE_SERVICE_ACCOUNT_JSON } = process.env;

function ok(m) { console.log("  ✓ " + m); }
function bad(m) { console.log("  ✗ " + m); }

async function testSheets() {
  console.log("\n[1] Google Sheets read");
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1:I`,
  });
  const rows = res.data.values || [];
  ok(`read ${rows.length} row(s) from ${SHEET_TAB}`);
  if (rows[1]) ok(`first customer: ${rows[1][1]} owes balance ${rows[1][5]} on ${rows[1][2]}`);
  else bad("no data rows found (did you seed the sheet?)");
}

async function paystack(path, method = "GET", body = null) {
  const res = await fetch(`https://api.paystack.co${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function testPaystack() {
  console.log("\n[2] Paystack initialize (test mode)");
  const init = await paystack("/transaction/initialize", "POST", {
    email: "test@example.com",
    amount: 10000, // 100 naira in kobo
    currency: "NGN",
  });
  if (!init.status) { bad("initialize failed: " + init.message); return; }
  ok("payment link: " + init.data.authorization_url);
  ok("reference: " + init.data.reference);

  console.log("\n[3] Paystack verify");
  const ver = await paystack(`/transaction/verify/${init.data.reference}`);
  if (!ver.status) { bad("verify failed: " + ver.message); return; }
  ok(`verify works. status = ${ver.data.status} (expected 'abandoned' until someone pays)`);
}

(async () => {
  try { await testSheets(); } catch (e) { bad("Sheets error: " + (e.message || e)); }
  try { await testPaystack(); } catch (e) { bad("Paystack error: " + (e.message || e)); }
  console.log("\nDone. If all three show ✓, your integrations are good.");
})();
