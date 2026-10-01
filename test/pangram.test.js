const test = require("node:test");
const assert = require("node:assert/strict");
const { predict, API } = require("../src/pangram.js");

function fakeFetch(stages) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const json = (o) => ({
      ok: true,
      status: 200,
      json: async () => o,
      text: async () => JSON.stringify(o),
    });
    if (init.method === "POST") return json({ task_id: "t1" });
    return json(stages.shift() || { stage: "STAGE_PENDING" });
  };
  f.calls = calls;
  return f;
}

test("submits with model + key, polls, and maps the result", async () => {
  const f = fakeFetch([
    { stage: "STAGE_PENDING" },
    {
      stage: "STAGE_SUCCESS",
      prediction_short: "AI",
      headline: "AI Detected",
      fraction_ai: 0.93,
      fraction_ai_assisted: 0.05,
      fraction_human: 0.02,
    },
  ]);
  const r = await predict("some text one", "k-123", { fetch: f, pollMs: 1 });
  assert.deepEqual(r, {
    label: "AI",
    headline: "AI Detected",
    ai: 0.93,
    assisted: 0.05,
    human: 0.02,
  });
  const post = f.calls[0];
  assert.equal(post.url, API + "/task");
  assert.equal(post.init.headers["x-api-key"], "k-123");
  assert.deepEqual(JSON.parse(post.init.body), {
    text: "some text one",
    model: "default",
    public_dashboard_link: false,
  });
  assert.equal(f.calls[1].url, API + "/task/t1");
});

test("the same text is never sent twice", async () => {
  const f = fakeFetch([
    {
      stage: "STAGE_SUCCESS",
      prediction_short: "Human",
      fraction_ai: 0,
      fraction_ai_assisted: 0,
      fraction_human: 1,
    },
  ]);
  await predict("cached text", "k", { fetch: f, pollMs: 1 });
  const n = f.calls.length;
  await predict("cached text", "k", { fetch: f, pollMs: 1 });
  assert.equal(f.calls.length, n);
});

test("a failed task and a missing key both throw", async () => {
  const f = fakeFetch([{ stage: "STAGE_FAILED", headline: "too short" }]);
  await assert.rejects(predict("fails", "k", { fetch: f, pollMs: 1 }), /too short/);
  await assert.rejects(predict("x", "", { fetch: f }), /no Pangram API key/);
});
