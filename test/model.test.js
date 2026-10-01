const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const M = require("../src/model.js");

const dir = join(__dirname, "..", "model");
const built = existsSync(join(dir, "meta.json")) && existsSync(join(dir, "weights.bin"));

test("fnv-1a matches the reference values", () => {
  assert.equal(M.fnv(""), 0x811c9dc5);
  assert.equal(M.fnv("a"), 0xe40c292c);
  assert.equal(M.fnv("foobar"), 0xbf9cf968);
});

test("tokens: lowercased, digits folded, newlines kept as ¶, emoji folded", () => {
  assert.deepEqual(M.tokens("Hello, World 2024!\n🚀 Go"), [
    "hello",
    ",",
    "world",
    "0",
    "!",
    "¶",
    "EMO",
    "go",
  ]);
});

test(
  "JS featurizer is byte-identical to the Python trainer's",
  { skip: !built && "run bin/train.py first" },
  () => {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    const js = [...M.featurize(meta.probe.text)].sort((a, b) => a - b);
    assert.deepEqual(js, meta.probe.features);
    const model = M.load(readFileSync(join(dir, "weights.bin")).buffer.slice(0), meta);
    assert.ok(Math.abs(M.probability(model, meta.probe.text) - meta.probe.p) < 1e-4);
  },
);
