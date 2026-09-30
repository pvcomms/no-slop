#!/usr/bin/env python3
"""Generate web-style AI text with local Ollama models, for training and testing the detector.

Plain prompts, no style instructions: the point is each model's default voice, which is
what shows up on the web. Output: test/fixtures/.cache/ollama-<model>.jsonl
  usage: gen-ollama.py <model> <n> [seed]
Local only (localhost:11434). Resumable: appends, skips nothing, just stops at n lines.
"""
import json, random, sys, time, urllib.request
from pathlib import Path

MODEL, N = sys.argv[1], int(sys.argv[2])
SEED = int(sys.argv[3]) if len(sys.argv) > 3 else 7
rng = random.Random(SEED + hash(MODEL) % 1000)
out = Path(__file__).resolve().parent.parent / "test/fixtures/.cache" / f"ollama-{MODEL.replace(':', '_').replace('/', '_')}.jsonl"
have = sum(1 for _ in open(out)) if out.exists() else 0

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prompts import GENRES, LENGTHS, TOPICS  # noqa: E402


def ask(prompt):
    body = {"model": MODEL, "prompt": prompt, "stream": False, "think": False,
            "options": {"temperature": round(rng.uniform(0.6, 1.0), 2), "num_predict": 400}}
    if MODEL.startswith("gpt-oss"):
        body["think"] = "low"
    req = urllib.request.Request("http://localhost:11434/api/generate", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())["response"].strip()


with open(out, "a") as f:
    for i in range(have, N):
        g, t, l = rng.choice(GENRES), rng.choice(TOPICS), rng.choice(LENGTHS)
        # draw per index so a resumed run continues the same sequence shape
        prompt = f"Write a {g} about {t}.{l}"
        t0 = time.time()
        try:
            text = ask(prompt)
        except Exception as e:  # keep going; a dropped sample is fine
            print("error", e, file=sys.stderr)
            continue
        f.write(json.dumps({"model": MODEL, "genre": g, "topic": t, "text": text}) + "\n")
        f.flush()
        print(f"{i + 1}/{N} {MODEL} {g} · {time.time() - t0:.1f}s", flush=True)
