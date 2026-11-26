# Run your own inbox

## Local preview

Run `npm ci` and `npm run preview` with Node 24 or 26. Open `http://127.0.0.1:8791/admin/dashboard`. Choose **Open sample inbox**. The demo account and conversations are synthetic. Outbound requests from the application process are disabled. The stdio MCP opens this same SQLite store without a running HTTP server.

## Docker Compose with automatic HTTPS

Use a host you control with Docker Compose installed, a public hostname pointing to it and inbound ports 80 and 443 available. The repository includes the app, SQLite volume and Caddy HTTPS reverse proxy. From the checkout on that host:

```sh
cp -n deploy/host.env.example .env.host
chmod 600 .env.host
# Set the public hostname, business name and contact email in .env.host.
docker compose --env-file .env.host up -d --build
```

Open your HTTPS hostname. Read the owner password privately with `docker compose --env-file .env.host exec app node -p "require('/data/live/credentials.json').ADMIN_PASSWORD"`. The verify token for Meta is in the same file. For Instagram, set the three Instagram values in `.env.host`, rerun Compose and follow the webhook and consent steps below. The database and owner credentials persist in the `inbox` volume. Caddy stores certificates in its own volume. Domain, server and provider charges depend on your setup. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)

For remote MCP, configure owner OAuth or the separate random gateway token from [the MCP guide](MCP.md) in `.env.host`, then run `docker compose --env-file .env.host --profile mcp up -d --build`. The endpoint is `https://YOUR_HOST/mcp`. Only Caddy publishes host ports. Plain stdio clients can also connect directly to the console using `MAGICWORD_URL` and a private owner credential.

## A machine with a public HTTPS address

The Node host runs the Instagram Worker handler against SQLite on local disk. It uses a one-minute timer for due flows. The inbox polls on this host. On Cloudflare, the Durable Object also supplies WebSocket updates. Cloudflare Workers AI transcription needs a compatible binding and is unavailable on the standalone host. Keep one production HTTP process per database so there is one scheduler.

1. Clone the repository, install Node 24 or 26, and run `npm ci`. Make a durable data directory accessible only by the service account.
2. Set the values below in your service manager's private environment file. These names contain examples and placeholders. Put actual secrets into the private file on the host. Node's `--env-file` option can load it.
   For a Telegram, Messenger or WhatsApp-only host, omit the Instagram handle, app ID and app secret together. Set the selected channel credentials from [the channel guide](CHANNELS.md) and use the owner password to sign in.
3. Run the host with `node --env-file=/absolute/path/to/private.env scripts/host.mjs --live`. Configure your existing process manager to restart it on failure.
4. Terminate HTTPS at a reverse proxy. Forward your public hostname to `127.0.0.1:8791`. A Caddy site block can contain `reverse_proxy 127.0.0.1:8791`. Preserve the public Host and HTTPS scheme. Keep the backend bound to loopback unless a private container network requires another address.
5. Read the generated `live/credentials.json` inside the data directory privately. The file contains the owner password and webhook verify token. Configure the Instagram professional account, app, permissions, redirect URLs and webhook fields listed in [the provider setup](../SETUP.md). For Node, use your public hostname in place of the Worker address. Supply the verify token to Meta in its dashboard.
6. Open the public console, complete the Instagram OAuth consent flow, and verify the displayed identity. Test with a second account you control. Confirm the exact recipient, message, provider receipt and duplicate count before enabling a real campaign.

```dotenv
MAGICWORD_PUBLIC_URL=https://inbox.example.org
MAGICWORD_DATA_DIR=/var/lib/magic-word
MAGICWORD_IG_HANDLE=yourhandle
MAGICWORD_BUSINESS=Your business
MAGICWORD_CONTACT_EMAIL=privacy@example.org
MAGICWORD_SITE=example.org
MAGICWORD_LINK=https://example.org/guide
META_IG_APP_ID=your_instagram_app_id
META_APP_SECRET=your_instagram_app_secret
PORT=8791
```

The node process generates `ADMIN_PASSWORD`, `INBOUND_SECRET`, and `META_VERIFY_TOKEN` at first start. Keep the checkout writable for its transient runtime bundle, or run it in a writable deployment directory. Protect the data directory, private environment file, and any backups. SQLite WAL mode can store committed changes in a companion file while the service runs. Use SQLite's backup facility or stop the process cleanly before copying the database. Restore into an isolated host first. A server that sleeps or loses its public connection cannot reliably receive webhooks.

## Cloudflare alternative

Use [the Cloudflare installer](../SETUP.md) if you want Workers, D1, Queue and Durable Object resources in your own account. The installer provisions real resources. Run the local preview first if you only want to try it. A free allocation depends on workload and current provider quotas. The cost comparison and links are in [the audit](MANYCHAT.md).

## Connect an MCP client to production

Set `MAGICWORD_URL` to the HTTPS origin. Set `MAGICWORD_PASSWORD_FILE` to a private JSON file holding the corresponding `ADMIN_PASSWORD`, readable only by the owner. A Node deployment already has this file. For Cloudflare, supply the generated Worker admin password via a private file or the process environment. When no URL is configured, the stdio tool opens the isolated demo database. See [MCP setup](MCP.md).

The operator is responsible for permissions and provider review, uptime, secret rotation, backups, privacy notices, and handling deletion requests. Signed deletion requests are recorded with a public status code. Fulfillment requires identifying the right person's records and any exported copies.
