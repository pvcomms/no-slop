/*
  no-slop · model — a small linear classifier: P(text was machine-written).

  Features are hashed word unigrams + bigrams (presence, L2-normalised), 2^bits buckets
  (bits comes from model/meta.json), int8 weights in model/weights.bin with a float scale +
  bias in model/meta.json.
  Trained by bin/train.py, which re-implements featurize() in Python — the two must stay
  byte-identical (test/model.test.js checks a fixed hash against the trainer's output).

  Loaded by the service worker only; pages never see it.
*/
(function (root) {
  "use strict";
  const DEFAULT_BITS = 17;
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const TOKEN = /[a-z0-9]+(?:'[a-z]+)?|[—–!?;:,.()"…¶]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  const MAX_TOKENS = 600;
  const enc = new TextEncoder();

  function prep(text) {
    return String(text || "")
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\u00a0/g, " ")
      .toLowerCase()
      .replace(/[0-9]+/g, "0")
      .replace(/\s*\n+\s*/g, " ¶ ");
  }

  function tokens(text) {
    const t = prep(text).match(TOKEN) || [];
    return t.slice(0, MAX_TOKENS).map((x) => (EMOJI.test(x) ? "EMO" : x));
  }

  function fnv(s) {
    let h = 0x811c9dc5;
    for (const c of enc.encode(s)) {
      h ^= c;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  function featurize(text, bits) {
    const mask = (1 << (bits || DEFAULT_BITS)) - 1;
    const t = tokens(text);
    const set = new Set();
    for (let i = 0; i < t.length; i++) {
      set.add(fnv("u" + t[i]) & mask);
      if (i + 1 < t.length) set.add(fnv("b" + t[i] + " " + t[i + 1]) & mask);
    }
    return set;
  }

  function load(buffer, meta) {
    const w = new Int8Array(buffer);
    const bits = meta.bits || DEFAULT_BITS;
    if (w.length !== 1 << bits)
      throw new Error(`no-slop: weights are ${w.length} bytes, meta says 2^${bits}`);
    return { w, bits, scale: meta.scale, bias: meta.bias, meta };
  }

  function probability(model, text) {
    const f = featurize(text, model.bits);
    if (!f.size) return 0.5;
    let z = 0;
    for (const i of f) z += model.w[i];
    z = model.bias + (z * model.scale) / Math.sqrt(f.size);
    return 1 / (1 + Math.exp(-z));
  }

  const api = { featurize, tokens, fnv, load, probability };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NoSlopModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
