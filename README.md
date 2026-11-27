# Magic Word

Magic Word is a **ManyChat alternative** for Instagram auto-DMs. Someone comments **GUIDE** on your Instagram reel. Magic Word sends the private reply you wrote, records the result, and shows the conversation in your inbox. You can set it up in a browser or ask an MCP client to build the automation.

The Instagram engine and visual editor come from [FewChat by Jason Cooperson](https://github.com/jasonc00person/fewchat). Magic Word adds a local SQLite host, MCP control and three more messaging channels.

## Set this up for my AI

Give your coding assistant this prompt:

> Set this up for my AI: https://github.com/paytonbilodeau/magic-word

Claude Code, Codex and other assistants with terminal access can follow the [agent setup instructions](AGENTS.md). The installer connects the tools and runs a sample comment through the automation. You can try everything in the example before choosing a host or signing in to Instagram.

## Try it locally

Install Node.js 24 or 26 and Git, then run:

```sh
git clone https://github.com/paytonbilodeau/magic-word.git
cd magic-word
npm ci
npm run example
npm run preview
```

The example creates a GUIDE automation through MCP and checks two comments in an isolated sample inbox. You should see:

```text
“GUIDE please” → Send the guide
“Just looking” → no match
Messages sent: 0
```

Open [the sample inbox](http://127.0.0.1:8791/admin/dashboard). Choose **Open sample inbox**. The demo uses fictional contacts and blocks outgoing network requests. Your drafts persist between runs. No Meta, Cloudflare or AI account is needed.

![Magic Word dashboard showing fictional contact and delivery metrics](assets/screenshots/magic-word-home.png)

## Use it from your AI

Register the absolute path to `mcp/stdio.mjs` with Claude Code, Codex or another stdio MCP client. The local MCP opens the same sample database, even when the browser console is closed. After connecting, try:

> Create a draft for Instagram comments containing GUIDE. Send “Here’s the guide” with a button to https://example.com/guide. Show me the graph and leave it unpublished.

> Which comments are waiting for a reply? Show me the matching rule and the delivery status.

The [MCP guide](docs/MCP.md) covers desktop clients, remote HTTPS, owner authentication and read-only access.

## What runs

| Surface | Features |
|---|---|
| Instagram | Comment-to-DM with an optional public reply, DM keywords, first message, story replies and mentions, flow editor, quick replies, delays, conditions, split tests, tags, inbox and metrics |
| Additional channels | Facebook Page comment-to-DM on selected posts. Telegram, Messenger and WhatsApp inbound text, keyword rules, manual replies and delivery records through MCP |
| YouTube | Read recent uploads without a key. Read public comment threads with a YouTube API key or a local Composio connection. |
| Agent tools | Draft and publish flows, simulate matching comments, inspect contacts, save fields, handle inbox replies, manage settings and review receipts |
| Hosting | Node + SQLite on your hardware or VPS, or a Worker with D1 in your Cloudflare account. The Worker serves the console and authenticated MCP at the same HTTPS address. |

The core needs no model API key and has no per-contact software charge. Live channels need provider credentials, an HTTPS webhook and applicable permissions. Optional AI replies and external services can incur charges. TikTok, SMS, email delivery and team campaign management have no transport or service in this release.

- [Deploy with Docker Compose and HTTPS, or run Node and SQLite directly](docs/SELF-HOST.md)
- [Cloudflare and Instagram setup](SETUP.md)
- [Connect more channels](docs/CHANNELS.md)
- [Manychat pricing, feature comparison and public-source audit](docs/MANYCHAT.md)
- [Acceptance tests and verification boundaries](docs/ACCEPTANCE.md)
- [License and original project credit](NOTICE.md)

## Check your copy

```sh
npm run typecheck
npm test
```

The suite exercises signed webhooks, duplicate delivery, replies, flows, persistence and the MCP protocol with synthetic accounts.
