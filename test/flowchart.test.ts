import { describe, expect, it } from "vitest";
import { flowChart, FLOOR, H, layout, MAX, pct, thickness, W, type Step } from "../src/flowchart";

const STAGES = ["opener", "lead", "qualify", "pitch", "link_sent", "joined"];
const NAMES = Object.fromEntries(STAGES.map((s) => [s, s.toUpperCase()]));
const steps = (reached: number[]): Step[] => reached.map((n, i) => ({ stage: STAGES[i], reached: n, through: reached[i + 1] ?? 0 }));

describe("flow chart", () => {
  it("from the first conversation stage on, bars are proportional; the openers are the full-height mouth", () => {
    const t = thickness(steps([5434, 381, 277, 207, 133, 9]));
    expect(t[0]).toBe(H);
    expect(t[1]).toBe(MAX);
    expect(t[2]).toBeCloseTo((MAX * 277) / 381);
    expect(t[4]).toBeCloseTo((MAX * 133) / 381);
    expect(t[5]).toBe(FLOOR); // 9 of 381 would be 4.5px: floored so it shows
  });

  it("empty stages get no bar and nothing flows into them", () => {
    const t = thickness(steps([5000, 900, 1, 0, 0, 0]));
    expect(t[2]).toBe(FLOOR);
    expect(t.slice(3)).toEqual([0, 0, 0]);
    const l = layout(t);
    expect(l.bars.slice(3).every((b) => b.h === 0)).toBe(true);
    expect(l.flows.map((f) => f.from)).toEqual([0, 1]);
  });

  it("each stage's bar tapers into the next one", () => {
    const t = thickness(steps([200, 100, 50, 50, 10, 5]));
    const l = layout(t);
    expect(l.bars.map((b) => b.h)).toEqual(t.map((v) => Math.round(v * 100) / 100));
    expect(l.bars.every((b) => Math.abs(b.y + b.h / 2 - H / 2) < 0.01)).toBe(true); // centered
    expect(l.bars[0].x).toBe(0); // the openers' mouth at the left edge
    expect(l.bars[1].x).toBeCloseTo(W / 6); // stage bars start one column in
    expect(l.bars[5].x).toBeCloseTo(W - 10); // last bar on the right edge
    expect(l.flows.map((f) => f.from)).toEqual([0, 1, 2, 3, 4]);
    // a ribbon starts at its bar's full height and ends at the next bar's full height
    const nums = (d: string) => [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const p = nums(l.flows[0].d);
    expect(p[0][1]).toBeCloseTo(l.bars[0].y);
    expect(p.at(-1)![1]).toBeCloseTo(l.bars[0].y + l.bars[0].h);
    expect(p.some(([x, y]) => Math.abs(x - l.bars[1].x) < 0.01 && Math.abs(y - l.bars[1].y) < 0.01)).toBe(true);
    expect(p.some(([x, y]) => Math.abs(x - l.bars[1].x) < 0.01 && Math.abs(y - (l.bars[1].y + l.bars[1].h)) < 0.01)).toBe(true);
  });

  it("each stage gets its own color", () => {
    const html = flowChart(steps([10, 5, 2, 1, 1, 0]), NAMES, { opener: "#111111", lead: "#333333", joined: "#222222" });
    expect(html).toContain('fill="#333333"'); // stage bars; the openers have no bar, only the mouth
    expect(html).toContain('stop-color="#111111"');
    expect(html).toContain('stop-color="#333333"');
    expect(html).toContain("--c:#222222");
    expect(html).toContain('class="fc-empty-bar"'); // the empty last stage still shows where it would be
  });

  it("percentages: one decimal, none when whole, nothing over zero", () => {
    expect(pct(57, 125)).toBe("45.6%");
    expect(pct(93, 1250)).toBe("7.4%");
    expect(pct(5, 10)).toBe("50%");
    expect(pct(3, 3)).toBe("100%");
    expect(pct(1, 4984)).toBe("<0.1%");
    expect(pct(0, 4)).toBe("0%");
    expect(pct(0, 0)).toBeNull();
  });

  it("renders counts, % of previous and % of all, plus a screen-reader table", () => {
    const html = flowChart(steps([12500, 5700, 930, 0, 0, 0]), NAMES);
    expect(html).toContain('<div class="fc-n">12,500</div>');
    expect(html).toContain("45.6%");
    expect(html).toContain("16.3%<span>7.4% of all</span>");
    expect(html).toMatch(/aria-label="Funnel: OPENER 12500, LEAD 5700, QUALIFY 930, PITCH 0/);
    expect(html).toContain("<tr><th scope=\"row\">LEAD</th><td>5700</td><td>930</td><td>45.6%</td><td>45.6%</td></tr>");
    expect(html).toContain('<path class="fc-flow"');
  });

  it("all zeros draws no band and says so", () => {
    const html = flowChart(steps([0, 0, 0, 0, 0, 0]), NAMES);
    expect(html).not.toContain('class="fc-flow"');
    expect(html).toContain("No leads in this range yet.");
  });
});
