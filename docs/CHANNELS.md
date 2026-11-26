# Additional channels

Instagram uses the graph editor and inbox described in the main README. The following adapters share a separate text inbox, keyword rules and outbound receipts. They accept incoming private text. Matching uses whole words or phrases, with comma-separated alternatives. Each incoming provider event is claimed once. A lost response leaves a visible unknown state. Check the provider conversation before issuing another send.

Configure secrets in the Node host's private service environment, or in Worker secrets. After changing bindings, restart or deploy your host. No automated step opens or purchases a provider account.

| Channel | Credentials and setup | Webhook |
|---|---|---|
| Telegram | Create a Bot API bot and store `TG_BOT_TOKEN`. Choose a random `TG_WEBHOOK_SECRET` and give that same value to Telegram as `secret_token` when calling `setWebhook`. Subscribe to messages. | `/hooks/telegram` |
| Facebook Messenger | Set `FB_PAGE_ID`, `FB_PAGE_TOKEN`, `CHANNEL_META_SECRET` (Meta app secret), and `CHANNEL_VERIFY_TOKEN` (your chosen verify token). Subscribe the intended Page to message events and obtain the required Page messaging access. | `/hooks/messenger` |
| WhatsApp Cloud API | Set `WA_PHONE_ID`, `WA_TOKEN`, `CHANNEL_META_SECRET` and `CHANNEL_VERIFY_TOKEN`. Subscribe the business account to messages and configure an eligible phone number. Messenger and WhatsApp share an app secret in this release. | `/hooks/whatsapp` |

Use `channel_connections` to check that credentials are configured. This check addresses configuration only. Use `save_channel_rule` to create a disabled rule. When ready, enable it and send a test inbound message from a separate account you control. Inspect `channel_inbox` for the incoming event and provider acceptance. For a manual reply, `reply_on_channel` requires a request UUID. Reusing the same UUID and text returns the existing receipt.

These adapters require an inbound message in the last 24 hours for outgoing manual replies. Group and bot Telegram messages, other Messenger Pages, and other WhatsApp number IDs are ignored. Media, multistep Instagram graphs, WhatsApp outbound templates, broadcasts and shared-team assignment do not run on these adapters. Provider acceptance and delivery to a phone are distinct events.

[Telegram Bot API](https://core.telegram.org/bots/api) · [Messenger Page messages](https://developers.facebook.com/docs/graph-api/reference/page/messages) · [WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview)
