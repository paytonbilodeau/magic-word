# What the checks establish

Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run bundle:worker` from a clean checkout. CI runs the same checks on Node 24 and 26. The Worker command builds a deployment artifact locally. It never provisions resources.

| Requirement | Pass condition | Evidence |
|---|---|---|
| Instagram comment to DM | A signed keyword webhook emits one private reply to the comment ID. A duplicate webhook emits zero additional sends. An optional public reply goes to the correct comment. | `test/meta.test.ts` |
| Correct conversation timing | A comment alone leaves the chat window closed. A subsequent inbound message opens it. Old backfilled comments expire. A timed-out private send is held for reconciliation. | `test/meta.test.ts`, `test/comment_queue.test.ts` |
| Rule and graph correctness | Specific posts take precedence, next-post binding works, unpublished edits stay separate, branches run, clicks open the expected next step. | `test/automations.test.ts`, `test/flows.test.ts` |
| Operator control | A real SDK client can discover the tools, read console views, build a draft, publish in the demo, check the match, tag contacts, save fields, manage folders, restore a flow, and inspect results after a client restart. | `mcp/acceptance.mjs` |
| External channel adapters | Signed/authenticated messages reach the intended recipient through mocked Telegram, Messenger and WhatsApp transports. Duplicate and stale inputs do not send again. Ambiguous provider responses are retained. | `test/channels.test.ts` |
| No live credentials required | The demo uses the same Worker handler and genuine SQL. It blocks external application fetches. Disconnected write attempts produce errors. | `scripts/runtime.mjs`, `mcp/acceptance.mjs` |
| Owner access and deletion | Invalid signatures and cross-account revocations fail to affect the owner. A verified deletion removes the matching person's structured records while another person's fields survive. | `test/meta.test.ts`, `test/agent.test.ts` |
| Remote MCP | SDK client initializes, lists and calls via authenticated Streamable HTTP. A missing credential or a foreign browser origin fails. Locally signed OAuth tokens exercise signature, expiry, issuer, audience, owner binding and scope checks. The test supplies a local public key set. | `mcp/acceptance.mjs` |
| Self-hosting | Fresh migrations and sample records persist in SQLite across process restarts. The TLS reverse proxy, external identity provider and delivery accounts are operator-owned. | `scripts/storage.mjs`, `scripts/host.mjs`, `mcp/acceptance.mjs` |

Provider acceptance requires a connected account and a real response with an identifier. Delivery to a device requires its own receipt or recipient confirmation. A local test cannot establish either of those. A hosted ChatGPT OAuth flow, a production Cloudflare deployment and audience-scale throughput need a deployment-specific acceptance run. The additional channels currently implement keyword and manual text replies. The [comparison](MANYCHAT.md) identifies further feature gaps.
