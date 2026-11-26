// Automations as a node graph: a When... node (the trigger), Send Message, Smart Delay,
// Condition, Actions and Randomizer nodes, joined by edges from output ports. A Send Message node's ports are its
// Next Step plus one per next-step button and quick reply, so taps branch; Condition has yes/no, Randomizer one per
// variant. The published graph lives in flow_nodes / flow_edges; the editor autosaves a draft as JSON on the
// triggers row and Publish copies it over. Automations from the old linear builder are converted the first time
// they're loaded (ensureGraph), with ids the migration SQL also uses: m0 = first message, s<step id> = each step.

import type { Trigger } from "./comments";

export type Source = Trigger["source"];
export type Kind = "trigger" | "message" | "delay" | "condition" | "action" | "randomizer";

export interface Button {
  id: string;
  title: string;
  url?: string; // a link button; without one it's a next-step button with its own port
}
export interface Bubble {
  text: string;
  buttons: Button[];
}
export interface QuickReply {
  id: string;
  title: string;
}
export interface MessageData {
  bubbles: Bubble[];
  quick_replies: QuickReply[]; // under the last bubble
}
export interface Rule {
  field: "tag" | "stage" | "keyword" | "follows" | "paused";
  op: "is" | "not";
  value: string;
}
export interface ActionItem {
  type: "add_tag" | "remove_tag" | "set_stage" | "pause_ai" | "resume_ai" | "handoff" | "start_automation";
  value: string;
}
export interface Variant {
  id: string;
  label: string;
  weight: number;
}

export interface Node {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  // message: MessageData; delay: {seconds}; condition: {match, rules}; action: {actions}; randomizer: {variants}
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
export interface Edge {
  from: string;
  port: string;
  to: string;
}
export interface TriggerCfg {
  source: Source;
  keyword: string;
  media_id: string | null;
  public_reply: string | null;
}
export interface Graph {
  trigger: TriggerCfg;
  nodes: Node[];
  edges: Edge[];
}

export const SOURCES: Source[] = ["comment", "dm", "story", "mention", "welcome", "none"];
export const KEYWORDLESS = new Set<Source>(["mention", "welcome", "none"]);
export const STAGES = ["opener", "lead", "qualify", "pitch", "link_sent", "joined", "closed"];
const ACTIONS: ActionItem["type"][] = ["add_tag", "remove_tag", "set_stage", "pause_ai", "resume_ai", "handoff", "start_automation"];
const FIELDS: Rule["field"][] = ["tag", "stage", "keyword", "follows", "paused"];

const str = (v: unknown, max: number) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ID = /^[A-Za-z0-9_-]{1,24}$/;
const pid = (v: unknown, fallback: string) => (typeof v === "string" && ID.test(v) ? v : fallback);

// Instagram's limits: 640 characters with buttons (1000 without), 3 buttons and 20-character titles, 13 quick replies.
function cleanData(kind: Kind, d: any): any {
  d = d && typeof d === "object" ? d : {};
  switch (kind) {
    case "message":
      return {
        bubbles: arr(d.bubbles)
          .slice(0, 10)
          .map((b: any, i) => ({
            text: str(b?.text, 1000),
            buttons: arr(b?.buttons)
              .slice(0, 3)
              .map((x: any, j) => {
                const btn: Button = { id: pid(x?.id, `b${i}${j}`), title: str(x?.title, 20) };
                if (typeof x?.url === "string") btn.url = str(x.url, 2000).trim();
                return btn;
              }),
          })),
        quick_replies: arr(d.quick_replies)
          .slice(0, 13)
          .map((q: any, i) => ({ id: pid(q?.id, `q${i}`), title: str(q?.title, 20) })),
      } satisfies MessageData;
    case "delay":
      return { seconds: Math.min(30 * 86400, Math.max(1, Math.round(num(d.seconds, 3600)))) };
    case "condition":
      return {
        match: d.match === "any" ? "any" : "all",
        rules: arr(d.rules)
          .slice(0, 10)
          .map((r: any) => ({ field: FIELDS.includes(r?.field) ? r.field : "tag", op: r?.op === "not" ? "not" : "is", value: str(r?.value, 200) })),
      };
    case "action":
      return {
        actions: arr(d.actions)
          .slice(0, 10)
          .map((a: any) => ({ type: ACTIONS.includes(a?.type) ? a.type : "add_tag", value: str(a?.value, 200) })),
      };
    case "randomizer":
      return {
        variants: arr(d.variants)
          .slice(0, 6)
          .map((v: any, i) => ({ id: pid(v?.id, `v${i}`), label: str(v?.label, 30) || String.fromCharCode(65 + i), weight: Math.max(0, Math.min(100, Math.round(num(v?.weight, 50)))) })),
      };
    default:
      return {};
  }
}

// The ports a node offers; edges from anything else are dropped.
export function ports(n: Node): string[] {
  switch (n.kind) {
    case "trigger":
    case "delay":
    case "action":
      return ["next"];
    case "message": {
      const d = n.data as MessageData;
      return ["next", ...d.bubbles.flatMap((b) => b.buttons.filter((x) => x.url === undefined).map((x) => x.id)), ...d.quick_replies.map((q) => q.id)];
    }
    case "condition":
      return ["yes", "no"];
    case "randomizer":
      return (n.data.variants as Variant[]).map((v) => v.id);
  }
}

// Whatever the editor (or a stored draft) sends, made safe: known kinds, clamped fields, one trigger node, edges
// only between existing nodes from real ports, one edge per port.
export function sanitize(input: unknown, fallback: TriggerCfg): Graph {
  const g = (input && typeof input === "object" ? input : {}) as any;
  const t = g.trigger ?? {};
  const source: Source = SOURCES.includes(t.source) ? t.source : fallback.source;
  const media = str(t.media_id, 64).trim() || null;
  const trigger: TriggerCfg = {
    source,
    keyword: KEYWORDLESS.has(source) ? "*" : str(t.keyword ?? fallback.keyword, 500).trim(),
    // comment: the post (or "next"); story: one story, so only replies to that story run it ("next" is posts only)
    media_id: source === "comment" || (source === "story" && media !== "next") ? media : null,
    public_reply: source === "comment" ? str(t.public_reply, 2000).trim() || null : null,
  };
  const kinds: Kind[] = ["trigger", "message", "delay", "condition", "action", "randomizer"];
  const seen = new Set<string>();
  const nodes: Node[] = [];
  for (const raw of arr(g.nodes).slice(0, 200) as any[]) {
    if (!kinds.includes(raw?.kind) || typeof raw?.id !== "string" || !ID.test(raw.id) || seen.has(raw.id)) continue;
    if ((raw.kind === "trigger") !== (raw.id === "trigger")) continue;
    seen.add(raw.id);
    nodes.push({ id: raw.id, kind: raw.kind, x: Math.round(num(raw.x)), y: Math.round(num(raw.y)), data: cleanData(raw.kind, raw.data) });
  }
  if (!seen.has("trigger")) nodes.unshift({ id: "trigger", kind: "trigger", x: 0, y: 0, data: {} });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: Edge[] = [];
  const used = new Set<string>();
  for (const e of arr(g.edges) as any[]) {
    const from = byId.get(e?.from);
    if (!from || !byId.has(e?.to) || e.to === "trigger" || e.to === e.from || !ports(from).includes(e?.port)) continue;
    const key = `${e.from}\u0000${e.port}`;
    if (used.has(key)) continue;
    used.add(key);
    edges.push({ from: e.from, port: e.port, to: e.to });
  }
  return { trigger, nodes, edges };
}

// Problems that block Publish (the draft still saves).
export function validate(g: Graph): string[] {
  const out: string[] = [];
  if (!KEYWORDLESS.has(g.trigger.source) && !g.trigger.keyword) out.push("When...: add at least one keyword (or * for anything).");
  if (!g.edges.some((e) => e.from === "trigger")) out.push("When...: connect it to the first step.");
  let n = 0;
  for (const node of g.nodes) {
    if (node.kind !== "message") continue;
    n++;
    const d = node.data as MessageData;
    const name = `Send Message #${n}`;
    if (!d.bubbles.length || d.bubbles.every((b) => !b.text.trim())) out.push(`${name}: add some text.`);
    d.bubbles.forEach((b, i) => {
      if (b.buttons.length && b.text.length > 640) out.push(`${name}: text ${i + 1} is over 640 characters (Instagram's limit with buttons).`);
      for (const x of b.buttons) {
        if (!x.title.trim()) out.push(`${name}: every button needs a title.`);
        if (x.url !== undefined && !x.url) out.push(`${name}: the link button "${x.title}" needs a URL.`);
      }
    });
    if (d.quick_replies.some((q) => !q.title.trim())) out.push(`${name}: every quick reply needs a title.`);
  }
  for (const node of g.nodes) {
    if (node.kind === "randomizer" && (node.data.variants as Variant[]).reduce((s, v) => s + v.weight, 0) <= 0) out.push("Randomizer: the split needs a weight above 0.");
    if (node.kind === "action" && (node.data.actions as ActionItem[]).some((a) => a.type === "start_automation" && !Number(a.value)))
      out.push("Actions: pick the automation to start.");
  }
  return [...new Set(out)];
}

// ---------- legacy: the linear builder's trigger columns + flow_steps ----------

interface LegacyMsg {
  text: string | null;
  button_title: string | null;
  button_url: string | null;
  next_title: string | null;
  quick_replies: string | null;
}
interface LegacyStep extends LegacyMsg {
  id: number;
  position: number;
  kind: "message" | "delay";
  delay_s: number | null;
}

const X = 380;

// "Title" or "Title > automation name" per line, 13 max, titles cut at 20 like Instagram does.
export function legacyQuickReplies(lines: string | null): { title: string; target: string | null }[] {
  return (lines ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 13)
    .map((l) => {
      const [title, target] = l.split(/\s*>\s*/, 2);
      return { title: title.slice(0, 20), target: target?.trim() || null };
    });
}

// The same automation as a graph. `resolve` turns a quick reply's "> automation name" into its id (0 = none, the
// AI answers that tap, as before). Empty steps were skipped by the old runtime; here they pass straight through.
export async function legacyGraph(t: Trigger, steps: LegacyStep[], resolve: (name: string) => Promise<number>): Promise<Graph> {
  const nodes: Node[] = [{ id: "trigger", kind: "trigger", x: 0, y: 0, data: {} }];
  const edges: Edge[] = [];
  let prev = { id: "trigger", port: "next" };
  const all: { id: string; m: LegacyMsg; kind: "message" | "delay"; delay_s: number | null }[] = [
    { id: "m0", m: { text: t.dm, button_title: t.button_title, button_url: t.button_url, next_title: t.next_title, quick_replies: t.quick_replies }, kind: "message", delay_s: null },
    ...steps.map((s) => ({ id: `s${s.id}`, m: s, kind: s.kind, delay_s: s.delay_s })),
  ];
  for (const [i, s] of all.entries()) {
    const x = X * (i + 1);
    edges.push({ from: prev.id, port: prev.port, to: s.id });
    if (s.kind === "delay") {
      nodes.push({ id: s.id, kind: "delay", x, y: 0, data: { seconds: Math.max(1, s.delay_s ?? 1) } });
      prev = { id: s.id, port: "next" };
      continue;
    }
    const text = s.m.text ?? "";
    const has = Boolean(text.trim());
    const buttons: Button[] = [];
    if (has && s.m.button_title && s.m.button_url) buttons.push({ id: "url", title: s.m.button_title.slice(0, 20), url: s.m.button_url });
    if (has && s.m.next_title) buttons.push({ id: "nx", title: s.m.next_title.slice(0, 20) });
    const qrs = has ? legacyQuickReplies(s.m.quick_replies) : [];
    const data: MessageData = { bubbles: [{ text, buttons }], quick_replies: qrs.map((q, j) => ({ id: `q${j}`, title: q.title })) };
    nodes.push({ id: s.id, kind: "message", x, y: 0, data });
    for (const [j, q] of qrs.entries()) {
      const target = q.target ? await resolve(q.target) : 0;
      if (!target) continue;
      const a = `${s.id}q${j}`;
      nodes.push({ id: a, kind: "action", x: x + X / 2, y: 320 + 170 * j, data: { actions: [{ type: "start_automation", value: String(target) }] } });
      edges.push({ from: s.id, port: `q${j}`, to: a });
    }
    // The old runtime stopped after a message with a next-step button and went on when it was tapped.
    prev = { id: s.id, port: has && s.m.next_title ? "nx" : "next" };
  }
  return { trigger: { source: t.source, keyword: t.keyword, media_id: t.media_id, public_reply: t.public_reply }, nodes, edges };
}

// ---------- storage ----------

export const triggerCfg = (t: Trigger): TriggerCfg => ({ source: t.source, keyword: t.keyword, media_id: t.media_id, public_reply: t.public_reply });

export async function findByName(d: D1Database, name: string): Promise<number> {
  const row = await d
    .prepare(`SELECT id FROM triggers WHERE deleted_at IS NULL AND (lower(COALESCE(name, keyword)) = lower(?1) OR lower(keyword) = lower(?1)) ORDER BY enabled DESC, id LIMIT 1`)
    .bind(name.trim())
    .first<{ id: number }>();
  return row?.id ?? 0;
}

const insertStmts = (d: D1Database, id: number, g: Graph, orIgnore = false) => [
  ...g.nodes.map((n) =>
    d
      .prepare(`INSERT ${orIgnore ? "OR IGNORE " : ""}INTO flow_nodes (trigger_id, id, kind, data, x, y) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(id, n.id, n.kind, JSON.stringify(n.data), n.x, n.y),
  ),
  ...g.edges.map((e) => d.prepare(`INSERT ${orIgnore ? "OR IGNORE " : ""}INTO flow_edges (trigger_id, from_id, port, to_id) VALUES (?1, ?2, ?3, ?4)`).bind(id, e.from, e.port, e.to)),
];

// Builds the graph of an automation that doesn't have one yet (made by the old builder or the old /admin/triggers
// form). Deterministic ids + INSERT OR IGNORE, so two webhooks racing on the same automation end up with one graph.
export async function ensureGraph(d: D1Database, t: Trigger): Promise<void> {
  const has = await d.prepare(`SELECT 1 FROM flow_nodes WHERE trigger_id = ?1 LIMIT 1`).bind(t.id).first();
  if (has) return;
  const { results: steps } = await d.prepare(`SELECT * FROM flow_steps WHERE trigger_id = ?1 ORDER BY position`).bind(t.id).all<LegacyStep>();
  const g = await legacyGraph(t, steps, (name) => findByName(d, name));
  await d.batch(insertStmts(d, t.id, g, true));
}

export async function loadGraph(d: D1Database, t: Trigger): Promise<Graph> {
  await ensureGraph(d, t);
  const { results: nodes } = await d
    .prepare(`SELECT id, kind, data, x, y FROM flow_nodes WHERE trigger_id = ?1 ORDER BY rowid`)
    .bind(t.id)
    .all<{ id: string; kind: Kind; data: string; x: number; y: number }>();
  const { results: edges } = await d.prepare(`SELECT from_id, port, to_id FROM flow_edges WHERE trigger_id = ?1`).bind(t.id).all<{ from_id: string; port: string; to_id: string }>();
  return {
    trigger: triggerCfg(t),
    nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, x: n.x, y: n.y, data: JSON.parse(n.data) })),
    edges: edges.map((e) => ({ from: e.from_id, port: e.port, to: e.to_id })),
  };
}

// What the editor opens: the autosaved draft if there is one, else the live graph.
export async function editorGraph(d: D1Database, t: Trigger & { draft?: string | null }): Promise<Graph> {
  if (t.draft) {
    try {
      return sanitize(JSON.parse(t.draft), triggerCfg(t));
    } catch {
      /* a broken draft falls back to what's live */
    }
  }
  return loadGraph(d, t);
}

// The first message's text, kept in triggers.dm for anything still reading the old column.
export function firstText(g: Graph): string {
  const first = g.edges.find((e) => e.from === "trigger");
  const seen = new Set<string>();
  let id = first?.to;
  while (id && !seen.has(id)) {
    seen.add(id);
    const n = g.nodes.find((x) => x.id === id);
    if (n?.kind === "message") return (n.data as MessageData).bubbles.map((b) => b.text).find((x) => x.trim()) ?? "";
    id = g.edges.find((e) => e.from === id && (e.port === "next" || e.port === "yes" || n?.kind === "randomizer"))?.to;
  }
  return "";
}

// Publish: the graph becomes what runs. Smart delays waiting on a node that's gone are cancelled.
export async function publish(d: D1Database, id: number, g: Graph, now: number): Promise<void> {
  const t = g.trigger;
  await d.batch([
    d.prepare(`DELETE FROM flow_nodes WHERE trigger_id = ?1`).bind(id),
    d.prepare(`DELETE FROM flow_edges WHERE trigger_id = ?1`).bind(id),
    ...insertStmts(d, id, g),
    d
      .prepare(
        `UPDATE triggers SET source = ?2, keyword = ?3, media_id = ?4, public_reply = ?5, dm = ?6, draft = NULL, enabled = 1, published_at = ?7, updated_at = ?7 WHERE id = ?1`,
      )
      .bind(id, t.source, t.keyword, t.media_id, t.public_reply, firstText(g), now),
    d
      .prepare(`UPDATE flow_runs SET status = 'cancelled' WHERE trigger_id = ?1 AND status = 'scheduled' AND COALESCE(node_id, '') NOT IN (SELECT value FROM json_each(?2))`)
      .bind(id, JSON.stringify(g.nodes.map((n) => n.id))),
  ]);
}

// Copies an automation's live graph and draft under another automation (Duplicate).
export async function copyGraph(d: D1Database, from: Trigger, to: number): Promise<void> {
  await d.batch(insertStmts(d, to, await loadGraph(d, from)));
}

// ---------- stats on the canvas ----------

export interface NodeStats {
  sent?: number; // messages: people who got it; trigger: runs
  opened?: number; // messages: people whose read receipt covered it
  clicked?: number; // messages: people who tapped or clicked anything in it
  ports?: Record<string, number>; // per button / quick reply / branch
  waiting?: number; // smart delays
  passed?: number;
}

export async function graphStats(d: D1Database, id: number): Promise<Record<string, NodeStats>> {
  const out: Record<string, NodeStats> = {};
  const at = (n: string) => (out[n] ??= {});
  const runs = await d.prepare(`SELECT COUNT(*) AS n FROM flow_starts WHERE trigger_id = ?1 AND status = 'sent'`).bind(id).first<{ n: number }>();
  at("trigger").sent = runs?.n ?? 0;
  const { results: sends } = await d
    .prepare(
      `SELECT s.node_id, COUNT(DISTINCT CASE WHEN s.part = 0 THEN s.subscriber_id END) AS sent,
         COUNT(DISTINCT CASE WHEN s.seen_at IS NOT NULL THEN s.subscriber_id END) AS opened,
         COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM flow_taps t WHERE t.send_id = s.id) THEN s.subscriber_id END) AS clicked
       FROM flow_sends s WHERE s.trigger_id = ?1 AND s.status = 'sent' AND s.node_id IS NOT NULL GROUP BY s.node_id`,
    )
    .bind(id)
    .all<{ node_id: string; sent: number; opened: number; clicked: number }>();
  for (const s of sends) Object.assign(at(s.node_id), { sent: s.sent, opened: s.opened, clicked: s.clicked });
  const { results: taps } = await d
    .prepare(
      `SELECT s.node_id, t.port, COUNT(DISTINCT s.subscriber_id) AS n FROM flow_taps t JOIN flow_sends s ON s.id = t.send_id
       WHERE s.trigger_id = ?1 AND s.node_id IS NOT NULL GROUP BY s.node_id, t.port`,
    )
    .bind(id)
    .all<{ node_id: string; port: string; n: number }>();
  const { results: hits } = await d
    .prepare(`SELECT node_id, port, COUNT(DISTINCT subscriber_id) AS n FROM flow_hits WHERE trigger_id = ?1 GROUP BY node_id, port`)
    .bind(id)
    .all<{ node_id: string; port: string; n: number }>();
  for (const r of [...taps, ...hits]) (at(r.node_id).ports ??= {})[r.port] = r.n;
  const { results: delays } = await d
    .prepare(`SELECT node_id, SUM(status = 'scheduled') AS waiting, SUM(status = 'done') AS passed FROM flow_runs WHERE trigger_id = ?1 AND node_id IS NOT NULL GROUP BY node_id`)
    .bind(id)
    .all<{ node_id: string; waiting: number; passed: number }>();
  for (const r of delays) Object.assign(at(r.node_id), { waiting: r.waiting, passed: r.passed });
  return out;
}
