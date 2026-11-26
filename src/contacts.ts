// Contacts: everyone who has DMed or commented, newest activity first, with their tags.
// Tags (with counts) down the left as the filter, search and the list on the right. A row opens that
// person's thread in the Inbox. Group chats aren't contacts; the reviewer login sees test threads only.

import { esc, page, type Role } from "./admin";
import { avatar } from "./dashboard";
import type { Env } from "./setter";
import { icon } from "./theme";

const PAGE = 50;
const SCOPE = `(?1 = 'admin' OR l.test = 1) AND l.members IS NULL`;

interface Row {
  subscriber_id: string;
  username: string | null;
  first_name: string | null;
  profile_pic: string | null;
  created_at: number;
  last_at: number | null;
  tags: string | null;
}

export async function contactsPage(env: Env, who: Role, q: URLSearchParams): Promise<Response> {
  const search = (q.get("q") ?? "").trim().replace(/^@/, "").slice(0, 60);
  const tag = (q.get("tag") ?? "").trim().toLowerCase().slice(0, 40);
  const pageNo = Math.max(1, Math.floor(Number(q.get("page")) || 1));
  const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
  const where = `${SCOPE}${search ? ` AND (l.username LIKE ?2 ESCAPE '\\' OR l.first_name LIKE ?2 ESCAPE '\\')` : " AND ?2 = ?2"}${
    tag ? ` AND EXISTS (SELECT 1 FROM lead_tags t WHERE t.subscriber_id = l.subscriber_id AND t.tag = ?3)` : " AND ?3 = ?3"
  }`;
  const { results: rows } = await env.DB.prepare(
    `SELECT l.subscriber_id, l.username, l.first_name, l.profile_pic, l.created_at, l.last_at,
       (SELECT group_concat(t.tag, char(10)) FROM lead_tags t WHERE t.subscriber_id = l.subscriber_id) AS tags
     FROM leads l WHERE ${where} ORDER BY l.last_at DESC, l.subscriber_id LIMIT ${PAGE + 1} OFFSET ${(pageNo - 1) * PAGE}`,
  )
    .bind(who, like, tag)
    .all<Row>();
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${where}`).bind(who, like, tag).first<{ n: number }>())?.n ?? 0;
  const { results: tags } = await env.DB.prepare(
    `SELECT t.tag, COUNT(*) AS n FROM lead_tags t JOIN leads l ON l.subscriber_id = t.subscriber_id WHERE ${SCOPE} GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 30`,
  )
    .bind(who)
    .all<{ tag: string; n: number }>();

  const link = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const next = { q: search, tag, ...over };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return `/admin/contacts${s ? `?${s}` : ""}`;
  };
  const more = rows.length > PAGE;
  const list = rows
    .slice(0, PAGE)
    .map((r) => {
      const name = r.first_name || (r.username ? `@${r.username}` : r.subscriber_id);
      const chips = (r.tags ?? "").split("\n").filter(Boolean);
      return `<a class="ct-row" href="/admin/inbox/${esc(r.subscriber_id)}"><span class="nm">${avatar(r)}<div><b>${esc(name)}</b>${r.first_name && r.username ? `<small>@${esc(r.username)}</small>` : ""}</div></span>
<span class="chips">${chips.slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}${chips.length > 3 ? `<span class="chip">+${chips.length - 3}</span>` : ""}</span>
<span class="when">${r.last_at ? `<time data-t="${r.last_at}" data-day></time>` : "–"}</span><span class="when first"><time data-t="${r.created_at}" data-day></time></span></a>`;
    })
    .join("");
  const empty = search || tag ? `Nobody matches${search ? ` "${esc(search)}"` : ""}${tag ? ` with the tag ${esc(tag)}` : ""}. <a href="/admin/contacts">Show everyone</a>` : "No contacts yet. Anyone who DMs you or comments a keyword shows up here.";
  const side = `<aside class="ct-side"><h3>Tags</h3><a href="${link({ tag: null, page: null })}"${tag ? "" : ' class="on"'}><span>Everyone</span><span></span></a>${
    tags.map((t) => `<a href="${link({ tag: t.tag, page: null })}"${t.tag === tag ? ' class="on"' : ""}><span>${esc(t.tag)}</span><span>${t.n.toLocaleString("en-US")}</span></a>`).join("") ||
    `<p class="none">No tags yet. Automations and the Inbox can tag people.</p>`
  }</aside>`;
  const pager =
    pageNo > 1 || more
      ? `<div class="pager">${pageNo > 1 ? `<a href="${link({ page: pageNo > 2 ? String(pageNo - 1) : null })}">Newer</a>` : "<span></span>"}${more ? `<a href="${link({ page: String(pageNo + 1) })}">Older</a>` : ""}</div>`
      : "";

  return page(
    "Contacts",
    `<div class="ct">${side}<div><div class="ct-bar"><form method="get" action="/admin/contacts" role="search">${tag ? `<input type="hidden" name="tag" value="${esc(tag)}">` : ""}
<div class="srch">${icon("search", 16)}<input type="search" name="q" value="${esc(search)}" placeholder="Search by name or @username" aria-label="Search contacts"></div></form>
<span>${total.toLocaleString("en-US")} ${total === 1 ? "contact" : "contacts"}${tag ? ` tagged ${esc(tag)}` : ""}</span></div>
<div class="ct-tbl"><div class="ct-h"><span>Name</span><span>Tags</span><span>Last message</span><span>First seen</span></div>${list || `<p class="none">${empty}</p>`}</div>${pager}</div></div>`,
    who,
    env,
  );
}
