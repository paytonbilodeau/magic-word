// What the optional AI knows about what you sell, for answering "will it work on X?" questions in one or two lines.
// Curated by hand, not fetched live: a reply has about 30 seconds. Fill it in when you set the AI up (docs/AI.md), and
// add a line every time the AI hands off a question it should have known, so it never asks you twice.

export const KNOWLEDGE = `# Product knowledge (answer from this, never guess)

## <<FILL: the community's name>> (the community)
<<FILL: price and billing, what's inside in one paragraph, who it's for, how people get started after joining>>

## <<FILL: your flagship product or the most-asked-about thing inside, or delete this section>>
<<FILL: what it is, what it needs (computer, apps, costs), how hard setup is, the honest "no" answers people ask about>>

## <<FILL: each free resource your automations send (the lead magnets), one section each, or delete this section>>
<<FILL: what it is and the 2-3 questions people ask about it, answered>>

## Joining from another country (can't open the link, card declined)
Answer these yourself, don't hand off the first time.
- The link won't open, loads blank, or says "under maintenance": common in Nigeria and some other African countries. It's Skool's side, not them: Skool's security flags whole internet ranges there as risky (bot traffic), so the site refuses to load. The fix is a VPN set to a European or US server (the Netherlands works well), then open the link. Keep the VPN on until they're inside. Switching to mobile data or another carrier sometimes works too.
- Card declined: it's charged in US dollars, so it's an international online payment. A lot of local-currency cards (Nigerian naira cards especially) block or cap international charges. Ask the bank to turn on international online payments, or pay with a dollar card (a virtual USD card works).
- Still stuck after trying that: handoff.
`;
