const test = require("node:test");
const assert = require("node:assert/strict");
const { analyze } = require("../src/detector.js");
const ai = require("./fixtures/ai.json");
const pd = require("./fixtures/human-pd.json");

test("tuned AI samples read as slop (patterns were written against these — a floor, not a score)", () => {
  const caught = ai.filter((s) => analyze(s.text).verdict === "slop").length;
  assert.ok(caught / ai.length >= 0.85, `caught ${caught}/${ai.length}`);
});

test("public-domain prose is never called slop", () => {
  const bad = pd.filter((s) => analyze(s.text).verdict === "slop");
  assert.equal(bad.length, 0, bad.map((b) => b.text.slice(0, 80)).join("\n"));
});

test("chatbot tics and disclaimers are caught and named", () => {
  const r = analyze(
    "Great question! As an AI language model, I don't have personal opinions, but here's the thing: it's worth noting that context matters. I hope this helps!",
  );
  assert.equal(r.verdict, "slop");
  const labels = r.tells.map((t) => t.label);
  assert.ok(labels.includes("model disclaimer"));
  assert.ok(labels.includes("chatbot tic"));
});

test("ordinary 'Of course,' and a single em dash are not tells", () => {
  const r = analyze(
    "Of course, the migration broke on the null rows — we caught it in staging. The fix took an afternoon and a diff of the counts before and after.",
  );
  assert.equal(r.verdict, "clean");
});

test("too short or non-English text is left alone", () => {
  assert.equal(analyze("delve tapestry").verdict, "clean");
  const de = analyze(
    "Der schnelle braune Fuchs springt über den faulen Hund, während die Katze schläft und träumt. Übermäßig viele Umlaute: äöü äöü äöü äöü äöü äöü äöü.",
  );
  assert.equal(de.verdict, "clean");
});

test("each tell carries a sample and a fix for the cook panel", () => {
  const r = analyze(
    "We leverage cutting-edge synergy to delve into a rich tapestry of seamless, robust solutions for everyone involved here.",
  );
  for (const t of r.tells) {
    assert.ok(t.sample, t.label);
    assert.ok(t.fix, t.label);
  }
});
