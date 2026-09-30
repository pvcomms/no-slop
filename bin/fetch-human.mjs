#!/usr/bin/env node
// Fetch human-written text for calibrating the detector. Two sources, both pre-ChatGPT:
//   · Project Gutenberg paragraphs (public domain)  → test/fixtures/human-pd.json   (committed)
//   · Hacker News comments from 2019 (Algolia API)  → test/fixtures/.cache/human-hn.json (gitignored:
//     third-party text, kept local, only for measuring false positives)
// Network: gutenberg.pglaf.org (Gutenberg mirror), hn.algolia.com. Run once; the eval reads the files.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, "..", "test", "fixtures");
const words = (t) => (t.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || []).length;

const BOOKS = [
  [205, "Walden"],
  [76, "Huckleberry Finn"],
  [1342, "Pride and Prejudice"],
  [2701, "Moby Dick"],
  [16643, "Emerson, Essays"],
  [4300, "Ulysses"],
];

async function gutenberg() {
  const out = [];
  for (const [id, title] of BOOKS) {
    const r = await fetch(
      `https://gutenberg.pglaf.org/cache/epub/${id}/pg${id}.txt`,
    );
    if (!r.ok) {
      console.error("skip", title, r.status);
      continue;
    }
    let t = await r.text();
    const a = t.indexOf("*** START OF");
    const b = t.indexOf("*** END OF");
    if (a > 0 && b > a) t = t.slice(t.indexOf("\n", a), b);
    const paras = t
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .filter(
        (p) =>
          words(p) >= 60 &&
          words(p) <= 400 &&
          !/[_*]{2}|CHAPTER|Gutenberg/.test(p),
      );
    const step = Math.max(1, Math.floor(paras.length / 25));
    for (
      let i = 0;
      i < paras.length && out.filter((o) => o.source === title).length < 25;
      i += step
    )
      out.push({ source: title, text: paras[i] });
  }
  return out;
}

function unhtml(s) {
  return s
    .replace(/<p>/g, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, "/")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .trim();
}

async function hn() {
  const out = [];
  const start = Date.UTC(2019, 0, 1) / 1000;
  for (let k = 0; k < 12; k++) {
    const a = start + k * 30 * 86400;
    const b = a + 86400;
    const url = `https://hn.algolia.com/api/v1/search_by_date?tags=comment&hitsPerPage=200&numericFilters=created_at_i>${a},created_at_i<${b}`;
    const r = await fetch(url);
    if (!r.ok) continue;
    const j = await r.json();
    for (const h of j.hits || []) {
      const text = unhtml(h.comment_text || "");
      if (words(text) >= 50 && words(text) <= 600)
        out.push({ source: "hn-2019", text });
    }
  }
  return out;
}

await mkdir(join(fx, ".cache"), { recursive: true });
const pd = await gutenberg();
await writeFile(join(fx, "human-pd.json"), JSON.stringify(pd, null, 1));
console.log("public domain paragraphs:", pd.length);
const h = await hn();
await writeFile(join(fx, ".cache", "human-hn.json"), JSON.stringify(h));
console.log("hn comments (2019):", h.length);
