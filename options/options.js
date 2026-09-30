// no-slop · options — every change saves on the spot.
const DEFAULTS = {
  eat: true,
  sensitivity: "balanced",
  action: "blur",
  images: true,
  cook: true,
  pangram: "off",
  paused: {},
};
const FP = { gentle: 0.3, balanced: 1, strict: 3 }; // the trainer's false-positive budgets, % of human comments

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let savedTimer = 0;
function saved(msg) {
  const el = $("#saved");
  el.textContent = msg || "saved";
  el.classList.add("on");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove("on"), 1200);
}

async function render() {
  const s = Object.assign(
    {},
    DEFAULTS,
    await chrome.storage.sync.get(DEFAULTS),
  );
  for (const el of $$("input[data-k]")) el.checked = !!s[el.dataset.k];
  for (const name of ["sensitivity", "action", "pangram"])
    for (const el of $$(`input[name="${name}"]`))
      el.checked = el.value === s[name];
  const { pangramKey } = await chrome.storage.local.get({ pangramKey: "" });
  $("#key").value = pangramKey;

  const ul = $("#paused");
  ul.textContent = "";
  const hosts = Object.keys(s.paused || {}).sort();
  if (!hosts.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "none";
    ul.append(li);
  }
  for (const host of hosts) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = "resume";
    b.addEventListener("click", async () => {
      const cur = (await chrome.storage.sync.get({ paused: {} })).paused;
      delete cur[host];
      await chrome.storage.sync.set({ paused: cur });
      saved("resumed " + host);
      render();
    });
    li.append(host, b);
    ul.append(li);
  }
}

for (const el of $$("input[data-k]"))
  el.addEventListener("change", async () => {
    await chrome.storage.sync.set({ [el.dataset.k]: el.checked });
    saved();
  });
for (const el of $$('input[type="radio"]'))
  el.addEventListener("change", async () => {
    if (el.checked) await chrome.storage.sync.set({ [el.name]: el.value });
    saved();
  });
let keyTimer = 0;
$("#key").addEventListener("input", (e) => {
  clearTimeout(keyTimer);
  keyTimer = setTimeout(async () => {
    await chrome.storage.local.set({ pangramKey: e.target.value.trim() });
    saved(e.target.value.trim() ? "key saved" : "key removed");
  }, 400);
});

for (const el of $$(".fp"))
  el.textContent = `· flags ~${FP[el.dataset.fp]}% of human writing`;

fetch(chrome.runtime.getURL("model/meta.json"))
  .then((r) => r.json())
  .then((m) => {
    const d = m.data || {};
    $("#model").textContent =
      `local model · trained ${m.trained} on ${(d.human || 0).toLocaleString()} human and ` +
      `${(d.machine || 0).toLocaleString()} machine-written texts · ${((1 << m.bits) / 1024) | 0} KB`;
  })
  .catch(
    () =>
      ($("#model").textContent = "local model not built — run bin/train.py"),
  );

render();
