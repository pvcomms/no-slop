/*
  no-slop · cook — while you type in a text box, a small chip lists the tells in your own draft.
  Your draft never leaves the page: not to the model worker, not to Pangram.
*/
(() => {
  "use strict";
  const NS = globalThis.NoSlop;
  const P = globalThis.NoSlopPage;
  const { h, shadowHost, tellRow } = P;

  let cook = null;
  function editable(t) {
    if (!t || t.nodeType !== 1) return null;
    if (t.tagName === "TEXTAREA") return t;
    if (t.tagName === "INPUT") return null;
    return t.closest('[contenteditable=""], [contenteditable="true"], [role="textbox"]');
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
      (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle()),
    );
    cook = { hostEl, chip, v, panel, el: null, t: 0, r: null };
    return cook;
  }

  function place() {
    if (!cook || !cook.el || !cook.el.isConnected) return;
    const rc = cook.el.getBoundingClientRect();
    const cw = cook.chip.offsetWidth || 90;
    const x = Math.max(8, Math.min(window.innerWidth - cw - 8, rc.right - cw - 8));
    const y = Math.max(8, Math.min(window.innerHeight - 34, rc.bottom - 30));
    cook.chip.style.left = x + "px";
    cook.chip.style.top = y + "px";
    if (!cook.panel.hidden) {
      const pw = Math.min(340, window.innerWidth * 0.9);
      cook.panel.style.left =
        Math.max(8, Math.min(window.innerWidth - pw - 8, rc.right - pw)) + "px";
      const ph = cook.panel.offsetHeight || 200;
      cook.panel.style.top =
        (y - ph - 8 > 8 ? y - ph - 8 : Math.min(window.innerHeight - ph - 8, y + 30)) + "px";
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
    if (n === 0) c.panel.append(h("div", "why", "Nothing on the list. Read it aloud anyway."));
    for (const t of r.tells) c.panel.append(tellRow(t, `“${t.sample}” → ${t.fix || "rewrite"}`));
    c.chip.classList.add("on");
    place();
  }

  document.addEventListener(
    "focusin",
    (e) => {
      if (!P.S.cook || P.paused) return;
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
      if (!cook || !P.S.cook || P.paused) return;
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
        if (document.activeElement && editable(document.activeElement) === cook.el) return;
        if (cook.panel.hidden) cook.chip.classList.remove("on");
      }, 200);
    },
    true,
  );
  window.addEventListener("scroll", () => cook && requestAnimationFrame(place), {
    passive: true,
    capture: true,
  });
  window.addEventListener("resize", () => cook && requestAnimationFrame(place), { passive: true });
})();
