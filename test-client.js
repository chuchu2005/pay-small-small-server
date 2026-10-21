// Talks to your RUNNING MCP server and calls the real tools.
// Terminal 1:  node --env-file=.env server.js
// Terminal 2:  node --env-file=.env test-client.js

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.MCP_AUTH_TOKEN || "";
const URL_MCP = `http://localhost:${PORT}/mcp`;

function show(label, res) {
  const text = res?.content?.[0]?.text ?? JSON.stringify(res);
  console.log(`\n== ${label} ==\n${text}`);
}

const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
const client = new Client({ name: "local-test", version: "1.0.0" });

await client.connect(transport);

const tools = await client.listTools();
console.log("Tools the server exposes:", tools.tools.map((t) => t.name).join(", "));

// 1) Real balance lookup for the seeded customer
show("get_balance (Chioma)", await client.callTool({
  name: "get_balance",
  arguments: { phone: "2348011112222" },
}));

// 2) Real payment link for a ₦5,000 part-payment
const pay = await client.callTool({
  name: "create_payment_link",
  arguments: { email: "chioma@example.com", amount_naira: 5000, phone: "2348011112222", purpose: "part-payment on Ankara" },
});
show("create_payment_link (₦5,000)", pay);

// 3) Verify that reference (will be 'abandoned' until the link is actually paid)
const ref = JSON.parse(pay.content[0].text).reference;
show("verify_payment", await client.callTool({
  name: "verify_payment",
  arguments: { reference: ref },
}));

// 4) Owner view. Uses OWNER_CODE from your .env.
const ownerCode = process.env.OWNER_CODE || "";
show("business_summary (owner)", await client.callTool({
  name: "business_summary",
  arguments: { owner_code: ownerCode },
}));
show("list_overdue (owner)", await client.callTool({
  name: "list_overdue",
  arguments: { owner_code: ownerCode },
}));

await client.close();
console.log("\nDone. The server and its tools work end to end.");
