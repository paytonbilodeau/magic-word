// Home's charts, server-rendered. The line chart is an SVG that stretches to its panel (preserveAspectRatio none, with
// non-scaling strokes so lines stay 2px), with the axis labels as HTML around it so text never stretches. CHART_JS adds
// the hover / touch readout: a guide line and a tooltip with every series' value for that day. Styles: theme.ts.

import { esc } from "./admin";

export interface Series {
  name: string;
  color: string; // a CSS color or var(...)
  values: number[];
  fill?: boolean; // tint the area under the line
}

// The gap between gridlines for a chart whose biggest value is `max`, on `ticks` intervals: 1, 2, 5, 10, 20, 25, 50...
export function niceStep(max: number, ticks = 4): number {
  const raw = Math.max(1, max / ticks);
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = [1, 2, 2.5, 5, 10].find((x) => x * p >= raw && Number.isInteger(x * p)) ?? 10;
  return m * p;
}

const short = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
const r2 = (n: number) => Math.round(n * 100) / 100;

const VW = 1000; // SVG units; the plot stretches, so these are proportions
const VH = 100;
const TICKS = 4;

// `labels` = one per point (the tooltip's heading and the x axis). `empty` = what to say when every value is 0.
export function lineChart(series: Series[], labels: string[], opts: { label: string; empty: string }): string {
  const n = labels.length;
  const peak = Math.max(0, ...series.flatMap((s) => s.values));
  const step = niceStep(peak, TICKS);
  const top = step * TICKS;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * VW : VW / 2);
  const y = (v: number) => VH - (v / top) * VH;
  const grid = Array.from({ length: TICKS + 1 }, (_, i) => `<line class="gr" x1="0" x2="${VW}" y1="${r2((i / TICKS) * VH)}" y2="${r2((i / TICKS) * VH)}" vector-effect="non-scaling-stroke"/>`).join("");
  const paths = series
    .map((s) => {
      const pts = s.values.map((v, i) => `${r2(x(i))},${r2(y(v))}`);
      if (n === 1) pts.unshift(`0,${r2(y(s.values[0]))}`), pts.push(`${VW},${r2(y(s.values[0]))}`);
      const line = `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
      return s.fill ? `<polygon points="0,${VH} ${pts.join(" ")} ${VW},${VH}" fill="${s.color}" opacity=".1"/>${line}` : line;
    })
    .join("");
  const yAxis = Array.from({ length: TICKS + 1 }, (_, i) => `<span>${short(top - i * step)}</span>`).join("");
  // Up to 7 evenly spaced dates; flex space-between puts them under their points.
  const want = Math.min(n, 7);
  const xs = want > 1 ? Array.from({ length: want }, (_, k) => labels[Math.round((k * (n - 1)) / (want - 1))]) : labels;
  const data = { labels, series: series.map((s) => ({ name: s.name, color: s.color, values: s.values })) };
  return `<div class="lc" data-lc="${esc(JSON.stringify(data))}"><div class="lc-y" aria-hidden="true">${yAxis}</div>
<div class="lc-plot"><svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.label)}">${grid}${peak > 0 ? paths : ""}</svg>${
    peak > 0 ? "" : `<div class="lc-none">${opts.empty}</div>`
  }<div class="lc-guide" hidden></div><div class="lc-tip" hidden></div></div>
<div class="lc-x" aria-hidden="true">${xs.map((l) => `<span>${esc(l)}</span>`).join("")}</div></div>`;
}

// One row of a horizontal bar list: label, count, share, and the bar. `share` is 0-1.
export function barRow(label: string, count: number, share: number | null, note = "", secondary = false): string {
  const pct = share === null ? "" : `${share > 0 && share < 0.001 ? "<0.1" : Math.round(share * 1000) / 10}%`;
  return `<div class="fb${secondary ? " sec" : ""}"><div class="fb-l">${esc(label)}${note ? ` <span class="st">${esc(note)}</span>` : ""}</div><div class="fb-n"><b>${count.toLocaleString("en-US")}</b>${pct}</div>
<div class="fb-t"><i style="width:${share === null ? 0 : Math.max(count > 0 ? 1 : 0, Math.min(100, Math.round(share * 1000) / 10))}%"></i></div></div>`;
}

export const CHART_JS = `<script>document.querySelectorAll(".lc").forEach(function(c){var d=JSON.parse(c.dataset.lc),p=c.querySelector(".lc-plot"),g=c.querySelector(".lc-guide"),t=c.querySelector(".lc-tip"),n=d.labels.length;
if(!n||c.querySelector(".lc-none"))return;
function show(e){var r=p.getBoundingClientRect(),x=Math.min(Math.max(e.clientX-r.left,0),r.width),i=n>1?Math.round(x/r.width*(n-1)):0,px=n>1?i/(n-1)*r.width:r.width/2;
g.hidden=t.hidden=false;g.style.left=px+"px";t.textContent="";var h=document.createElement("b");h.textContent=d.labels[i];t.appendChild(h);
d.series.forEach(function(s){var row=document.createElement("span"),sw=document.createElement("i"),v=document.createElement("em");sw.style.background=s.color;v.textContent=s.values[i].toLocaleString();
row.appendChild(sw);row.appendChild(document.createTextNode(s.name));row.appendChild(v);t.appendChild(row)});
var half=t.offsetWidth/2;t.style.left=Math.min(Math.max(px,half),r.width-half)+"px"}
p.addEventListener("pointermove",show);p.addEventListener("pointerdown",show);p.addEventListener("pointerleave",function(){g.hidden=t.hidden=true})})</script>`;
