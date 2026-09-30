/*
  no-slop · pangram — optional second opinion from Pangram's detector (paid API, your key).

  API shape from Pangram's MIT-licensed SDK (github.com/pangramlabs/pangram-sdk,
  pangram/text_classifier.py): POST {text, model, public_dashboard_link} to /task with
  an x-api-key header, then poll /task/{id} until stage is STAGE_SUCCESS or STAGE_FAILED.
  `model` is sent explicitly: omitting it stops being supported after 30 Sep 2026.

  Text only leaves the machine through this file, and only when the user has put a key in
  the options page and chosen a Pangram mode. Results are cached by text so a block is
  never paid for twice.
*/
(function (root) {
  "use strict";
  const API = "https://text.external-api.pangram.com";
  const cache = new Map();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function predict(text, key, opts) {
    const o = Object.assign(
      {
        model: "default",
        timeoutMs: 60000,
        pollMs: 700,
        fetch: root.fetch && root.fetch.bind(root),
      },
      opts,
    );
    if (!key) throw new Error("no Pangram API key");
    const hit = cache.get(text);
    if (hit) return hit;
    const headers = { "x-api-key": key, "content-type": "application/json" };
    const r = await o.fetch(API + "/task", {
      method: "POST",
      headers,
      body: JSON.stringify({
        text,
        model: o.model,
        public_dashboard_link: false,
      }),
    });
    if (!r.ok)
      throw new Error(
        "pangram " + r.status + ": " + (await r.text()).slice(0, 160),
      );
    const { task_id } = await r.json();
    if (!task_id) throw new Error("pangram: no task_id");
    const deadline = Date.now() + o.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(o.pollMs);
      const g = await o.fetch(API + "/task/" + encodeURIComponent(task_id), {
        headers,
      });
      if (!g.ok) continue;
      const d = await g.json();
      if (d.stage === "STAGE_FAILED")
        throw new Error(
          "pangram: " + (d.headline || d.detail || "task failed"),
        );
      if (d.stage === "STAGE_SUCCESS") {
        const out = {
          label: d.prediction_short || "",
          headline: d.headline || "",
          ai: +d.fraction_ai || 0,
          assisted: +d.fraction_ai_assisted || 0,
          human: +d.fraction_human || 0,
        };
        if (cache.size > 500) cache.delete(cache.keys().next().value);
        cache.set(text, out);
        return out;
      }
    }
    throw new Error("pangram: timed out");
  }

  const api = { predict, API };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NoSlopPangram = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
