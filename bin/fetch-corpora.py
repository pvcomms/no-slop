#!/usr/bin/env python3
"""Build the training corpora beyond HC3. Writes JSONL into test/fixtures/.cache/ (gitignored).

  raid.jsonl        RAID benchmark (Dugan et al., 2024), unattacked rows: human vs six chat
                    models (chatgpt, gpt4, cohere-chat, llama-chat, mistral-chat, mpt-chat) on the
                    same prompts, in abstracts / books / news. Read from the parquet shards of
                    huggingface.co/datasets/liamdugan/raid (download them to .cache/raid-*.parquet).
  web-human.jsonl   pre-2022 human web writing in the genres the qwen generations cover:
                    Yelp reviews, Amazon reviews, Enron email (AESLC), via the HF datasets-server API.

Needs pyarrow for RAID (dev only: python3 -m venv --system-site-packages .venv && .venv/bin/pip install pyarrow).
"""
import glob, json, random, re, sys, urllib.request
from pathlib import Path

CACHE = Path(__file__).resolve().parent.parent / "test/fixtures/.cache"
rng = random.Random(21)
CHAT = {"chatgpt", "gpt4", "cohere-chat", "llama-chat", "mistral-chat", "mpt-chat"}
PER_CELL = 500  # rows per (domain, chat model)


def words(t):
    return len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'-]*", t))


def raid():
    import pyarrow.compute as pc
    import pyarrow.parquet as pq

    shards = sorted(glob.glob(str(CACHE / "raid-*.parquet")))
    if not shards:
        print("no raid shards in .cache — skipping", file=sys.stderr)
        return
    cells, human = {}, []
    for f in shards:
        t = pq.read_table(f, columns=["source_id", "model", "domain", "attack", "generation"])
        t = t.filter(pc.equal(t["attack"], "none"))
        d = t.to_pydict()
        for sid, m, dom, g in zip(d["source_id"], d["model"], d["domain"], d["generation"]):
            if dom == "poetry" or not g or words(g) < 40:
                continue
            row = {"src": "raid", "domain": dom, "model": m, "group": sid or "", "text": g.strip()}
            if m == "human":
                human.append(row)
            elif m in CHAT:
                cells.setdefault((dom, m), []).append(row)
    out = human[:]
    for rows in cells.values():
        rng.shuffle(rows)
        out += rows[:PER_CELL]
    with open(CACHE / "raid.jsonl", "w") as fh:
        for r in out:
            fh.write(json.dumps(r) + "\n")
    print(f"raid: {len(human)} human, {len(out) - len(human)} chat-model rows")


def rows(dataset, config, split, col, total, n, label):
    out, seen = [], set()
    while len(out) < n and len(seen) < n // 50 + 40:
        off = rng.randrange(0, total - 100)
        if off in seen:
            continue
        seen.add(off)
        url = f"https://datasets-server.huggingface.co/rows?dataset={dataset}&config={config}&split={split}&offset={off}&length=100"
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = json.loads(r.read())
        except Exception as e:
            print("fetch failed", dataset, e, file=sys.stderr)
            continue
        for row in data.get("rows", []):
            t = str(row["row"].get(col) or "").replace("\\n", "\n").replace('\\"', '"').strip()
            if 40 <= words(t) <= 500:
                out.append({"src": label, "text": t})
    return out[:n]


def web():
    out = []
    out += rows("Yelp/yelp_review_full", "yelp_review_full", "train", "text", 650000, 2500, "yelp")
    out += rows("fancyzhx/amazon_polarity", "amazon_polarity", "train", "content", 3600000, 2000, "amazon")
    out += rows("Yale-LILY/aeslc", "default", "train", "email_body", 14436, 1200, "enron")
    with open(CACHE / "web-human.jsonl", "w") as fh:
        for r in out:
            fh.write(json.dumps(r) + "\n")
    from collections import Counter

    print("web human:", dict(Counter(r["src"] for r in out)))


if __name__ == "__main__":
    raid()
    web()
