#!/usr/bin/env node
// Score every held-out set with the extension's own decision: pattern tells (src/detector.js)
// OR the local model (src/model.js + model/weights.bin), per sensitivity. Nothing here was
// trained on. Sets come from test/fixtures/.cache/heldout.jsonl, written by bin/train.py.
//   --misses   AI texts the extension would let through (balanced)
//   --worst    human texts it would wrongly blur (balanced)
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);
const { analyze, countWords } = req("../src/detector.js");
const M = req("../src/model.js");
const root = join(here, "..");
const meta = JSON.parse(await readFile(join(root, "model/meta.json"), "utf8"));
const model = M.load((await readFile(join(root, "model/weights.bin"))).buffer, meta);
const TH = meta.thresholds;
const MINW = 40;

// same rule as content.js decide()
function decide(text, sens) {
  const local = analyze(text, { sensitivity: sens });
  const words = countWords(text);
  const p = words >= MINW ? M.probability(model, text) : null;
  const modelSays =
    p == null ? null : p >= TH[sens] ? "slop" : p >= TH.strict ? "suspect" : "clean";
  const v =
    modelSays === "slop" || local.verdict === "slop"
      ? "slop"
      : modelSays === "suspect" || local.verdict === "suspect"
        ? "suspect"
        : "clean";
  return { v, p, local };
}

const rows = (await readFile(join(root, "test/fixtures/.cache/heldout.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const sets = new Map();
for (const r of rows) {
  if (!sets.has(r.set)) sets.set(r.set, []);
  sets.get(r.set).push(r);
}

const pct = (n, d) => ((100 * n) / d).toFixed(1).padStart(5) + "%";
console.log("share blurred (verdict = slop). human rows should be low, ai rows high.\n");
console.log("".padEnd(32) + "     n    gentle  balanced    strict   (model only, balanced)");
for (const [name, set] of sets) {
  const cells = ["gentle", "balanced", "strict"].map((s) =>
    pct(set.filter((r) => decide(r.text, s).v === "slop").length, set.length),
  );
  const modelOnly = set.filter(
    (r) => countWords(r.text) >= MINW && M.probability(model, r.text) >= TH.balanced,
  ).length;
  console.log(
    `${name.padEnd(32)}${String(set.length).padStart(6)}  ${cells.map((c) => c.padStart(8)).join("  ")}   (${pct(modelOnly, set.length)})`,
  );
}

if (process.argv.includes("--misses")) {
  console.log("\nai let through (balanced):");
  for (const r of rows.filter((r) => r.label === 1 && /hand|gpt-oss|qwen3/.test(r.set))) {
    const d = decide(r.text, "balanced");
    if (d.v !== "slop")
      console.log(
        `  [${r.set}] p=${d.p == null ? "—" : d.p.toFixed(2)} ${d.local.tells.map((t) => t.label).join(" · ")} | ${r.text.slice(0, 110).replace(/\n/g, " ")}…`,
      );
  }
}
if (process.argv.includes("--worst")) {
  console.log("\nhuman wrongly blurred (balanced):");
  for (const r of rows.filter((r) => r.label === 0)) {
    const d = decide(r.text, "balanced");
    if (d.v === "slop")
      console.log(
        `  [${r.set}] p=${d.p == null ? "—" : d.p.toFixed(2)} ${d.local.tells.map((t) => t.label).join(" · ")} | ${r.text.slice(0, 140).replace(/\n/g, " ")}…`,
      );
  }
}
