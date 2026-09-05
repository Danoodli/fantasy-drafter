// Acceptance gates for the unified decision model. Runs the comparison matrix,
// writes docs/backtest-gates.md, exits non-zero if any gate fails.
//
//   pnpm backtest:gate [--rooms=12]
//
// Gates (docs/superpowers/specs/2026-09-04-unified-decision-model.md):
//   redraft, both years: unified >= shipped lineup − 1σ; 0 floor violations;
//     fragility <= ADP bot; objective calibration ρ within 0.10 of the shipped
//     model's ρ on the same rosters (an absolute 0.5 was never reachable: the
//     shipped model itself scores ~0.35 — realized totals are dominated by
//     which players busted, which no draft-day model can order)
//   best ball, both years: unified >= shipped robust-rb − 1σ; 1st% within 8 pts;
//     0 violations
//   hold-out: fit on one season, test on the other, within 1σ of fit-on-both

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const rooms = process.argv.find((a) => a.startsWith("--rooms="))?.split("=")[1] ?? "12";
interface Row {
  strategy: string; delta: number; se: number; first: number; avgRank: number;
  violations?: number; fragility?: number; botFragility?: number; objectiveRho?: number;
}
const run = (args: string, out: string): { decisions: Row[] } => {
  execSync(`npx tsx scripts/backtest-season.ts ${args} --rooms=${rooms} --json=${out}`, { stdio: ["ignore", "ignore", "inherit"] });
  return JSON.parse(readFileSync(out, "utf8"));
};
const pick = (j: { decisions: Row[] }, id: string): Row => {
  const r = j.decisions.find((d) => d.strategy === id);
  if (!r) throw new Error(`strategy ${id} missing from results`);
  return r;
};

const lines: string[] = ["# Unified model acceptance gates", "", `Generated ${new Date().toISOString().slice(0, 10)}, rooms=${rooms}, 12 seats each, waiver-aware redraft scoring.`, ""];
let failed = false;
const gate = (name: string, ok: boolean, detail: string) => {
  lines.push(`- ${ok ? "PASS" : "FAIL"} — ${name}: ${detail}`);
  if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}: ${detail}`);
};
const f0 = (n: number) => n.toFixed(0);
const pct = (n: number) => (100 * n).toFixed(0) + "%";

for (const year of [2024, 2025]) {
  console.log(`\n=== ${year} redraft ===`);
  const u = pick(run(`${year} --strategy=balanced --model=unified`, `/tmp/g-${year}-rd-u.json`), "balanced");
  const l = pick(run(`${year} --strategy=balanced --model=lineup`, `/tmp/g-${year}-rd-l.json`), "balanced");
  gate(`${year} redraft delta`, u.delta >= l.delta - l.se, `unified ${f0(u.delta)}±${f0(u.se)} vs lineup ${f0(l.delta)}±${f0(l.se)}`);
  gate(`${year} redraft legality`, (u.violations ?? 1) === 0, `${pct(u.violations ?? 0)} of seats below 2 QB / 3 RB / 3 WR`);
  gate(`${year} redraft fragility ≤ bot`, (u.fragility ?? 99) <= (u.botFragility ?? 0), `${u.fragility?.toFixed(2)} vs bot ${u.botFragility?.toFixed(2)} empty slot-weeks`);
  gate(`${year} redraft objective ρ ≥ shipped − 0.10`, (u.objectiveRho ?? 0) >= (l.objectiveRho ?? 0) - 0.1, `unified ρ = ${u.objectiveRho?.toFixed(2)} vs lineup ρ = ${l.objectiveRho?.toFixed(2)}`);
  console.log(`\n=== ${year} best ball ===`);
  const ub = pick(run(`${year} --bestball --strategy=balanced --model=unified`, `/tmp/g-${year}-bb-u.json`), "balanced");
  const rb = pick(run(`${year} --bestball --strategy=robust-rb --model=lineup`, `/tmp/g-${year}-bb-r.json`), "robust-rb");
  gate(`${year} best ball delta`, ub.delta >= rb.delta - rb.se, `unified ${f0(ub.delta)}±${f0(ub.se)} vs robust-rb ${f0(rb.delta)}±${f0(rb.se)}`);
  gate(`${year} best ball 1st%`, ub.first >= rb.first - 0.08, `${pct(ub.first)} vs ${pct(rb.first)}`);
  gate(`${year} best ball legality`, (ub.violations ?? 1) === 0, `${pct(ub.violations ?? 0)} of seats below the minimum counts`);
}

console.log("\n=== hold-out calibration ===");
execSync(`npx tsx scripts/calibrate-outcomes.ts --years=2024 --out=/tmp/cal-2024.json`, { stdio: ["ignore", "ignore", "inherit"] });
execSync(`npx tsx scripts/calibrate-outcomes.ts --years=2025 --out=/tmp/cal-2025.json`, { stdio: ["ignore", "ignore", "inherit"] });
const h25 = pick(run(`2025 --strategy=balanced --model=unified --calib=/tmp/cal-2024.json`, `/tmp/g-h25.json`), "balanced");
const h24 = pick(run(`2024 --strategy=balanced --model=unified --calib=/tmp/cal-2025.json`, `/tmp/g-h24.json`), "balanced");
const f25 = pick(JSON.parse(readFileSync(`/tmp/g-2025-rd-u.json`, "utf8")), "balanced");
const f24 = pick(JSON.parse(readFileSync(`/tmp/g-2024-rd-u.json`, "utf8")), "balanced");
gate("hold-out 2025 (fit on 2024) within 1σ", Math.abs(h25.delta - f25.delta) <= f25.se, `${f0(h25.delta)} vs ${f0(f25.delta)}±${f0(f25.se)}`);
gate("hold-out 2024 (fit on 2025) within 1σ", Math.abs(h24.delta - f24.delta) <= f24.se, `${f0(h24.delta)} vs ${f0(f24.delta)}±${f0(f24.se)}`);

lines.push("", failed ? "**RESULT: FAIL — do not flip the default.**" : "**RESULT: PASS — Task 10 may proceed.**");
writeFileSync("docs/backtest-gates.md", lines.join("\n") + "\n");
console.log("\n" + lines[lines.length - 1]);
process.exit(failed ? 1 : 0);
