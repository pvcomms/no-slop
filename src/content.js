/*
  no-slop · content script

  EAT   finds blocks of prose on the page (posts, comments, paragraphs), scores each one
        (local pattern tells here + the model in the service worker), and blurs the ones
        that read as machine-written, with a one-line note: why, and a "show" button.
  IMAGE asks the service worker whether large images carry an AI-generation label.
  COOK  while you type in a text box, a small chip lists the tells in your own draft.
        Your draft never leaves the page — not to the model worker, not to Pangram.
  CHECK right-click → "Check selection for slop" shows a result card.
*/
(() => {
  "use strict";
  if (window.__noSlop) return;
  window.__noSlop = true;

  const NS = globalThis.NoSlop;
  const host = location.hostname;
  const DEFAULTS = {
    eat: true,
    sensitivity: "balanced",
    action: "blur",
    images: true,
    cook: true,
    pangram: "off",
    paused: {},
  };
  let S = Object.assign({}, DEFAULTS);
  let paused = false;
  let thresholds = null; // from the model's meta, via the worker
  const MINW = 40;

  // ---------------------------------------------------------------- ui kit (shadow dom)
  const UI_ATTR = "data-noslop-ui";
  try {
    const font = new FontFace(
      "NoSlop Mono",
      `url(${chrome.runtime.getURL("fonts/plexmono-latin-400.woff2")})`,
    );
    document.fonts.add(font);
    font.load().catch(() => {});
  } catch {}

  const CSS = `
    :host { all: initial !important; display: block !important; }
    * { box-sizing: border-box; }
    .n, .chip, .card, .panel {
      --ink: #0b0c0e; --paper: #e9e6de; --dim: #96917f; --hair: #2c2d30;
      --slop: #e07a6b; --maybe: #e3c567; --ok: #7fb069;
      font: 11.5px/1.5 "NoSlop Mono", "SFMono-Regular", Menlo, Consolas, monospace;
      letter-spacing: .02em; color: var(--paper); -webkit-font-smoothing: antialiased;
    }
    .n { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; margin: 0 0 6px;
         padding: 5px 10px; background: var(--ink); border: 1px solid var(--hair); border-radius: 6px;
         max-width: 100%; }
    .tag { color: var(--slop); text-transform: lowercase; }
    .n.maybe .tag { color: var(--maybe); }
    .p { color: var(--paper); font-variant-numeric: tabular-nums; }
    .why { color: var(--dim); overflow-wrap: anywhere; }
    .pg { color: var(--dim); }
    .pg b { font-weight: 400; color: var(--paper); }
    button { font: inherit; color: var(--paper); background: none; border: 0; border-bottom: 1px solid var(--dim);
             padding: 0; cursor: pointer; margin-left: auto; transition: color .15s ease, border-color .15s ease; }
    button:hover { color: var(--slop); border-color: var(--slop); }
    button:focus-visible { outline: 1px solid var(--maybe); outline-offset: 2px; }
    .chip { position: fixed; z-index: 2147483646; display: inline-flex; gap: 8px; align-items: baseline;
            padding: 4px 9px; background: var(--ink); border: 1px solid var(--hair); border-radius: 999px;
            cursor: pointer; opacity: 0; transform: translateY(4px);
            transition: opacity .18s cubic-bezier(.16,1,.3,1), transform .18s cubic-bezier(.16,1,.3,1); }
    .chip.on { opacity: .96; transform: none; }
    .chip .k { color: var(--dim); }
    .chip .v { color: var(--slop); }
    .chip.clean .v { color: var(--ok); }
    .panel { position: fixed; z-index: 2147483647; width: min(340px, 90vw); max-height: 50vh; overflow: auto;
             background: var(--ink); border: 1px solid var(--hair); border-radius: 8px; padding: 10px 12px; }
    .row { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; padding: 5px 0; border-top: 1px solid var(--hair); }
    .row:first-of-type { border-top: 0; }
    .row .fix { grid-column: 1 / -1; color: var(--dim); }
    .row .c { color: var(--dim); font-variant-numeric: tabular-nums; }
    .card { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: min(360px, calc(100vw - 32px));
            background: var(--ink); border: 1px solid var(--hair); border-radius: 10px; padding: 12px 14px;
            opacity: 0; transform: translateY(8px);
            transition: opacity .22s cubic-bezier(.16,1,.3,1), transform .22s cubic-bezier(.16,1,.3,1); }
    .card.on { opacity: 1; transform: none; }
    .card .head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
    .card .verdict { font-size: 13px; }
    .card .verdict.slop { color: var(--slop); } .card .verdict.suspect { color: var(--maybe); } .card .verdict.clean { color: var(--ok); }
    .card .meta { color: var(--dim); }
    @media (prefers-reduced-motion: reduce) { .chip, .card { transition: none; } }
  `;

  function shadowHost(tag) {
    const hostEl = document.createElement(tag || "span");
    hostEl.setAttribute(UI_ATTR, "");
    const root = hostEl.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.append(style);
    return { hostEl, root };
  }
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const pct = (p) => (p == null ? "" : Math.round(p * 100) + "%");
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

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
    [
      /(^|\.)threads\.(net|com)$/,
      'div[data-pressable-container] span[dir="auto"]',
    ],
    [
      /(^|\.)facebook\.com$/,
      '[data-ad-preview="message"], [data-ad-comet-preview="message"]',
    ],
  ];
  const adapter = (ADAPTERS.find(([re]) => re.test(host)) || [])[1];
  const PROSE = "p, li, blockquote, dd, figcaption";
  const SELECTOR = adapter ? adapter + ", " + PROSE : PROSE;
  const SKIP =
    "nav, header, footer, aside, code, pre, textarea, input, select, button, label, svg, script, style, noscript, " +
    '[contenteditable=""], [contenteditable="true"], [role="textbox"], [role="navigation"], [' +
    UI_ATTR +
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
    const leaves = found.filter(
      (el) => !el.closest(SKIP) && !el.querySelector(SELECTOR),
    );

    const out = [];
    const shortByParent = new Map();
    for (const el of leaves) {
      const text = textOf(el);
      if (done.get(el) === text.length) continue;
      const w = NS.countWords(text);
      if (w >= MINW || (adapter && el.matches(adapter) && w >= 12))
        out.push({ els: [el], text });
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
  function decide(local, p, words) {
    const sens = S.sensitivity;
    const t = thresholds || {};
    const tNow = t[sens];
    const tStrict = t.strict;
    const modelSays =
      p != null && tNow != null && words >= MINW
        ? p >= tNow
          ? "slop"
          : tStrict != null && p >= tStrict
            ? "suspect"
            : "clean"
        : null;
    if (modelSays === "slop" || local.verdict === "slop") return "slop";
    if (modelSays === "suspect" || local.verdict === "suspect")
      return "suspect";
    return "clean";
  }

  function reasons(local) {
    return local.tells.slice(0, 3).map((t) => t.label);
  }

  function note(unit, verdict) {
    const { hostEl, root } = shadowHost("span");
    const n = h("div", "n" + (verdict === "suspect" ? " maybe" : ""));
    n.append(h("span", "tag", verdict === "slop" ? "slop" : "maybe slop"));
    // show the model's number only when the model is part of the reason
    if (unit.p != null && thresholds && unit.p >= thresholds.strict) n.append(h("span", "p", pct(unit.p) + " machine"));
    const why = reasons(unit.local);
    if (why.length) n.append(h("span", "why", why.join(" · ")));
    const pg = h("span", "pg");
    n.append(pg);
    n.title =
      unit.local.tells.map((t) => `${t.label} — “${t.sample}”`).join("\n") ||
      "scored by the model";
    if (verdict === "slop" && S.action === "blur") {
      const b = h("button", "", "show");
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const hidden = unit.els[0].getAttribute("data-noslop") === "blocked";
        for (const el of unit.els)
          el.setAttribute("data-noslop", hidden ? "shown" : "blocked");
        b.textContent = hidden ? "hide" : "show";
      });
      n.append(b);
    }
    root.append(n);
    unit.pg = pg;
    return hostEl;
  }

  function apply(unit) {
    const verdict = decide(unit.local, unit.p, unit.words);
    unit.verdict = verdict;
    if (verdict === "clean") return;
    const state =
      verdict === "slop" && S.action === "blur" ? "blocked" : "labelled";
    for (const el of unit.els) el.setAttribute("data-noslop", state);
    unit.note = note(unit, verdict);
    unit.els[0].prepend(unit.note);
    count();
    if (verdict === "slop" && S.pangram === "confirm" && unit.words >= 50)
      confirm(unit);
  }

  async function confirm(unit) {
    unit.pg.textContent = "pangram …";
    const r = await send({
      t: "pangram",
      text: unit.text.slice(0, 20000),
      why: "confirm",
    });
    if (!r || r.skipped) return (unit.pg.textContent = "");
    if (r.error) return (unit.pg.textContent = "pangram unavailable");
    unit.pg.textContent = "";
    unit.pg.append(
      "pangram ",
      h("b", "", r.label || "?"),
      " " + pct(r.ai + r.assisted),
    );
    if (/human/i.test(r.label)) {
      for (const el of unit.els) el.setAttribute("data-noslop", "labelled");
      unit.verdict = "suspect";
      count();
    }
  }

  function count() {
    let n = 0;
    for (const u of units.values())
      if (u.verdict === "slop" && u.els[0].isConnected) n++;
    send({ t: "count", n, paused: false });
  }

  // ---------------------------------------------------------------- scanning
  const pending = new Set();
  let timer = 0;
  function schedule(root) {
    if (paused || !S.eat) return;
    pending.add(root || document.body);
    clearTimeout(timer);
    timer = setTimeout(flush, 350);
  }

  async function flush() {
    const roots = [...pending];
    pending.clear();
    const batch = [];
    for (const r of roots)
      if (r && r.isConnected) for (const u of collect(r)) batch.push(u);
    const seen = new Set();
    const fresh = batch.filter((u) =>
      seen.has(u.els[0]) ? false : (seen.add(u.els[0]), true),
    );
    if (!fresh.length) return;
    for (const u of fresh) {
      u.id = nextId++;
      u.words = NS.countWords(u.text);
      u.local = NS.analyze(u.text, { sensitivity: S.sensitivity });
      for (const el of u.els) done.set(el, textOf(el).length);
      units.set(u.id, u);
    }
    const res = await send({
      t: "score",
      items: fresh
        .filter((u) => u.words >= MINW)
        .map((u) => ({ id: u.id, text: u.text.slice(0, 6000) })),
    });
    if (res && res.thresholds) thresholds = res.thresholds;
    const byId = new Map(((res && res.items) || []).map((x) => [x.id, x.p]));
    for (const u of fresh) {
      u.p = byId.has(u.id) ? byId.get(u.id) : null;
      if (!paused) apply(u);
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
    if (!S.images || paused || !io || root.nodeType !== 1) return;
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
    if (
      (img.naturalWidth || img.width) < 200 ||
      (img.naturalHeight || img.height) < 200
    )
      return;
    const r = await send({ t: "img", url });
    if (!r || !r.ai || paused) return;
    img.setAttribute(
      "data-noslop",
      S.action === "blur" ? "blocked" : "labelled",
    );
    const { hostEl, root } = shadowHost("span");
    const n = h("div", "n");
    n.append(
      h("span", "tag", "ai image"),
      h("span", "why", r.kind + " · " + r.source),
    );
    if (S.action === "blur") {
      const b = h("button", "", "show");
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const hidden = img.getAttribute("data-noslop") === "blocked";
        img.setAttribute("data-noslop", hidden ? "shown" : "blocked");
        b.textContent = hidden ? "hide" : "show";
      });
      n.append(b);
    }
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
        if (n.nodeType !== 1 || n.hasAttribute(UI_ATTR)) continue;
        schedule(n.parentElement || n);
        watchImages(n);
      }
  });

  function start() {
    paused = !!(S.paused && S.paused[host]);
    if (paused) {
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
    for (const k of Object.keys(changes)) S[k] = changes[k].newValue;
    clearAll();
    for (const el of document.querySelectorAll("[data-noslop]"))
      el.removeAttribute("data-noslop");
    mo.disconnect();
    // forget what was scored so everything is judged again under the new settings
    for (const el of document.querySelectorAll(SELECTOR)) done.delete(el);
    start();
  });

  // ---------------------------------------------------------------- cook: your own drafts
  let cook = null;
  function editable(t) {
    if (!t || t.nodeType !== 1) return null;
    if (t.tagName === "TEXTAREA") return t;
    if (t.tagName === "INPUT") return null;
    return t.closest(
      '[contenteditable=""], [contenteditable="true"], [role="textbox"]',
    );
  }
  function cookText(el) {
    return el.tagName === "TEXTAREA" ? el.value : el.innerText || "";
  }

  function cookUI() {
    if (cook) return cook;
    const { hostEl, root } = shadowHost("div");
    const chip = h("div", "chip");
    chip.setAttribute("role", "button");
    chip.tabIndex = 0;
    const k = h("span", "k", "cook");
    const v = h("span", "v", "");
    chip.append(k, v);
    const panel = h("div", "panel");
    panel.hidden = true;
    root.append(chip, panel);
    document.documentElement.append(hostEl);
    const toggle = () => {
      panel.hidden = !panel.hidden;
      place();
    };
    chip.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the draft
    chip.addEventListener("click", toggle);
    chip.addEventListener(
      "keydown",
      (e) =>
        (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()),
    );
    cook = { hostEl, chip, v, panel, el: null, t: 0, r: null };
    return cook;
  }

  function place() {
    if (!cook || !cook.el || !cook.el.isConnected) return;
    const rc = cook.el.getBoundingClientRect();
    const cw = cook.chip.offsetWidth || 90;
    const x = Math.max(
      8,
      Math.min(window.innerWidth - cw - 8, rc.right - cw - 8),
    );
    const y = Math.max(8, Math.min(window.innerHeight - 34, rc.bottom - 30));
    cook.chip.style.left = x + "px";
    cook.chip.style.top = y + "px";
    if (!cook.panel.hidden) {
      const pw = Math.min(340, window.innerWidth * 0.9);
      cook.panel.style.left =
        Math.max(8, Math.min(window.innerWidth - pw - 8, rc.right - pw)) + "px";
      const ph = cook.panel.offsetHeight || 200;
      cook.panel.style.top =
        (y - ph - 8 > 8
          ? y - ph - 8
          : Math.min(window.innerHeight - ph - 8, y + 30)) + "px";
    }
  }

  function renderCook() {
    const c = cook;
    const text = cookText(c.el);
    const r = NS.analyze(text, { sensitivity: "strict" });
    c.r = r;
    if (r.words < 12) {
      c.chip.classList.remove("on");
      c.panel.hidden = true;
      return;
    }
    const n = r.tells.reduce((a, t) => a + t.count, 0);
    c.chip.classList.toggle("clean", n === 0);
    c.v.textContent = n === 0 ? "no tells" : n + (n === 1 ? " tell" : " tells");
    c.panel.textContent = "";
    if (n === 0)
      c.panel.append(
        h("div", "why", "Nothing on the list. Read it aloud anyway."),
      );
    for (const t of r.tells) {
      const row = h("div", "row");
      row.append(h("span", "", t.label), h("span", "c", "×" + t.count));
      row.append(
        h("span", "fix", "“" + t.sample + "” → " + (t.fix || "rewrite")),
      );
      c.panel.append(row);
    }
    c.chip.classList.add("on");
    place();
  }

  document.addEventListener(
    "focusin",
    (e) => {
      if (!S.cook || paused) return;
      const el = editable(e.target);
      if (!el) return;
      const c = cookUI();
      c.el = el;
      renderCook();
    },
    true,
  );
  document.addEventListener(
    "input",
    (e) => {
      if (!cook || !S.cook || paused) return;
      const el = editable(e.target);
      if (!el || el !== cook.el) return;
      clearTimeout(cook.t);
      cook.t = setTimeout(renderCook, 300);
    },
    true,
  );
  document.addEventListener(
    "focusout",
    (e) => {
      if (!cook || editable(e.target) !== cook.el) return;
      setTimeout(() => {
        if (
          document.activeElement &&
          editable(document.activeElement) === cook.el
        )
          return;
        if (cook.panel.hidden) cook.chip.classList.remove("on");
      }, 200);
    },
    true,
  );
  window.addEventListener(
    "scroll",
    () => cook && requestAnimationFrame(place),
    { passive: true, capture: true },
  );
  window.addEventListener(
    "resize",
    () => cook && requestAnimationFrame(place),
    { passive: true },
  );

  // ---------------------------------------------------------------- check selection
  let card = null;
  async function checkSelection(text) {
    text = (text || String(window.getSelection() || "")).trim();
    if (!text) return;
    if (card) card.remove();
    const { hostEl, root } = shadowHost("div");
    card = hostEl;
    const c = h("div", "card");
    c.setAttribute("role", "dialog");
    c.setAttribute("aria-label", "no slop check");
    const head = h("div", "head");
    const verdictEl = h("span", "verdict", "reading …");
    const close = h("button", "", "close");
    close.addEventListener("click", () => hostEl.remove());
    head.append(verdictEl, close);
    const meta = h("div", "meta", "");
    const list = h("div", "");
    const pg = h("div", "pg", "");
    c.append(head, meta, list, pg);
    root.append(c);
    document.documentElement.append(hostEl);
    requestAnimationFrame(() => c.classList.add("on"));

    const local = NS.analyze(text, { sensitivity: S.sensitivity });
    const res = await send({
      t: "score",
      items: [{ id: 0, text: text.slice(0, 6000) }],
    });
    if (res && res.thresholds) thresholds = res.thresholds;
    const p = res && res.items && res.items[0] ? res.items[0].p : null;
    const v = decide(local, p, local.words);
    verdictEl.textContent =
      v === "slop" ? "slop" : v === "suspect" ? "maybe slop" : "reads human";
    verdictEl.className = "verdict " + v;
    meta.textContent = [
      local.words + " words",
      p != null && local.words >= MINW
        ? pct(p) + " machine (local model)"
        : local.words < MINW
          ? "too short for the model"
          : "",
    ]
      .filter(Boolean)
      .join(" · ");
    for (const t of local.tells.slice(0, 6)) {
      const row = h("div", "row");
      row.append(
        h("span", "", t.label),
        h("span", "c", "×" + t.count),
        h("span", "fix", "“" + t.sample + "”"),
      );
      list.append(row);
    }
    if (S.pangram !== "off" && local.words >= 50) {
      pg.textContent = "pangram …";
      const r = await send({
        t: "pangram",
        text: text.slice(0, 20000),
        why: "selection",
      });
      if (!r || r.skipped)
        pg.textContent = "add a Pangram key in options for a second opinion";
      else if (r.error) pg.textContent = "pangram: " + r.error;
      else {
        pg.textContent = "";
        pg.append(
          "pangram ",
          h("b", "", r.label || "?"),
          " · " + pct(r.ai) + " ai · " + pct(r.assisted) + " assisted",
        );
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.t === "checkSelection") checkSelection(msg.text);
  });

  // ---------------------------------------------------------------- go
  chrome.storage.sync.get(DEFAULTS).then((s) => {
    S = Object.assign({}, DEFAULTS, s);
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });
})();
