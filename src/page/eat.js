/*
  no-slop · eat — finds blocks of prose on the page (posts, comments, paragraphs), scores each
  one (pattern tells here + the model in the service worker), and blurs the ones that read as
  machine-written, with a one-line note: why, and a "show" button. Large images are checked for
  an AI-generation label. Owns pause / resume and starts the page once settings load.
*/
(() => {
  "use strict";
  const NS = globalThis.NoSlop;
  const P = globalThis.NoSlopPage;
  const { h, pct, send, shadowHost, revealButton, decide, MINW } = P;
  const host = location.hostname;

  // ---------------------------------------------------------------- what counts as a block
  const ADAPTERS = [
    [/(^|\.)(x|twitter)\.com$/, '[data-testid="tweetText"]'],
    [
      /(^|\.)reddit\.com$/,
      '[slot="comment"], [slot="text-body"], [data-testid="comment"], .usertext-body .md',
    ],
    [
      /(^|\.)linkedin\.com$/,
      ".feed-shared-update-v2__description, .update-components-text, .comments-comment-item__main-content",
    ],
    [/(^|\.)youtube\.com$/, "#content-text"],
    [/(^|\.)ycombinator\.com$/, ".commtext"],
    [/(^|\.)bsky\.app$/, '[data-testid="postText"]'],
    [/(^|\.)threads\.(net|com)$/, 'div[data-pressable-container] span[dir="auto"]'],
    [/(^|\.)facebook\.com$/, '[data-ad-preview="message"], [data-ad-comet-preview="message"]'],
  ];
  const adapter = (ADAPTERS.find(([re]) => re.test(host)) || [])[1];
  const PROSE = "p, li, blockquote, dd, figcaption";
  const SELECTOR = adapter ? adapter + ", " + PROSE : PROSE;
  const SKIP =
    "nav, header, footer, aside, code, pre, textarea, input, select, button, label, svg, script, style, noscript, " +
    '[contenteditable=""], [contenteditable="true"], [role="textbox"], [role="navigation"], [' +
    P.UI_ATTR +
    "]";

  const done = new WeakMap(); // element → text length when last scored
  const units = new Map(); // id → unit
  let nextId = 1;

  const textOf = (el) => (el.innerText || el.textContent || "").trim();

  function collect(root) {
    const found = [];
    if (root.nodeType !== 1) return found;
    if (root.matches && root.matches(SELECTOR)) found.push(root);
    found.push(...root.querySelectorAll(SELECTOR));
    const leaves = found.filter((el) => !el.closest(SKIP) && !el.querySelector(SELECTOR));

    const out = [];
    const shortByParent = new Map();
    for (const el of leaves) {
      const text = textOf(el);
      if (done.get(el) === text.length) continue;
      const w = NS.countWords(text);
      if (w >= MINW || (adapter && el.matches(adapter) && w >= 12)) out.push({ els: [el], text });
      else if (w >= 1) {
        const p = el.parentElement;
        if (!p) continue;
        if (!shortByParent.has(p)) shortByParent.set(p, []);
        shortByParent.get(p).push(el);
      }
    }
    // runs of short paragraphs under one parent read as one block (e.g. one-line-per-paragraph posts)
    for (const els of shortByParent.values()) {
      if (els.length < 3) continue;
      const text = els.map(textOf).join("\n");
      if (NS.countWords(text) >= MINW) out.push({ els, text });
    }
    return out;
  }

  // ---------------------------------------------------------------- verdicts
  function note(unit, verdict) {
    const { hostEl, root } = shadowHost("span");
    const n = h("div", "n" + (verdict === "suspect" ? " maybe" : ""));
    n.append(h("span", "tag", verdict === "slop" ? "slop" : "maybe slop"));
    // show the model's number only when the model is part of the reason
    if (unit.p != null && P.thresholds && unit.p >= P.thresholds.strict)
      n.append(h("span", "p", pct(unit.p) + " machine"));
    const why = unit.local.tells.slice(0, 3).map((t) => t.label);
    if (why.length) n.append(h("span", "why", why.join(" · ")));
    const pg = h("span", "pg");
    n.append(pg);
    n.title =
      unit.local.tells.map((t) => `${t.label} — “${t.sample}”`).join("\n") || "scored by the model";
    if (verdict === "slop" && P.S.action === "blur") n.append(revealButton(unit.els));
    root.append(n);
    unit.pg = pg;
    return hostEl;
  }

  function apply(unit) {
    const verdict = decide(unit.local, unit.p, unit.words);
    unit.verdict = verdict;
    if (verdict === "clean") return;
    const state = verdict === "slop" && P.S.action === "blur" ? "blocked" : "labelled";
    for (const el of unit.els) el.setAttribute("data-noslop", state);
    unit.note = note(unit, verdict);
    unit.els[0].prepend(unit.note);
    count();
    if (verdict === "slop" && P.S.pangram === "confirm" && unit.words >= 50)
      confirmWithPangram(unit);
  }

  async function confirmWithPangram(unit) {
    unit.pg.textContent = "pangram …";
    const r = await send({
      t: "pangram",
      text: unit.text.slice(0, P.PANGRAM_CHARS),
      why: "confirm",
    });
    if (!r || r.skipped) return (unit.pg.textContent = "");
    if (r.error) return (unit.pg.textContent = "pangram unavailable");
    unit.pg.textContent = "";
    unit.pg.append("pangram ", h("b", "", r.label || "?"), " " + pct(r.ai + r.assisted));
    if (/human/i.test(r.label)) {
      for (const el of unit.els) el.setAttribute("data-noslop", "labelled");
      unit.verdict = "suspect";
      count();
    }
  }

  function count() {
    let n = 0;
    for (const u of units.values()) if (u.verdict === "slop" && u.els[0].isConnected) n++;
    send({ t: "count", n, paused: false });
  }

  // ---------------------------------------------------------------- scanning
  const pending = new Set();
  let timer = 0;
  function schedule(root) {
    if (P.paused || !P.S.eat) return;
    pending.add(root || document.body);
    clearTimeout(timer);
    timer = setTimeout(flush, 350);
  }

  async function flush() {
    const roots = [...pending];
    pending.clear();
    const batch = [];
    for (const r of roots) if (r && r.isConnected) for (const u of collect(r)) batch.push(u);
    const seen = new Set();
    const fresh = batch.filter((u) => (seen.has(u.els[0]) ? false : (seen.add(u.els[0]), true)));
    if (!fresh.length) return;
    for (const u of fresh) {
      u.id = nextId++;
      u.words = NS.countWords(u.text);
      u.local = NS.analyze(u.text, { sensitivity: P.S.sensitivity });
      for (const el of u.els) done.set(el, textOf(el).length);
      units.set(u.id, u);
    }
    const res = await send({
      t: "score",
      items: fresh
        .filter((u) => u.words >= MINW)
        .map((u) => ({ id: u.id, text: u.text.slice(0, P.MODEL_CHARS) })),
    });
    if (res && res.thresholds) P.thresholds = res.thresholds;
    const byId = new Map(((res && res.items) || []).map((x) => [x.id, x.p]));
    for (const u of fresh) {
      u.p = byId.has(u.id) ? byId.get(u.id) : null;
      if (!P.paused) apply(u);
    }
  }

  // ---------------------------------------------------------------- images
  const imgSeen = new WeakSet();
  const io =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              io.unobserve(e.target);
              checkImage(e.target);
            }
          },
          { rootMargin: "200px" },
        )
      : null;

  function watchImages(root) {
    if (!P.S.images || P.paused || !io || root.nodeType !== 1) return;
    const imgs = root.tagName === "IMG" ? [root] : root.querySelectorAll("img");
    for (const img of imgs) {
      if (imgSeen.has(img)) continue;
      imgSeen.add(img);
      io.observe(img);
    }
  }

  async function checkImage(img) {
    const url = img.currentSrc || img.src;
    if (!url || !/^https?:/.test(url)) return;
    if ((img.naturalWidth || img.width) < 200 || (img.naturalHeight || img.height) < 200) return;
    const r = await send({ t: "img", url });
    if (!r || !r.ai || P.paused) return;
    img.setAttribute("data-noslop", P.S.action === "blur" ? "blocked" : "labelled");
    const { hostEl, root } = shadowHost("span");
    const n = h("div", "n");
    n.append(h("span", "tag", "ai image"), h("span", "why", r.kind + " · " + r.source));
    if (P.S.action === "blur") n.append(revealButton([img]));
    root.append(n);
    img.before(hostEl);
    units.set(nextId++, { els: [img], verdict: "slop", note: hostEl });
    count();
  }

  // ---------------------------------------------------------------- pause / resume
  function clearAll() {
    for (const u of units.values()) {
      for (const el of u.els) el.removeAttribute("data-noslop");
      if (u.note) u.note.remove();
    }
    units.clear();
  }

  const mo = new MutationObserver((muts) => {
    for (const m of muts)
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1 || n.hasAttribute(P.UI_ATTR)) continue;
        schedule(n.parentElement || n);
        watchImages(n);
      }
  });

  function start() {
    P.paused = !!(P.S.paused && P.S.paused[host]);
    if (P.paused) {
      clearAll();
      mo.disconnect();
      send({ t: "count", n: 0, paused: true });
      return;
    }
    send({ t: "count", n: 0, paused: false });
    if (!document.body) return;
    mo.observe(document.body, { childList: true, subtree: true });
    schedule(document.body);
    watchImages(document.body);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const k of Object.keys(changes)) P.S[k] = changes[k].newValue;
    clearAll();
    for (const el of document.querySelectorAll("[data-noslop]")) el.removeAttribute("data-noslop");
    mo.disconnect();
    // forget what was scored so everything is judged again under the new settings
    for (const el of document.querySelectorAll(SELECTOR)) done.delete(el);
    start();
  });

  // ---------------------------------------------------------------- go
  globalThis.NoSlopSettings.load().then((s) => {
    P.S = s;
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });
})();
