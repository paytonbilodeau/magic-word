// Real-time Inbox. Open Inbox tabs hold a WebSocket to one Durable Object, and the Worker pings it the moment something
// changes: a webhook landed (their message, our echo, a reaction), the AI started or stopped writing, a draft went out.
// The tab then pulls the fresh panes straight away. The 3s stamp poll in INBOX_JS (src/dashboard.ts) stays as the
// fallback. Hibernating sockets: the object sleeps between pings, and "ping"/"pong" keepalives never wake it.

interface HubState {
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void;
}

export class LiveHub {
  constructor(private state: HubState) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    const lead = await req.text();
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(lead);
      } catch {
        // a tab that just went away
      }
    }
    return new Response("ok");
  }

  webSocketMessage(): void {} // tabs only listen
  webSocketClose(ws: WebSocket, code: number): void {
    ws.close(code, "bye");
  }
}

// Tell open Inbox tabs that this lead's thread changed. Never throws, and does nothing without the binding (tests).
export async function ping(env: { LIVE?: DurableObjectNamespace }, lead: string): Promise<void> {
  if (!env.LIVE) return;
  await env.LIVE.get(env.LIVE.idFromName("inbox"))
    .fetch("https://live/ping", { method: "POST", body: lead })
    .catch(() => {});
}
