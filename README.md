# Eat no SLOP & Cook no SLOP

A browser extension (Chrome, Manifest V3) that blurs machine-written text and AI-labelled images
as you read, and shows the tells in what you write. It scores on your machine. Nothing leaves it
unless you add a Pangram key.

- **Eat.** Posts, comments and paragraphs that read as machine-written are blurred, with a
  one-line note saying why (`slop · 97% machine · delve · game-changer · dive into · show`).
  Works on any page. X, Reddit, LinkedIn, YouTube, Hacker News, Bluesky, Threads and Facebook
  posts are read as whole posts. New content is scored as it loads.
- **Images.** Large images whose files say they were generated are blurred: IPTC
  `trainedAlgorithmicMedia` (what OpenAI, Google and Adobe write), C2PA manifests naming a
  generator, and Stable Diffusion / ComfyUI metadata. A missing label means nothing. Most social
  sites strip metadata.
- **Cook.** In any text box, a small chip lists the tells in your own draft with a plainer
  alternative for each. Your drafts are scored in the page and go nowhere else.
- **Check.** Right-click any selection → _Check selection for slop_ for a verdict card.
- **One click.** The toolbar icon pauses or resumes the current site. The badge counts what was
  blurred on the page, or says `off`.

## Install

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → choose this folder

Settings: right-click the icon → _Options_. Sensitivity (gentle / balanced / strict), blur or
label only, images on/off, cook on/off, and an optional Pangram key.

## How it decides

Two signals. A block is blurred when either one fires. Blocks under 40 words get the pattern
tells only.

1. **Pattern tells** (`src/detector.js`). The tiered word lists from the avoid-ai-writing skill,
   plus structure: _not X, but Y_ reframes, chatbot tics, one-line-paragraph posts, em-dash
   density, emoji bullets, metronome sentence rhythm, stock phrases. These are what the notes
   and the cook panel name. On their own they catch the obvious and miss clean AI prose.
2. **A local model** (`src/model.js`, `model/`). Logistic regression over hashed word
   unigrams and bigrams, 2^18 int8 weights (256 KB), run in the service worker. Trained by
   `bin/train.py` on about 30,000 human and 20,000 machine texts. Human and machine text come
   from the same genres, so the model can't learn "marketing copy = AI".

Thresholds are set as false-positive budgets on held-out human text: gentle ≈ 0.3%,
balanced ≈ 1%, strict ≈ 3%.

### Measured (`node bin/eval.mjs`, share blurred, balanced)

The shipped model, on held-out text it never trained on:

|                                                                 | blurred |
| --------------------------------------------------------------- | ------- |
| human · Hacker News comments, 2019                              | 0.3%    |
| human · Yelp / Amazon reviews + Enron email                     | 0.1%    |
| human · HC3 answers (Reddit ELI5, Wikipedia, finance, medicine) | 1.0%    |
| human · RAID abstracts, news, book summaries                    | 3.0%    |
| human · Project Gutenberg                                       | 0.0%    |
| machine · ChatGPT (HC3)                                         | 97.1%   |
| machine · GPT-4, ChatGPT, Llama, Mistral, MPT chat (RAID)       | 98.3%   |
| machine · qwen2.5 7b, web genres                                | 97.5%   |
| machine · Cohere chat                                           | 81.3%   |

**Models it has never seen.** The one number to trust for next year's model comes from a run
that held whole model families out of training:

| family never trained on           | balanced | strict |
| --------------------------------- | -------- | ------ |
| Cohere chat                       | 64.5%    | 75.7%  |
| qwen3.6 35b                       | 65.0%    | 82.5%  |
| gpt-oss 120b                      | 46.2%    | 61.5%  |
| Claude (36 samples, hand-written) | 75.0%    | 83.3%  |

It is a style detector. Text a person has edited, or a model told to write plainly, gets
through. That is what the Pangram option is for.

## Pangram (optional)

Pangram's detector is a hosted transformer and much stronger than this one. Its Chrome
extension is closed source. Its Python SDK is MIT, and `src/pangram.js` follows the SDK's API
shape (`POST /task` with `x-api-key`, poll `/task/{id}`, `model: "default"`). Add your key in
options and choose:

- **when I ask** — the right-click card adds Pangram's verdict.
- **confirm blocks** — every blurred block ≥ 50 words is sent for a second look, and unblurred
  if Pangram calls it human. Billed per 100 words on your Pangram plan. Results are cached, so
  no block is paid for twice.

Text goes to `text.external-api.pangram.com` only in these two modes. Drafts are never sent.

## Development

```bash
npm test                          # 17 unit tests: detector, model parity with the trainer, provenance, pangram client
node bin/e2e.mjs                  # 18 checks with the real extension in Chrome for Testing (+ screenshots in .e2e/)
node bin/eval.mjs --misses        # held-out sets through the extension's own rule
python3 bin/icons.py              # redraw icons
```

Retraining needs the corpora in `test/fixtures/.cache/` (gitignored, third-party text):

```bash
python3 -m venv --system-site-packages .venv && .venv/bin/pip install pyarrow anthropic
node bin/fetch-human.mjs                     # Gutenberg + HN 2019
curl -L -o test/fixtures/.cache/hc3-all.jsonl https://huggingface.co/datasets/Hello-SimpleAI/HC3/resolve/main/all.jsonl
# RAID shards → test/fixtures/.cache/raid-*.parquet (huggingface.co/datasets/liamdugan/raid, refs/convert/parquet)
.venv/bin/python bin/fetch-corpora.py        # RAID sample + Yelp / Amazon / Enron
python3 bin/gen-ollama.py qwen2.5:7b 200     # local generations (also gpt-oss:120b, qwen3.6:35b-a3b)
.venv/bin/python bin/train.py                # held-out-family report
.venv/bin/python bin/train.py --final        # the model that ships
```

`test/fixtures/claude-train.json` is 48 short pieces written by Claude in its default voice for
genre prompts, standing in for API generations.

## Data and licences

HC3 (CC BY-SA 4.0) · RAID (Dugan et al., ACL 2024) · Yelp and Amazon review sets and AESLC
(Enron) from the Hugging Face hub · Hacker News comments via the Algolia API · Project Gutenberg
(public domain) · local generations from qwen2.5, qwen3.6 and gpt-oss. The weights are derived
from these. Check each dataset's terms before publishing the extension to a store.

## Not done

- Firefox: the manifest is Chrome-only (`background.service_worker`).
- Video and audio.
- Non-English text is skipped.
