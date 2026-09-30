#!/usr/bin/env node
// End to end: load the unpacked extension into Chrome for Testing (Playwright's copy), open
// test/pages/mixed.html, and check the loop over the DevTools protocol:
//   human paragraphs untouched · slop blurred (incl. content added after load) · labelled image
//   blurred, plain one not · cook chip on the textarea · badge count · pause clears, resume restores
//   · options page renders. Screenshots → --out <dir> (default: ./.e2e).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : join(root, ".e2e");
await mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), "Library/Caches/ms-playwright");
  const dirs = (await readdir(base))
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .reverse();
  for (const d of dirs) {
    const p = join(
      base,
      d,
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
    if (existsSync(p)) return p;
  }
  throw new Error("no Chrome for Testing found; set CHROME=/path/to/binary");
}

// ---- static server for the test page ------------------------------------------------------
const types = { ".html": "text/html", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const p = join(
      root,
      "test/pages",
      decodeURIComponent(new URL(req.url, "http://x").pathname),
    );
    const body = await readFile(p);
    res.writeHead(200, {
      "content-type": types[extname(p)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/mixed.html`;

// ---- chrome ---------------------------------------------------------------------------------
const profile = await mkdtemp(join(tmpdir(), "noslop-e2e-"));
const chrome = spawn(
  await findChrome(),
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,1000",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let port;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100);
  try {
    port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
      "\n",
    )[0];
  } catch {}
}
const http = (path, init) =>
  fetch(`http://127.0.0.1:${port}${path}`, init).then((r) => r.json());

class CDP {
  static async open(url) {
    const c = new CDP();
    c.ws = new WebSocket(url);
    c.id = 0;
    c.wait = new Map();
    c.events = [];
    c.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.wait.has(m.id)) {
        const { res, rej } = c.wait.get(m.id);
        c.wait.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) c.events.push(m);
    };
    await new Promise((r, j) => ((c.ws.onopen = r), (c.ws.onerror = j)));
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.wait.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.exception?.description || r.exceptionDetails.text,
      );
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? "  — " + detail : ""}`);
};

try {
  // service worker up?
  let sw;
  for (let i = 0; i < 60 && !sw; i++) {
    sw = (await http("/json/list")).find(
      (t) =>
        t.type === "service_worker" && t.url.endsWith("/src/background.js"),
    );
    if (!sw) await sleep(200);
  }
  check("service worker registered", !!sw, sw ? sw.url.split("/")[2] : "");
  const extId = sw.url.split("/")[2];
  const swc = await CDP.open(sw.webSocketDebuggerUrl);
  await swc.send("Runtime.enable");

  // page
  const tab = await http(`/json/new?${encodeURIComponent(pageUrl)}`, {
    method: "PUT",
  });
  const pg = await CDP.open(tab.webSocketDebuggerUrl);
  await pg.send("Runtime.enable");
  await pg.send("Page.enable");
  await pg.send("DOM.enable");
  await sleep(6000);

  const state = () =>
    pg.eval(`(() => {
      const o = {};
      for (const e of document.querySelectorAll("[id]")) o[e.id] = e.getAttribute("data-noslop");
      const post = document.querySelectorAll("#a3 p");
      o.a3 = post[0] && post[0].getAttribute("data-noslop");
      o.a4 = document.getElementById("a4") && document.getElementById("a4").getAttribute("data-noslop");
      o.count = document.querySelectorAll('[data-noslop="blocked"]').length;
      return o;
    })()`);

  // shadow-dom text of every note, keyed by the id of the element it sits in / before
  async function notes() {
    const { root: doc } = await pg.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const out = [];
    const text = (n) =>
      n.nodeType === 3
        ? n.nodeValue
        : n.nodeName === "STYLE"
          ? ""
          : (n.children || []).map(text).join(" ") +
            (n.shadowRoots || []).map(text).join(" ");
    (function walk(n, parentId) {
      const attrs = n.attributes || [];
      const idIx = attrs.indexOf("id");
      const id = idIx >= 0 ? attrs[idIx + 1] : parentId;
      if (attrs.includes("data-noslop-ui"))
        out.push({
          at: parentId,
          text: (n.shadowRoots || [])
            .map(text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
          nodeId: n.nodeId,
          n,
        });
      for (const c of n.children || []) walk(c, id);
      for (const c of n.shadowRoots || []) walk(c, id);
    })(doc, "");
    return out;
  }

  // images are checked as they scroll into view: bring them in, then read the page
  await pg.eval(`document.getElementById("img-ai").scrollIntoView({block: "center"}); true`);
  await sleep(2500);
  await pg.eval(`window.scrollTo(0, 0); true`);
  const s = await state();
  check("human prose (Walden) left alone", s.h1 === null, String(s.h1));
  check("human forum reply left alone", s.h2 === null, String(s.h2));
  check("blog-intro slop blurred", s.a1 === "blocked", String(s.a1));
  check(
    "one-line-per-paragraph post blurred as one block",
    s.a3 === "blocked",
    String(s.a3),
  );
  check("slop added after load is caught", s.a4 === "blocked", String(s.a4));
  check(
    "image labelled trainedAlgorithmicMedia blurred",
    s["img-ai"] === "blocked",
    String(s["img-ai"]),
  );
  check(
    "unlabelled image left alone",
    s["img-plain"] === null,
    String(s["img-plain"]),
  );
  console.log(
    `  (info) plain assistant answer with no pattern tells: ${s.a2 || "not flagged"}`,
  );

  const ns = await notes();
  const a1note = ns.find((n) => n.at === "a1");
  check(
    "note says why, with the model's probability",
    !!a1note && /slop/.test(a1note.text) && /\d+% machine/.test(a1note.text),
    a1note ? a1note.text : "no note",
  );

  const errs = pg.events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map(
      (e) =>
        e.params.exceptionDetails.exception?.description ||
        e.params.exceptionDetails.text,
    );
  check("no exceptions on the page", errs.length === 0, errs.join(" | "));

  const shot = async (name, full = false) => {
    const opts = { format: "png" };
    if (full) {
      const m = await pg.send("Page.getLayoutMetrics");
      opts.clip = {
        x: 0,
        y: 0,
        width: m.cssContentSize.width,
        height: Math.min(m.cssContentSize.height, 4000),
        scale: 1,
      };
      opts.captureBeyondViewport = true;
    }
    const { data } = await pg.send("Page.captureScreenshot", opts);
    await writeFile(join(outDir, name), Buffer.from(data, "base64"));
  };
  await shot("page.png", true);

  // badge
  const badge = () =>
    swc.eval(
      `(async () => { const [t] = await chrome.tabs.query({ url: "http://127.0.0.1/*" }); return t ? chrome.action.getBadgeText({ tabId: t.id }) : "no tab"; })()`,
    );
  const b1 = await badge();
  check("badge shows the number blurred", /^\d+$/.test(b1) && +b1 >= 4, b1);

  // cook
  await pg.eval(
    `document.getElementById("draft").scrollIntoView({block: "center"}); document.getElementById("draft").focus(); true`,
  );
  await pg.send("Input.insertText", {
    text: "I'm thrilled to announce our new platform! It's not just a tool — it's a game-changer. Here's why: we leverage cutting-edge AI to seamlessly unlock your full potential. Let's dive in!",
  });
  await sleep(900);
  const chip = (await notes()).find((n) => /cook/.test(n.text));
  check(
    "cook chip lists tells in the draft",
    !!chip && /\d+ tells?/.test(chip.text),
    chip ? chip.text.slice(0, 90) : "no chip",
  );
  if (chip) {
    // open the panel: click the chip
    const chipEl = (function find(n) {
      if (
        (n.attributes || []).includes("chip") ||
        (n.attributes || []).some((a) => /\bchip\b/.test(a))
      )
        return n;
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) {
        const f = find(c);
        if (f) return f;
      }
      return null;
    })(chip.n);
    if (chipEl) {
      const { model } = await pg.send("DOM.getBoxModel", {
        nodeId: chipEl.nodeId,
      });
      const [x1, y1, , , x3, y3] = model.content;
      const x = (x1 + x3) / 2,
        y = (y1 + y3) / 2;
      for (const type of ["mousePressed", "mouseReleased"])
        await pg.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      await sleep(400);
    }
    await shot("cook.png");
  }

  // right-click → "Check selection for slop": the worker sends the selection to the tab
  await swc.eval(`(async () => {
    const [t] = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
    await chrome.tabs.sendMessage(t.id, { t: "checkSelection", text: "Great question! In today's fast-paced world, it's important to note that success isn't just about hard work — it's about working smarter. Here's the thing: by leveraging cutting-edge tools, you can seamlessly unlock your full potential and take your career to the next level. I hope this helps!" });
    return true;
  })()`);
  await sleep(1500);
  const cardNote = (await notes()).find((n) => /words/.test(n.text) && /close/.test(n.text));
  check("right-click check shows a verdict card", !!cardNote && /slop/.test(cardNote.text), cardNote ? cardNote.text.slice(0, 100) : "no card");
  await shot("card.png");

  // one click = pause this site (the action handler writes storage.sync.paused[host])
  await swc.eval(
    `chrome.storage.sync.set({ paused: { "127.0.0.1": Date.now() } }).then(() => true)`,
  );
  await sleep(900);
  const p1 = await state();
  check(
    "pausing the site clears every blur",
    p1.count === 0 && p1.a1 === null,
    `blocked=${p1.count}`,
  );
  check("badge reads off while paused", (await badge()) === "off");
  await swc.eval(`chrome.storage.sync.set({ paused: {} }).then(() => true)`);
  await sleep(3500);
  const p2 = await state();
  check("resuming restores the blur", p2.a1 === "blocked", String(p2.a1));

  // options page
  const opt = await http(
    `/json/new?${encodeURIComponent(`chrome-extension://${extId}/options/options.html`)}`,
    { method: "PUT" },
  );
  const oc = await CDP.open(opt.webSocketDebuggerUrl);
  await oc.send("Page.enable");
  await sleep(1200);
  const modelLine = await oc.eval(
    `document.getElementById("model").textContent`,
  );
  check(
    "options page shows the model line",
    /local model · trained/.test(modelLine),
    modelLine,
  );
  const m = await oc.send("Page.getLayoutMetrics");
  const { data } = await oc.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width: m.cssContentSize.width,
      height: m.cssContentSize.height,
      scale: 1,
    },
  });
  await writeFile(join(outDir, "options.png"), Buffer.from(data, "base64"));
  oc.close();

  const swErrs = swc.events.filter(
    (e) => e.method === "Runtime.exceptionThrown",
  );
  check(
    "no exceptions in the service worker",
    swErrs.length === 0,
    swErrs.map((e) => e.params.exceptionDetails.text).join(" | "),
  );
  pg.close();
  swc.close();
} catch (e) {
  check("run completed", false, e.stack || String(e));
} finally {
  chrome.kill();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - failed}/${results.length} passed · screenshots in ${outDir}`,
);
process.exit(failed ? 1 : 0);
