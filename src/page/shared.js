/*
  no-slop · content scripts, loaded in this order (manifest.json):

  shared.js  settings state, the ui kit (shadow dom), the verdict rule
  eat.js     blurs blocks of prose and AI-labelled images; pause / resume; starts everything
  cook.js    while you type, a chip lists the tells in your own draft (never leaves the page)
  check.js   right-click → "Check selection for slop" shows a result card

  Each file is an IIFE; they share state through globalThis.NoSlopPage.
*/
(() => {
  "use strict";
  const UI_ATTR = "data-noslop-ui";

  // the mono face loads the first time anything is drawn, not on every page
  let fontLoaded = false;
  function loadFont() {
    if (fontLoaded) return;
    fontLoaded = true;
    try {
      const font = new FontFace(
        "NoSlop Mono",
        `url(${chrome.runtime.getURL("fonts/plexmono-latin-400.woff2")})`,
      );
      document.fonts.add(font);
      font.load().catch(() => {});
    } catch {}
  }

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

  // one parsed stylesheet shared by every note, chip and card on the page
  let sheet = null;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
  } catch {
    sheet = null;
  }
  function shadowHost(tag) {
    loadFont();
    const hostEl = document.createElement(tag || "span");
    hostEl.setAttribute(UI_ATTR, "");
    const root = hostEl.attachShadow({ mode: "closed" });
    if (sheet) root.adoptedStyleSheets = [sheet];
    else {
      const style = document.createElement("style");
      style.textContent = CSS;
      root.append(style);
    }
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

  // "show" / "hide" for blurred elements
  function revealButton(els) {
    const b = h("button", "", "show");
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hidden = els[0].getAttribute("data-noslop") === "blocked";
      for (const el of els) el.setAttribute("data-noslop", hidden ? "shown" : "blocked");
      b.textContent = hidden ? "hide" : "show";
    });
    return b;
  }

  // one tell in the cook panel or the check card
  function tellRow(t, fix) {
    const row = h("div", "row");
    row.append(h("span", "", t.label), h("span", "c", "×" + t.count), h("span", "fix", fix));
    return row;
  }

  // a block is slop when either the model or the pattern tells say so
  function decide(local, p, words) {
    const t = P.thresholds || {};
    const sens = P.S.sensitivity;
    let model = null;
    if (p != null && t[sens] != null && words >= P.MINW) {
      if (p >= t[sens]) model = "slop";
      else if (t.strict != null && p >= t.strict) model = "suspect";
      else model = "clean";
    }
    if (model === "slop" || local.verdict === "slop") return "slop";
    if (model === "suspect" || local.verdict === "suspect") return "suspect";
    return "clean";
  }

  const P = (globalThis.NoSlopPage = {
    S: Object.assign({}, globalThis.NoSlopSettings.DEFAULTS),
    paused: false,
    thresholds: null, // from the model's meta, via the worker
    MINW: 40, // below this the model abstains; pattern tells only
    MODEL_CHARS: 6000, // text sent to the local model
    PANGRAM_CHARS: 20000, // text sent to Pangram (only with a key)
    UI_ATTR,
    shadowHost,
    h,
    pct,
    send,
    revealButton,
    tellRow,
    decide,
  });
})();
