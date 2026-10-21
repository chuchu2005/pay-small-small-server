# Pay Small Small Cashier — MCP tool server

One Node.js script (`server.js`) that gives the Chord teammate its six tools,
backed by Paystack test mode and one Google Sheet.

## What it exposes

Over MCP Streamable HTTP at `POST /mcp`:

- `get_balance` — find a customer by phone, return their plan.
- `start_plan` — create a new installment plan (no money yet).
- `create_payment_link` — Paystack checkout link + reference for an amount in naira.
- `verify_payment` — ask Paystack if a reference actually paid.
- `record_payment` — after verify, update paid/balance/status in the sheet (won't double-count a reference).
- `schedule_reminder` — note a due-date reminder.

## Set up the Google Sheet

1. Create a sheet. Name the first tab `Ledger`.
2. Put this header row in row 1, columns A to I:
   `phone | name | item | total | paid | balance | due_date | status | refs`
3. (Optional) add a test customer row so `get_balance` has something to find, e.g.
   `+2348011112222 | Chioma | Ankara | 25000 | 15000 | 10000 | 2026-11-15 | active |`

## Get credentials

- Paystack: dashboard → Settings → API Keys → copy the **test** secret key (`sk_test_...`).
- Google: in Google Cloud, enable the Sheets API, create a **service account**, make a
  JSON key. Open the sheet → Share → add the service account's `client_email` as **Editor**.

## Run locally (optional sanity check)

```
cp .env.example .env     # fill in the values
npm install
npm start
```

## Deploy (Render example)

1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect the repo.
3. Build command: `npm install`  Start command: `npm start`
4. Add the environment variables from `.env.example` (do NOT commit real secrets).
5. Deploy. Your public URL is like `https://your-app.onrender.com`. The MCP endpoint
   is that URL + `/mcp`.

Railway works the same way (New Project → Deploy from repo → add the same variables).

## Register in Chord

Teammate settings → Tools → add a tool / MCP server:

- URL: `https://your-app.onrender.com/mcp`
- auth_type: `bearer`
- token: the same value as `MCP_AUTH_TOKEN`

Then run Chord's health + tool-discovery probes. You should see the six tools.
