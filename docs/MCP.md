# Control Magic Word with MCP

## Codex, Claude Code and other local clients

Install project dependencies first. Replace the example script path with the absolute path to your checkout.

```sh
codex mcp add magic-word -- node /absolute/path/to/magic-word/mcp/stdio.mjs
claude mcp add -s user -- magic-word node /absolute/path/to/magic-word/mcp/stdio.mjs
```

Start a new client session. Call `status`. A default installation opens the fictional sample inbox locally. Drafts persist between sessions. The same data appears in the local browser preview. No preview process is required for stdio.

For clients with a JSON stdio configuration, including compatible Cursor and Gemini clients, the server entry has this shape. Each client controls where its configuration lives. A desktop app may need an absolute Node executable if its PATH differs from the terminal.

```json
{
  "mcpServers": {
    "magic-word": {
      "command": "node",
      "args": ["/absolute/path/to/magic-word/mcp/stdio.mjs"]
    }
  }
}
```

To operate a real account, set `MAGICWORD_URL` and `MAGICWORD_PASSWORD_FILE` in the MCP process environment. Use a private JSON file containing the console's `ADMIN_PASSWORD`, with mode 0600 on Unix. A process-level `MAGICWORD_ADMIN_PASSWORD` also works. Keep credentials out of committed client configurations. `MAGICWORD_READ_ONLY=1` excludes all write tools from the catalog.

## Remote clients and ChatGPT

Run the gateway beside the backend or on another host with access to it. It listens on loopback port 8792. Expose only the TLS reverse proxy. Configure:

| Setting | Value |
|---|---|
| `MAGICWORD_URL`, `MAGICWORD_PASSWORD_FILE` | Console origin and backend owner credential |
| `MAGICWORD_MCP_PUBLIC_URL` | Full public endpoint, e.g. `https://mcp.example.org/mcp` |
| `MAGICWORD_OAUTH_ISSUER`, `MAGICWORD_OAUTH_JWKS` | Your existing OAuth/OIDC authorization server's HTTPS issuer and signing-key endpoint |
| `MAGICWORD_OAUTH_SUBJECT` | Exact owner subject ID at that issuer |
| `MAGICWORD_MCP_PORT` | Optional loopback port, default 8792 |

Configure the issuer to mint expiring RS256 or ES256 access tokens targeted at the **full public MCP URL**, with the owner as subject. Grant `magic-word.read` for reads and both `magic-word.read magic-word.write` for writes. Configure the client registration and its redirect URI at the issuer, with PKCE support. The gateway publishes protected-resource metadata at `/.well-known/oauth-protected-resource/mcp`. Route that path and `/mcp` to the gateway. Start it with `node --env-file=/absolute/path/to/private.env mcp/http.mjs`.

In a ChatGPT workspace that supports custom MCP apps, enter the public HTTPS MCP URL and select OAuth. Complete consent at your issuer. Other remote MCP clients can use the same server if they support Streamable HTTP and a compatible authentication method. Grok and Antigravity compatibility depends on the client surface, version and policy. Use a supported connector or client bridge for products without native MCP imports. [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) · [ChatGPT app authentication](https://developers.openai.com/apps-sdk/build/auth/)

For a client that can supply a static Authorization header, the alternate gateway mode accepts a separately generated `MAGICWORD_MCP_TOKEN` of at least 32 characters. Keep it separate from the backend password. OAuth mode disables static-token fallback. No public endpoint is opened by installation.

## What agents can do

- Inspect templates and edit the full Instagram graph. Create, rename, duplicate, publish, toggle, trash, restore or purge a flow. Manage folders and bulk moves. Simulate a comment match without sending.
- Read comments, threads, tags, fields, metrics, reached audiences, connection health, preferences and pending deletion requests. Page through large results.
- Reply, react, tag, pause, resume, manage contact fields, set account/individual AI behavior, edit learned answers and update Instagram conversation starters or the menu.
- Configure and inspect keyword rules for Telegram, Messenger and WhatsApp. Review their text inboxes and send eligible manual replies using a stable request ID.

Use `tools/list` for the current names, argument schemas and effect annotations. A tool that can publish, send or erase content requires explicit intent. Credentials, provider account consent, infrastructure provisioning and access review stay with the operator. The SDK acceptance suite covers stdio and authenticated HTTP. Live ChatGPT consent and named third-party client UIs require their own installation tests.
