#!/usr/bin/env python3
"""Generate web-style text with Claude (Opus 5.5), for training/testing the detector on the Claude family.

  set -a; source ~/.config/inbox-triage.env; set +a
  .venv/bin/python bin/gen-claude.py 150      → test/fixtures/.cache/claude-opus-5-5.jsonl

Same genre × topic prompts as the local generators (bin/prompts.py). Effort low: these are
short posts, and the point is the model's default voice, not its best work. Server-side refusal
fallbacks are on (fallbacks="default"); a refused prompt is skipped. Resumable: appends.
"""
import json, random, sys, threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prompts import GENRES, LENGTHS, TOPICS  # noqa: E402

MODEL = "claude-opus-5-5"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 150
OUT = Path(__file__).resolve().parent.parent / "test/fixtures/.cache" / f"{MODEL}.jsonl"
have = sum(1 for _ in open(OUT)) if OUT.exists() else 0
rng = random.Random(99 + have)
client = anthropic.Anthropic()
lock = threading.Lock()


def one(i):
    g, t, l = rng.choice(GENRES), rng.choice(TOPICS), rng.choice(LENGTHS)
    try:
        r = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "low"},
            messages=[{"role": "user", "content": f"Write a {g} about {t}.{l}"}],
        )
    except anthropic.RateLimitError as e:
        print("rate limited, skipping", i, e, file=sys.stderr)
        return
    except anthropic.APIStatusError as e:
        print("api error", e.status_code, str(e)[:160], file=sys.stderr)
        return
    except anthropic.APIConnectionError as e:
        print("connection error", e, file=sys.stderr)
        return
    if r.stop_reason == "refusal":
        return
    text = "".join(b.text for b in r.content if b.type == "text").strip()
    if not text:
        return
    with lock:
        with open(OUT, "a") as f:
            f.write(json.dumps({"model": r.model, "genre": g, "topic": t, "text": text}) + "\n")
    print(f"{i + 1}/{N} {r.model} {g}", flush=True)


with ThreadPoolExecutor(max_workers=6) as ex:
    list(ex.map(one, range(have, N)))
