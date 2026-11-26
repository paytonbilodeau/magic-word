import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveHub, ping } from "../src/live";

afterEach(() => vi.unstubAllGlobals());

describe("real-time Inbox hub", () => {
  it("passes each ping to every open tab and keeps going past a dead one", async () => {
    vi.stubGlobal("WebSocketRequestResponsePair", class {});
    const got: string[] = [];
    const tab = (name: string) => ({
      send: (m: string) => {
        if (name === "dead") throw new Error("gone");
        got.push(`${name}:${m}`);
      },
    });
    const hub = new LiveHub({ acceptWebSocket: () => {}, getWebSockets: () => [tab("a"), tab("dead"), tab("b")] as unknown as WebSocket[], setWebSocketAutoResponse: () => {} });
    const res = await hub.fetch(new Request("https://live/ping", { method: "POST", body: "9300000000000001" }));
    expect(res.status).toBe(200);
    expect(got).toEqual(["a:9300000000000001", "b:9300000000000001"]);
  });

  it("ping is a no-op without the binding and never throws", async () => {
    await expect(ping({}, "1")).resolves.toBeUndefined();
    const broken = { idFromName: () => "x", get: () => ({ fetch: () => Promise.reject(new Error("down")) }) } as unknown as DurableObjectNamespace;
    await expect(ping({ LIVE: broken }, "1")).resolves.toBeUndefined();
  });
});
