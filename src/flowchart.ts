// The Dashboard's stage funnel: a solid bar per stage in its pipeline color, joined by tinted ribbons that taper from
// each stage's bar into the next one. The openers are the lead-in: everyone who DMed, drawn as a wide gray mouth that
// narrows into the first conversation stage (not to scale, 5,000 would flatten the rest). From "Get to know them" on,
// bar heights are true proportions, with a small floor so a handful of joins stays visible. Server-rendered inline SVG,
// no JS: labels sit over the chart at each bar, each column focusable so a tap shows its numbers.

export type Step = { stage: string; reached: number; through: number };

// Chart geometry in SVG units. The SVG stretches to the card width (preserveAspectRatio none), so only heights are pixels.
export const W = 1200;
export const H = 210;
export const MAX = 190; // bar height of the first conversation stage
export const FLOOR = 8; // shortest a non-empty stage gets
const NW = 10; // bar width

// Bar heights. [0] is the openers' mouth (the full band, not to scale); from [1] on, proportional to stage 1, floored
// at FLOOR, 0 when nobody got there.
export function thickness(steps: Step[]): number[] {
  const top = steps[1]?.reached ?? 0;
  return steps.map((s, i) => (i === 0 ? (s.reached > 0 ? H : 0) : s.reached > 0 && top > 0 ? Math.max(FLOOR, (MAX * s.reached) / top) : 0));
}

// 45.6, 7.4, 100, 50: one decimal, none when it's whole, <0.1 rather than a false 0. null when there's nothing to divide by.
export function pct(part: number, whole: number): string | null {
  if (!whole) return null;
  const v = Math.round((1000 * part) / whole) / 10;
  return part > 0 && v === 0 ? "<0.1%" : `${v}%`;
}

const r = (n: number) => Math.round(n * 100) / 100;

// A ribbon from one vertical span to another with S-curved edges: [x0, top0, bottom0] → [x1, top1, bottom1].
export function ribbon(x0: number, a0: number, b0: number, x1: number, a1: number, b1: number): string {
  const m = r((x0 + x1) / 2);
  return `M${r(x0)} ${r(a0)} C${m} ${r(a0)} ${m} ${r(a1)} ${r(x1)} ${r(a1)} L${r(x1)} ${r(b1)} C${m} ${r(b1)} ${m} ${r(b0)} ${r(x0)} ${r(b0)} Z`;
}

export interface Layout {
  bars: { x: number; y: number; h: number }[]; // h 0 = nobody reached it
  flows: { from: number; d: string }[]; // stage i's bar tapering into stage i+1's
}

// The mouth sits at the left edge; the stage bars spread from one column in to the right edge, centered on the band.
// Each ribbon runs from one bar's full height to the next bar's.
export function layout(t: number[]): Layout {
  const n = t.length;
  const lead = n > 2 ? W / n : 0; // the openers' column
  const cw = n > 2 ? (W - NW - lead) / (n - 2) : W;
  const bars = t.map((h, i) => ({ x: r(i === 0 ? 0 : lead + (i - 1) * cw), y: r((H - h) / 2), h: r(h) }));
  const flows: Layout["flows"] = [];
  for (let i = 0; i + 1 < n; i++) {
    const [b, next] = [bars[i], bars[i + 1]];
    if (b.h && next.h) flows.push({ from: i, d: ribbon(b.x + NW, b.y, b.y + b.h, next.x, next.y, next.y + next.h) });
  }
  return { bars, flows };
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function flowChart(steps: Step[], names: Record<string, string>, colors: Record<string, string> = {}): string {
  const t = thickness(steps);
  const n = steps.length;
  const start = steps[0]?.reached ?? 0;
  const color = (i: number) => colors[steps[i]?.stage] ?? "#3797f0";
  const { bars, flows } = layout(t);
  const label = `Funnel: ${steps.map((s) => `${names[s.stage]} ${s.reached}`).join(", ")}`;

  // One horizontal gradient per hand-off: this stage's color into the next.
  // The mouth fades in from nothing, so it reads as "everyone who came in", not as a bar to measure.
  const defs = flows
    .map((f) =>
      f.from === 0
        ? `<linearGradient id="fc-f0" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${color(0)}" stop-opacity=".05"/><stop offset="1" stop-color="${color(1)}" stop-opacity=".42"/></linearGradient>`
        : `<linearGradient id="fc-f${f.from}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${color(f.from)}" stop-opacity=".5"/><stop offset="1" stop-color="${color(f.from + 1)}" stop-opacity=".42"/></linearGradient>`,
    )
    .join("");
  const svgBars = bars
    .map((b, i) =>
      i === 0
        ? ""
        : b.h
          ? `<rect class="fc-bar" x="${b.x}" y="${b.y}" width="${NW}" height="${b.h}" rx="2" fill="${color(i)}"/>`
          : `<rect class="fc-empty-bar" x="${b.x}" y="${r((H - 24) / 2)}" width="${NW}" height="24" rx="2"/>`,
    )
    .join("");

  const cols = steps
    .map((s, i) => {
      const prev = i ? pct(s.reached, steps[i - 1].reached) : null;
      const all = i > 1 ? pct(s.reached, start) : null;
      const sub = i === 0 ? (start ? "everyone who DMed" : "") : prev ? `${prev}${all ? `<span>${all} of all</span>` : ""}` : "";
      const lost = s.reached - s.through;
      const out =
        i + 1 < n ? `${fmt(s.through)} moved on${s.reached ? ` (${pct(s.through, s.reached)})` : ""}${lost > 0 ? `, ${fmt(lost)} stopped here` : ""}` : "the finish line";
      const at = i + 1 === n && n > 2 ? "right:0;text-align:right" : `left:${r((100 * bars[i].x) / W)}%`;
      return `<div class="fc-col" tabindex="0" style="--c:${color(i)};${at};width:${r(100 / n)}%"><div class="fc-n">${fmt(s.reached)}</div><div class="fc-name">${names[s.stage]}</div>
<div class="fc-pct">${sub || "&nbsp;"}</div><div class="fc-tip">${fmt(s.reached)} reached${all ? `<i>, ${all} of all</i>` : ""}<br>${out}</div></div>`;
    })
    .join("");
  const rows = steps
    .map(
      (s, i) =>
        `<tr><th scope="row">${names[s.stage]}</th><td>${s.reached}</td><td>${s.through}</td><td>${(i ? pct(s.reached, steps[i - 1].reached) : null) ?? ""}</td><td>${pct(s.reached, start) ?? ""}</td></tr>`,
    )
    .join("");
  return `${FLOW_CSS}<div class="fc" role="img" aria-label="${label}">
<svg class="fc-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><defs>${defs}</defs>
${flows.map((f) => `<path class="fc-flow" d="${f.d}" fill="url(#fc-f${f.from})"/>`).join("")}
${svgBars}</svg>
<div class="fc-cols">${cols}</div>${start ? "" : '<div class="fc-empty">No leads in this range yet.</div>'}</div>
<table class="sr"><caption>Leads by stage</caption><thead><tr><th scope="col">Stage</th><th scope="col">Reached</th><th scope="col">Made it through</th><th scope="col">% of previous</th><th scope="col">% of all</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// Flow chart styles, kept here so theme.ts stays untouched. Columns sit over the SVG; the bars live under the labels.
const FLOW_CSS = `<style>
.fc{position:relative;margin-top:20px;padding:96px 0 8px}
.fc-svg{display:block;width:100%;height:${H}px;overflow:visible}
.fc-flow{transition:opacity .15s}
.fc-empty-bar{fill:none;stroke:var(--line);stroke-width:1;stroke-dasharray:3 4;vector-effect:non-scaling-stroke}
.fc-cols{position:absolute;inset:0}
.fc-col{position:absolute;top:0;bottom:0;padding:0 10px 0 2px;outline:none;cursor:default;border-radius:8px;min-width:0}
.fc-col:hover,.fc-col:focus{background:color-mix(in srgb,var(--c) 7%,transparent)}
.fc-col:focus-visible{box-shadow:inset 0 0 0 2px var(--c)}
.fc-n{font-size:24px;line-height:30px;font-weight:600;font-variant-numeric:tabular-nums}
.fc-name{color:var(--ink);font-size:13px;line-height:16px;font-weight:600;opacity:.8}
.fc-pct{color:var(--c);font-size:13px;line-height:18px;font-weight:600;margin-top:2px}
.fc-pct span{display:block;color:var(--mut);font-weight:400}
.fc-tip{position:absolute;left:2px;right:10px;bottom:6px;text-align:inherit;font-size:12px;line-height:16px;color:var(--mut);opacity:0;transition:opacity .15s}
.fc-col:hover .fc-tip,.fc-col:focus .fc-tip{opacity:1}
.fc-tip i{font-style:normal;display:none}
.fc-empty{position:absolute;left:0;right:0;bottom:${Math.round(H / 2)}px;text-align:center;color:var(--mut);font-size:13px}
@media (max-width:767px){
  .fc{padding:104px 0 0}
  .fc-svg{height:${Math.round(H * 0.7)}px}
  .fc-col{padding:0 4px 0 1px}
  .fc-n{font-size:17px;line-height:22px}
  .fc-name{font-size:11px;line-height:13px}
  .fc-pct{font-size:11px;line-height:14px}
  .fc-pct span{display:none}
  .fc-tip i{display:inline}
  .fc-tip{left:1px;right:4px;font-size:10px;line-height:13px}
  .fc-empty{bottom:${Math.round(H * 0.35)}px}
}
</style>`;
