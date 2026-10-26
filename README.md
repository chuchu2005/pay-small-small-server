# Pay Small Small Cashier

A Chord WhatsApp agent for **Mama T Fabrics**, a Nigerian fabric shop that sells on
installments ("pay small small"). The agent runs the whole money flow: start a plan,
take a Paystack payment for the exact agreed amount, confirm it on its own, keep a
Google Sheet ledger straight, and give the owner a private business view.

This repo holds the two things that make the agent:

- `SKILL.md` — the skill I wrote: the business context, the money-safety rules, and how
  the agent should handle every kind of customer and the owner. This is the file loaded
  into the Chord teammate.
- `server.js` — one Node.js MCP server (Streamable HTTP, stateless) that gives the agent
  its tools and auto-confirms payments through a Paystack webhook.

## The tools the server exposes

Over MCP at `POST /mcp` (bearer auth):

- `get_balance` — find a customer by phone, return their plan.
- `start_plan` — create a new installment plan (no money yet).
- `create_payment_link` — Paystack checkout link + reference for an amount in naira. The
  intended amount is stored in Paystack metadata so the ledger stays correct even if the
  account is set to "customer bears fees".
- `verify_payment` — ask Paystack if a reference actually paid. Never throws; returns a
  clean "not confirmed yet" on any problem so the agent does not wrongly escalate.
- `record_payment` — update paid/balance/status in the sheet; will not double-count a reference.
- `schedule_reminder` — note a due-date reminder.
- `business_summary` — owner only, behind an access code: total owed, active/overdue/completed, total collected.
- `list_overdue` — owner only, behind an access code: who is past due, how much, how many days late.

## Payments confirm themselves

`POST /paystack/webhook` verifies the Paystack signature (HMAC-SHA512 of the raw body)
and records the payment in the ledger from the metadata amount, so a payment lands in the
sheet without any human or agent step. `GET /paid` is a small thank-you page for the
customer after checkout. `GET /` is a health check.

## Set up the Google Sheet

1. Create a sheet. The tab this server reads is set by `SHEET_TAB` (default `Sheet1`).
2. Put this header row in row 1, columns A to I:
   `phone | name | item | total | paid | balance | due_date | status | refs`
3. Optional test customer so `get_balance` has something to find:
   `2348011112222 | Chioma | Ankara | 25000 | 15000 | 10000 | 2026-11-15 | active |`

## Credentials

- Paystack: dashboard → Settings → API Keys → copy the **test** secret key (`sk_test_...`).
  For live use, also turn off "customer bears fees" so charged = quoted.
- Google: enable the Sheets API, create a **service account**, make a JSON key, then
  Share the sheet with the service account's `client_email` as **Editor**.

## Environment variables

See `.env.example`. The key ones: `MCP_AUTH_TOKEN` (same value you give Chord),
`PAYSTACK_SECRET_KEY`, `SHEET_ID`, `SHEET_TAB`, `GOOGLE_SERVICE_ACCOUNT_JSON` (the whole
key on one line), `OWNER_CODE` (the owner's access code), and `CALLBACK_URL`
(your deployed URL + `/paid`).

## Run locally

```
cp .env.example .env     # fill in the values
npm install
npm start
# in another terminal, exercise the real tools:
node --env-file=.env test-client.js
```

## Deploy (Render)

1. Push this repo to GitHub.
2. Render → New → Web Service → connect the repo.
3. Build: `npm install`  Start: `npm start`
4. Add the environment variables from `.env.example` (never commit real secrets).
5. Deploy. The MCP endpoint is your URL + `/mcp`.

Note: on Render free tier the service sleeps after ~15 min idle, and the cold start can
outrun Chord's tool-call wait. Keep a uptime pinger on `GET /` every ~10 min, or use a
paid tier, for a smooth demo.

## Set the Paystack webhook

Paystack dashboard → Settings → API Keys & Webhooks → Webhook URL:
`https://your-app.onrender.com/paystack/webhook`

## Register in Chord

Teammate → Tools → add MCP server:

- URL: `https://your-app.onrender.com/mcp`
- auth_type: `bearer`
- token: the same value as `MCP_AUTH_TOKEN`

Run Chord's health and tool-discovery probes; you should see all eight tools. Add
`SKILL.md` as the teammate's instructions and publish.

## AI tools used

I used Claude (in the Claude desktop app, driving my browser and my machine) to help pick
the idea, write and iterate the `SKILL.md`, build and debug `server.js`, wire up Paystack,
Google Sheets and the webhook, and work through the deployment problems documented in the
field notes. The agent itself is built and runs entirely on Chord.
