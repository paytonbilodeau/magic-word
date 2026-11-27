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

## Facebook Page comments

Subscribe the Page to feed changes and Messenger messages. Use a Page token with `pages_messaging` and the required Page subscription and read access. Standard Access is limited to app roles. Select a regular published Page post and provide its full `PAGEID_POSTID` identifier. Use `page_comment_rules` to inspect the rules and `save_page_comment_rule` to add one. A disabled rule is a draft.

A matching comment can receive one private text message, addressed to the comment ID. Magic Word suppresses additional sends to the same author on that post, suppresses webhook retries, and records expired comments. A lost provider response stays unconfirmed. Check `channel_inbox` with `channel: facebook_comments` for results. A comment by itself does not open an ordinary Messenger conversation. A private incoming message opens its 24-hour window. Page-owned posts with a known author and a matching rule are supported. Provider rules govern actual eligibility. [Meta private replies](https://developers.facebook.com/docs/messenger-platform/discovery/private-replies/) · [Page webhooks](https://developers.facebook.com/docs/graph-api/webhooks/reference/page/)

[Telegram Bot API](https://core.telegram.org/bots/api) · [Messenger Page messages](https://developers.facebook.com/docs/graph-api/reference/page/messages) · [WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview)

## Instagram and YouTube reads

The native Instagram connection can read recent posts, their comments, and inbox activity directly from Meta. The tools are `instagram_live_media`, `instagram_live_comments` and `instagram_live_inbox`. The comments tool verifies that the post belongs to the connected account. Use `thread` for message history ingested by your webhook.

For YouTube, set `YOUTUBE_CHANNEL_ID` to your public channel's full UC identifier in the host environment. On Cloudflare add it to the private `.env` and rerun setup. `youtube_videos` returns recent public uploads from the official channel feed with no API key. `youtube_comments` reads public comment threads when you supply a YouTube Data API v3 key in `YOUTUBE_DATA_API_KEY`. Restrict the key to the YouTube Data API. Google's API supports public replies, but this integration currently reads threads. YouTube private messaging is outside its capabilities. [YouTube comment threads](https://developers.google.com/youtube/v3/docs/commentThreads/list) · [Google API quotas](https://developers.google.com/youtube/data/determine_quota_cost)

If you already use the Composio CLI on your computer, run `npm run connect:host -- --composio` after deploying. The command binds this checkout to the selected active Instagram and YouTube accounts. Set `COMPOSIO_BIN` to the installed executable's absolute path if the desktop client's PATH differs. When several accounts are active, specify `MAGICWORD_INSTAGRAM_CONNECTION` and/or `MAGICWORD_YOUTUBE_CONNECTION` by alias or connection ID. Magic Word verifies the selected Instagram handle against the deployment configuration. The local MCP client prefers the hosted credentials and falls back to its selected Composio account when a host credential is missing. It can read Instagram posts, inbox activity, post comments and YouTube comments through those connections. Google's project quota still applies. Remote clients use the credentials installed on the host. Composio access on the computer does not activate the hosted Instagram webhook.

## TikTok

Manychat connects eligible TikTok accounts and handles inbound DMs under its approved integration. An independent application needs TikTok Business Messaging API access and the appropriate account permissions. Linking a creator account to TikTok for Business is an eligibility option in Manychat. Converting to a Verified Business Account can affect Creator Rewards and music-library access. A publishing connection does not grant messaging access. Magic Word currently has no TikTok messaging adapter. [Manychat account eligibility](https://help.manychat.com/en/articles/17742033-how-to-connect-tiktok-to-manychat) · [TikTok messaging requirements](https://business-api.tiktok.com/portal/docs/send-a-message-to-a-conversation/v1.3)
