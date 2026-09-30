#!/usr/bin/env python3
"""Train the no-slop classifier and export it for the extension.

  python3 bin/train.py            → model/weights.bin + model/meta.json, and a report

Featurization mirrors src/model.js exactly (tokens → hashed unigrams + bigrams, presence,
L2-normalised, 2^18 buckets). Dev-time deps: numpy, scipy, scikit-learn. The extension
ships only the int8 weights; nothing here runs in the browser.

Train  : HC3 (human + ChatGPT answers, 90% of questions) · Hacker News comments 2018 + 2020
         · local qwen2.5 / qwen3.6 generations (80%)
Test   : HC3 held-out questions · HN 2019 · Gutenberg · qwen held-out 20%
         · gpt-oss (a model family never trained on) · hand-written samples (never trained on)
"""
import json, math, random, re, sys, time, urllib.request
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parent.parent
FX = ROOT / "test/fixtures"
CACHE = FX / ".cache"
OUT = ROOT / "model"
BITS, MASK = 18, (1 << 18) - 1
rng = random.Random(13)

# ---- featurize: keep identical to src/model.js --------------------------------------
TOK = re.compile(r"[a-z0-9]+(?:'[a-z]+)?|[—–!?;:,.()\"…¶]|[\U0001F300-\U0001FAFF\u2600-\u27BF]")
EMO = re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]")
_memo = {}


def prep(t):
    t = re.sub(r"[‘’ʼ]", "'", t)
    t = re.sub(r"[“”]", '"', t)
    t = t.replace("\u00a0", " ").lower()
    t = re.sub(r"[0-9]+", "0", t)
    return re.sub(r"\s*\n+\s*", " ¶ ", t)


def tokens(t):
    return ["EMO" if EMO.fullmatch(x) else x for x in TOK.findall(prep(t))[:600]]


def fnv(s):
    h = _memo.get(s)
    if h is None:
        h = 0x811C9DC5
        for c in s.encode("utf-8"):
            h = ((h ^ c) * 0x01000193) & 0xFFFFFFFF
        _memo[s] = h
    return h


def featurize(t):
    tk = tokens(t)
    f = set()
    for i, x in enumerate(tk):
        f.add(fnv("u" + x) & MASK)
        if i + 1 < len(tk):
            f.add(fnv("b" + x + " " + tk[i + 1]) & MASK)
    return f


def matrix(texts):
    rows, cols, vals = [], [], []
    for r, t in enumerate(texts):
        f = featurize(t)
        if not f:
            continue
        v = 1 / math.sqrt(len(f))
        rows += [r] * len(f)
        cols += list(f)
        vals += [v] * len(f)
    return csr_matrix((vals, (rows, cols)), shape=(len(texts), 1 << BITS), dtype=np.float32)


# ---- data ------------------------------------------------------------------------------
def words(t):
    return len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'-]*", t))


def detok(s):
    """HC3's human answers are pre-tokenized ("Should n't", "you 're", " ."). Undo it so the
    model can't learn spacing instead of style."""
    s = re.sub(r" (n't|'s|'re|'ve|'ll|'d|'m)\b", r"\1", s, flags=re.I)
    s = re.sub(r" ([.,!?;:%)\]}])", r"\1", s)
    s = re.sub(r"([(\[{$]) ", r"\1", s)
    s = re.sub(r"(\w) - (\w)", r"\1-\2", s)
    s = re.sub(r'" ([^"]{1,200}?) "', r'"\1"', s)
    s = re.sub(r"\s+'\s*(\w)", r"'\1", s) if " ' " in s else s
    return s.strip()


def hc3():
    human, ai = [], []
    for line in open(CACHE / "hc3-all.jsonl"):
        d = json.loads(line)
        q = d.get("question", "")
        for a in d.get("human_answers") or []:
            if a and words(a) >= 25:
                human.append((q, detok(a), d.get("source", "")))
        for a in d.get("chatgpt_answers") or []:
            if a and words(a) >= 25:
                ai.append((q, a.strip(), d.get("source", "")))
    return human, ai


def unhtml(s):
    s = re.sub(r"<p>", "\n\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    for a, b in (("&#x27;", "'"), ("&quot;", '"'), ("&#x2F;", "/"), ("&gt;", ">"), ("&lt;", "<"), ("&amp;", "&")):
        s = s.replace(a, b)
    return s.strip()


def hn_year(year, days=14):
    path = CACHE / f"hn-{year}.json"
    if path.exists():
        return json.loads(path.read_text())
    out, start = [], int(time.mktime((year, 1, 1, 0, 0, 0, 0, 0, 0)))
    for k in range(days):
        a = start + k * 26 * 86400
        url = ("https://hn.algolia.com/api/v1/search_by_date?tags=comment&hitsPerPage=400"
               f"&numericFilters=created_at_i>{a},created_at_i<{a + 86400}")
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                hits = json.loads(r.read()).get("hits", [])
        except Exception as e:
            print("hn fetch failed", year, k, e, file=sys.stderr)
            continue
        for h in hits:
            t = unhtml(h.get("comment_text") or "")
            if 40 <= words(t) <= 600:
                out.append(t)
    path.write_text(json.dumps(out))
    return out


def jsonl(p):
    return [json.loads(l) for l in open(p)] if p.exists() else []


def main():
    t0 = time.time()
    h_hc3, a_hc3 = hc3()
    qs = sorted({q for q, _, _ in h_hc3 + a_hc3})
    rng.shuffle(qs)
    test_q = set(qs[: len(qs) // 10])
    hc3_h_train = [t for q, t, _ in h_hc3 if q not in test_q]
    hc3_a_train = [t for q, t, _ in a_hc3 if q not in test_q]
    hc3_h_test = [t for q, t, _ in h_hc3 if q in test_q]
    hc3_a_test = [t for q, t, _ in a_hc3 if q in test_q]
    rng.shuffle(hc3_h_train)
    rng.shuffle(hc3_a_train)
    hc3_h_train, hc3_a_train = hc3_h_train[:15000], hc3_a_train[:12000]

    hn_train = hn_year(2018) + hn_year(2020)
    hn_test = [d["text"] for d in json.loads((CACHE / "human-hn.json").read_text())]
    pd_test = [d["text"] for d in json.loads((FX / "human-pd.json").read_text())]

    # RAID: split by prompt so a prompt's human and model versions never straddle train/test;
    # cohere-chat is held out entirely as a model family the classifier never sees
    raid = jsonl(CACHE / "raid.jsonl")
    groups = sorted({r["group"] for r in raid})
    rng.shuffle(groups)
    raid_test_g = set(groups[: len(groups) // 10])
    raid_h_train = [r["text"] for r in raid if r["model"] == "human" and r["group"] not in raid_test_g]
    raid_h_test = [r["text"] for r in raid if r["model"] == "human" and r["group"] in raid_test_g]
    raid_a_train = [r["text"] for r in raid if r["model"] not in ("human", "cohere-chat") and r["group"] not in raid_test_g]
    raid_a_test = [r["text"] for r in raid if r["model"] not in ("human", "cohere-chat") and r["group"] in raid_test_g]
    cohere_test = [r["text"] for r in raid if r["model"] == "cohere-chat"]

    web = [d["text"] for d in jsonl(CACHE / "web-human.jsonl")]
    rng.shuffle(web)
    wcut = int(len(web) * 0.85)
    web_train, web_test = web[:wcut], web[wcut:]

    qwen = [d["text"] for d in jsonl(CACHE / "ollama-qwen2.5_7b.jsonl") if words(d["text"]) >= 25]
    rng.shuffle(qwen)
    cut = int(len(qwen) * 0.8)
    qwen_train, qwen_test = qwen[:cut], qwen[cut:]
    qwen36_test = [d["text"] for d in jsonl(CACHE / "ollama-qwen3.6_35b-a3b.jsonl") if words(d["text"]) >= 25]
    gptoss_test = [d["text"] for d in jsonl(CACHE / "ollama-gpt-oss_120b.jsonl") if words(d["text"]) >= 25]
    hand_test = [d["text"] for p in ("ai.json", "ai-heldout.json") for d in json.loads((FX / p).read_text())]

    final = "--final" in sys.argv
    claude_train = [d["text"] for d in json.loads((FX / "claude-train.json").read_text())]
    if final:
        # the model that ships: every family in training, 20% of each new one still held back
        def split(xs):
            xs = xs[:]
            rng.shuffle(xs)
            k = int(len(xs) * 0.8)
            return xs[:k], xs[k:]

        cohere_train, cohere_test = split(cohere_test)
        gptoss_train, gptoss_test = split(gptoss_test)
        qwen36_train, qwen36_test = split(qwen36_test)
    else:
        cohere_train = gptoss_train = qwen36_train = []
        claude_train = []

    parts = [  # (texts, label, weight)
        (hc3_h_train, 0, 1.0), (hn_train, 0, 2.0), (raid_h_train, 0, 2.0), (web_train, 0, 2.0),
        (hc3_a_train, 1, 1.0), (raid_a_train, 1, 1.5), (qwen_train, 1, 12.0),
        (cohere_train, 1, 1.5), (gptoss_train, 1, 12.0), (qwen36_train, 1, 12.0), (claude_train, 1, 12.0),
    ]
    print("data:", " · ".join(f"{n} {len(t)}" for n, (t, _, _) in zip(
        ["hc3-h", "hn", "raid-h", "web-h", "hc3-ai", "raid-ai", "qwen", "cohere", "gpt-oss", "qwen3.6", "claude"], parts)))
    texts = [t for ts, _, _ in parts for t in ts]
    y = np.array([lab for ts, lab, _ in parts for _ in ts])
    sw = np.array([w for ts, _, w in parts for _ in ts])
    X = matrix(texts)
    print(f"featurized {len(texts)} docs in {time.time() - t0:.0f}s")

    clf = LogisticRegression(C=4.0, max_iter=2000, solver="liblinear", class_weight="balanced")
    clf.fit(X, y, sample_weight=sw)
    w = clf.coef_[0].astype(np.float64)
    bias = float(clf.intercept_[0])
    scale = float(np.abs(w).max() / 127)
    q = np.clip(np.round(w / scale), -127, 127).astype(np.int8)

    def prob(texts):
        M = matrix(texts)
        z = bias + (M @ q.astype(np.float64)) * scale
        return 1 / (1 + np.exp(-z))

    sets = {
        "human · hc3 held-out": (hc3_h_test, 0),
        "human · hn 2019": (hn_test, 0),
        "human · raid held-out": (raid_h_test, 0),
        "human · reviews+email held-out": (web_test, 0),
        "human · gutenberg": (pd_test, 0),
        "ai · hc3 held-out": (hc3_a_test, 1),
        "ai · raid held-out": (raid_a_test, 1),
        "ai · qwen2.5 held-out": (qwen_test, 1),
        ("ai · cohere-chat held-out" if final else "ai · cohere-chat (unseen)"): (cohere_test, 1),
        ("ai · qwen3.6 held-out" if final else "ai · qwen3.6 (unseen)"): (qwen36_test, 1),
        ("ai · gpt-oss held-out" if final else "ai · gpt-oss (unseen)"): (gptoss_test, 1),
        ("ai · claude hand-written (same author)" if final else "ai · hand-written (unseen)"): (hand_test, 1),
    }
    P = {k: prob(v[0]) if v[0] else np.array([]) for k, v in sets.items()}

    # thresholds: false-positive budget on all held-out human text except Gutenberg (old prose)
    web_h = np.concatenate([P[k] for k in ("human · hn 2019", "human · hc3 held-out", "human · raid held-out", "human · reviews+email held-out")])
    th = {}
    for name, fp in (("gentle", 0.003), ("balanced", 0.01), ("strict", 0.03)):
        th[name] = float(np.quantile(web_h, 1 - fp))
    print("\nthresholds (P ≥ t is flagged):", {k: round(v, 3) for k, v in th.items()})
    for k, (v, lab) in sets.items():
        p = P[k]
        if not len(p):
            continue
        rates = "  ".join(f"{n} {100 * np.mean(p >= t):5.1f}%" for n, t in th.items())
        print(f"  {k:30s} n={len(p):5d}  flagged → {rates}")
    allp = np.concatenate([P[k] for k in sets if len(P[k])])
    ally = np.concatenate([[sets[k][1]] * len(P[k]) for k in sets if len(P[k])])
    print(f"\n  auc (all test sets) {roc_auc_score(ally, allp):.3f}")

    # held-out sets, for bin/eval.mjs to score with the extension's own decision logic
    with open(CACHE / "heldout.jsonl", "w") as fh:
        for k, (v, lab) in sets.items():
            for t in v:
                fh.write(json.dumps({"set": k, "label": lab, "text": t}) + "\n")

    OUT.mkdir(exist_ok=True)
    (OUT / "weights.bin").write_bytes(q.tobytes())
    probe = "It's not just a tool — it's a game-changer. Let's dive in!\nHere's why."
    meta = {
        "version": 1,
        "bits": BITS,
        "scale": scale,
        "bias": bias,
        "thresholds": th,
        "trained": time.strftime("%Y-%m-%d"),
        "data": {"human": int(sum(len(t) for t, lab, _ in parts if lab == 0)), "machine": int(sum(len(t) for t, lab, _ in parts if lab == 1))},
        "probe": {"text": probe, "features": sorted(featurize(probe)), "p": float(prob([probe])[0])},
    }
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"\nwrote model/weights.bin ({q.nbytes // 1024} KB) + meta.json in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
