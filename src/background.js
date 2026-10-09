/*
  no-slop · service worker

  · one click on the toolbar icon pauses / resumes the current site (the "1-click")
  · badge = how many blocks were blurred on this tab, "off" when paused
  · right-click → "Check selection for slop"
  · scores text with the local model (model/weights.bin) for the content script
  · checks image provenance labels (src/provenance.js)
  · talks to Pangram only when the user set a key and a Pangram mode (src/pangram.js)
*/
importScripts("settings.js", "model.js", "pangram.js", "provenance.js");

const { DEFAULTS } = NoSlopSettings;
const CORAL = "#e07a6b";
const GREY = "#66635a";
const IMG_BYTES = 192 * 1024; // labels (XMP, JUMBF, PNG text) sit in the first segments of a file

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.sync.get(null);
  const missing = {};
  for (const k of Object.keys(DEFAULTS)) if (!(k in s)) missing[k] = DEFAULTS[k];
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "noslop-check",
      title: "Check selection for slop",
      contexts: ["selection"],
    });
  });
});

// ---- the model -------------------------------------------------------------------------
let modelP = null;
function model() {
  if (!modelP)
    modelP = (async () => {
      const [meta, buf] = await Promise.all([
        fetch(chrome.runtime.getURL("model/meta.json")).then((r) => r.json()),
        fetch(chrome.runtime.getURL("model/weights.bin")).then((r) => r.arrayBuffer()),
      ]);
      return NoSlopModel.load(buf, meta);
    })().catch((e) => {
      console.warn("no-slop: model unavailable", e);
      modelP = null;
      return null;
    });
  return modelP;
}

// ---- badge + the one click -------------------------------------------------------------
function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : "";
  } catch {
    return "";
  }
}

async function paint(tabId, n, paused) {
  if (tabId == null) return;
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: paused ? GREY : CORAL,
  });
  await chrome.action.setBadgeText({
    tabId,
    text: paused ? "off" : n > 0 ? String(n > 999 ? "999+" : n) : "",
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  const host = hostOf(tab.url || "");
  if (!host) return;
  const s = await NoSlopSettings.load();
  const paused = Object.assign({}, s.paused);
  if (paused[host]) delete paused[host];
  else paused[host] = Date.now();
  await chrome.storage.sync.set({ paused });
  const now = !!paused[host];
  await chrome.action.setTitle({
    tabId: tab.id,
    title: now
      ? `no slop — paused on ${host}. Click to resume.`
      : `no slop — on for ${host}. Click to pause.`,
  });
  if (now) await paint(tab.id, 0, true);
});

// ---- right click -----------------------------------------------------------------------
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "noslop-check" && tab && tab.id != null)
    chrome.tabs
      .sendMessage(tab.id, {
        t: "checkSelection",
        text: info.selectionText || "",
      })
      .catch(() => {});
});

// ---- images ----------------------------------------------------------------------------
const imgCache = new Map();
let imgActive = 0;
const imgQueue = [];
function imgSlot() {
  if (imgActive < 3) {
    imgActive++;
    return Promise.resolve();
  }
  return new Promise((r) => imgQueue.push(r));
}
function imgDone() {
  const next = imgQueue.shift();
  if (next) next();
  else imgActive--;
}
async function checkImage(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  await imgSlot();
  let out = { ai: false, kind: "unreadable", source: "" };
  try {
    const r = await fetch(url, {
      headers: { Range: `bytes=0-${IMG_BYTES - 1}` },
      credentials: "include",
    });
    if (r.ok || r.status === 206) {
      const buf = new Uint8Array(await r.arrayBuffer());
      out = NoSlopProvenance.scan(buf.subarray(0, IMG_BYTES));
    }
  } catch (e) {
    out.kind = "fetch failed";
  } finally {
    imgDone();
  }
  if (imgCache.size > 800) imgCache.delete(imgCache.keys().next().value);
  imgCache.set(url, out);
  return out;
}

// ---- messages from pages -----------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab && sender.tab.id;
  (async () => {
    switch (msg && msg.t) {
      case "count":
        await paint(tabId, msg.n, msg.paused);
        return { ok: true };
      case "score": {
        const m = await model();
        if (!m)
          return {
            items: msg.items.map((it) => ({ id: it.id, p: null })),
            thresholds: null,
          };
        return {
          items: msg.items.map((it) => ({
            id: it.id,
            p: NoSlopModel.probability(m, it.text),
          })),
          thresholds: m.meta.thresholds,
        };
      }
      case "img":
        return checkImage(msg.url);
      case "pangram": {
        const s = await NoSlopSettings.load();
        const { pangramKey } = await chrome.storage.local.get({
          pangramKey: "",
        });
        if (!pangramKey || s.pangram === "off") return { skipped: true };
        if (msg.why === "confirm" && s.pangram !== "confirm") return { skipped: true };
        try {
          return await NoSlopPangram.predict(msg.text, pangramKey);
        } catch (e) {
          return { error: String(e.message || e) };
        }
      }
      case "openOptions":
        chrome.runtime.openOptionsPage();
        return { ok: true };
    }
    return { ok: false };
  })().then(reply, (e) => reply({ error: String(e) }));
  return true;
});
