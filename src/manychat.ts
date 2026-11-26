// Manychat pipe, the fallback while App Review is pending: Standard access only delivers DMs from accounts with a
// role on the app, so Manychat's Default Reply flow POSTs every other inbound DM here via an External Request, and
// replies to those leads go back out through Manychat's sendContent API.

export interface Inbound {
  subscriber_id: string;
  username: string | null;
  first_name: string | null;
  text: string;
}

// External Request body: {"subscriber_id":"{{user_id}}","username":"{{instagram_username}}",
// "first_name":"{{first_name}}","text":"{{last_input_text}}"}. Unfilled Manychat vars arrive as "" or the raw {{tag}}.
export function parseInbound(body: unknown): Inbound | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const clean = (v: unknown) => {
    const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
    return s && !/^\{\{.*\}\}$/.test(s) ? s : null;
  };
  const subscriber_id = clean(b.subscriber_id);
  const text = clean(b.text);
  if (!subscriber_id || !/^\d+$/.test(subscriber_id) || !text) return null;
  return { subscriber_id, username: clean(b.username), first_name: clean(b.first_name), text };
}

export interface Subscriber {
  ig_id: string | null; // the lead's Instagram-scoped id: the same id Meta's webhooks use
  ig_username: string | null;
  name: string | null;
}

export async function getSubscriber(apiKey: string, subscriberId: string): Promise<Subscriber> {
  const res = await fetch(`https://api.manychat.com/fb/subscriber/getInfo?subscriber_id=${subscriberId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const raw = await res.text();
  const body = JSON.parse(raw) as { status?: string; data?: { ig_username?: string | null; name?: string | null } };
  if (!res.ok || body.status !== "success" || !body.data) throw new Error(`manychat getInfo ${res.status}`);
  // ig_id is a JSON number past 2^53, so JSON.parse rounds it; read the digits from the raw text.
  const ig_id = raw.match(/"ig_id"\s*:\s*"?(\d+)/)?.[1] ?? null;
  return { ig_id, ig_username: body.data.ig_username || null, name: body.data.name || null };
}

// Manychat's ig_id is the same Instagram-scoped id our webhooks carry, so a lead Manychat knows can be found by name
// and confirmed by id. Returns the Manychat subscriber id, or null when no subscriber with that name has that id.
export async function findByIgId(apiKey: string, igId: string, name: string | null): Promise<string | null> {
  if (!name) return null;
  const res = await fetch(`https://api.manychat.com/fb/subscriber/findByName?${new URLSearchParams({ name })}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  // ig_id is a JSON number past 2^53: quote it before parsing so the digits survive.
  const raw = (await res.text()).replace(/"ig_id"\s*:\s*(\d+)/g, '"ig_id":"$1"');
  const body = JSON.parse(raw) as { status?: string; data?: { id: string | number; ig_id?: string | null }[] };
  if (!res.ok || body.status !== "success") throw new Error(`manychat findByName ${res.status}`);
  const hit = body.data?.find((s) => String(s.ig_id) === igId);
  return hit ? String(hit.id) : null;
}

export function fillLink(bubbles: string[], link: string): string[] {
  return bubbles.map((b) => b.replaceAll("{{SKOOL_LINK}}", link));
}

export async function sendBubbles(apiKey: string, subscriberId: string, bubbles: string[]): Promise<void> {
  const res = await fetch("https://api.manychat.com/fb/sending/sendContent", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      subscriber_id: Number(subscriberId),
      data: {
        version: "v2",
        content: { type: "instagram", messages: bubbles.map((text) => ({ type: "text", text })) },
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string; code?: number };
  if (!res.ok || body.status !== "success") {
    throw new Error(`manychat ${res.status}${body.code ? ` code ${body.code}` : ""}: ${body.message ?? "send failed"}`);
  }
}
