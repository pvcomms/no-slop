# Agents

**This is `no-slop`**, the browser extension listed on paramv.com/work as "Eat no SLOP & Cook
no SLOP". Personal tool; local-first. Read README.md for what it does and the measured numbers.

## Shape

Manifest V3, plain JavaScript, no build step, no runtime dependencies.

```
src/detector.js    pattern tells (pure; content script + node)
src/model.js       hashed-ngram logistic regression: featurize + probability (pure)
src/content.js     eat (blur blocks), images, cook (draft chip), right-click card
src/background.js  one-click pause, badge, context menu, model scoring, image labels, Pangram
src/provenance.js  AI-label scan of image bytes (IPTC / C2PA / SD / ComfyUI)
src/pangram.js     optional Pangram API client (user's key)
model/             weights.bin (int8, 2^18) + meta.json (scale, bias, thresholds) — built by bin/train.py
options/           settings page
```

## Commands

```bash
npm test                      # unit tests (node --test)
node bin/e2e.mjs              # real extension in Chrome for Testing, 18 checks + screenshots in .e2e/
node bin/eval.mjs --misses    # held-out sets through the extension's own decision rule
.venv/bin/python bin/train.py # retrain; needs .cache corpora (see README → data)
python3 bin/icons.py          # redraw icons
```

## Invariants

- **featurize must match.** `src/model.js` and `bin/train.py` tokenize and hash identically;
  `test/model.test.js` checks a probe string against the trainer's output. Change both or neither.
- **Drafts never leave the page.** Cook mode scores in the content script only — no messages
  to the worker, never to Pangram.
- **Pangram only with a key and a mode.** Text leaves the machine through `src/pangram.js`
  and nowhere else. No analytics, no remote code, no other hosts.
- **Numbers in README come from `bin/eval.mjs` / `bin/train.py` output.** Re-run and update
  them when the model or the rule changes; never edit them by hand.
- `test/fixtures/.cache/` holds third-party text (HC3, RAID, Yelp, Amazon, Enron, HN). It is
  gitignored and stays local.
