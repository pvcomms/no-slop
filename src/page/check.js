/*
  no-slop · check — right-click → "Check selection for slop" shows a result card:
  the verdict, the model's number, the top tells, and Pangram's opinion when there is a key.
*/
(() => {
  "use strict";
  const NS = globalThis.NoSlop;
  const P = globalThis.NoSlopPage;
  const { h, pct, send, shadowHost, tellRow, decide, MINW } = P;

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

    const local = NS.analyze(text, { sensitivity: P.S.sensitivity });
    const res = await send({
      t: "score",
      items: [{ id: 0, text: text.slice(0, P.MODEL_CHARS) }],
    });
    if (res && res.thresholds) P.thresholds = res.thresholds;
    const p = res && res.items && res.items[0] ? res.items[0].p : null;
    const v = decide(local, p, local.words);
    verdictEl.textContent = v === "slop" ? "slop" : v === "suspect" ? "maybe slop" : "reads human";
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
    for (const t of local.tells.slice(0, 6)) list.append(tellRow(t, `“${t.sample}”`));
    if (P.S.pangram !== "off" && local.words >= 50) {
      pg.textContent = "pangram …";
      const r = await send({
        t: "pangram",
        text: text.slice(0, P.PANGRAM_CHARS),
        why: "selection",
      });
      if (!r || r.skipped) pg.textContent = "add a Pangram key in options for a second opinion";
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
})();
