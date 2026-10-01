/*
  no-slop · detector — scores a piece of text for the tells of machine-written prose.

  Pure function, no DOM, no network. Runs in the content script, the service worker,
  and under `node --test`. It reads style, not provenance: it can say "this reads like
  default model output", never "a model wrote this". Pangram is the optional second
  opinion for that (src/pangram.js).

  The word tiers follow the avoid-ai-writing skill:
    tier 1 — flag on sight            (weight 2–3 each)
    tier 2 — flag only in clusters    (needs 2+ distinct words in the same text)
    tier 3 — flag only by density     (normal words, suspicious when they pile up)
  Phrases and structure (negation-reframes, chatbot tics, broetry, rhythm) carry the rest.
*/
(function (root) {
  "use strict";

  // [pattern, weight, label, fix]
  const TIER1 = [
    ["delv(?:e|es|ed|ing)", 3, "delve", "look at, dig into"],
    ["tapestr(?:y|ies)", 3, "tapestry", "name the actual mix"],
    ["testament to", 3, "testament to", "shows"],
    ["realms?", 3, "realm", "area, field"],
    ["embark(?:s|ed|ing)?", 3, "embark", "start"],
    ["beacons?", 3, "beacon", "rewrite"],
    ["meticulous(?:ly)?", 3, "meticulous", "careful"],
    ["showcas(?:e|es|ed|ing)", 3, "showcase", "show"],
    ["pivotal", 3, "pivotal", "key"],
    ["underscor(?:e|es|ed|ing)", 3, "underscore", "shows"],
    ["intricate(?:ly)?", 3, "intricate", "name the complexity"],
    ["intricacies", 3, "intricacies", "details"],
    ["seamless(?:ly)?", 3, "seamless", "smooth"],
    ["game[- ]chang(?:er|ers|ing)", 3, "game-changer", "say what changed"],
    ["ever[- ]evolving", 3, "ever-evolving", "changing"],
    ["bustling", 3, "bustling", "busy"],
    ["nestled", 3, "nestled", "sits, is in"],
    ["at its core", 3, "at its core", "cut it"],
    ["synerg(?:y|ies|istic)", 3, "synergy", "name the effect"],
    ["interplay", 3, "interplay", "relationship"],
    ["commendable", 3, "commendable", "good"],
    ["deep[- ]dives?", 3, "deep dive", "look at"],
    ["dive (?:deep(?:er)? )?in(?:to)?", 3, "dive into", "look at"],
    ["unpack(?:s|ed|ing)?", 3, "unpack", "explain"],
    ["holistic(?:ally)?", 3, "holistic", "whole"],
    ["actionable", 3, "actionable", "practical"],
    ["impactful", 3, "impactful", "say the impact"],
    ["learnings", 3, "learnings", "lessons"],
    ["hits? different(?:ly)?", 3, "hits different", "say how"],
    ["watershed moment", 3, "watershed moment", "turning point"],
    ["thought leader(?:s|ship)?", 3, "thought leader", "expert"],
    ["boasts?", 3, "boasts", "has"],
    ["symphony of", 3, "symphony of", "name the mix"],
    [
      "navigat(?:e|es|ing) the (?:complexities|intricacies|challenges|nuances|world|landscape)",
      3,
      "navigate the complexities",
      "handle",
    ],
    [
      "unlock(?:s|ing)? (?:the |your |their |its )?(?:full )?potential",
      3,
      "unlock potential",
      "say what improves",
    ],
    ["take (?:it|things|your [a-z]+) to the next level", 3, "next level", "say how"],
    ["a rich (?:tapestry|history|heritage|blend|array)", 3, "a rich …", "be specific"],
    ["robust", 2, "robust", "strong"],
    ["comprehensive", 2, "comprehensive", "thorough"],
    ["cutting[- ]edge", 2, "cutting-edge", "latest"],
    ["leverag(?:e|es|ed|ing)", 2, "leverage", "use"],
    ["utiliz(?:e|es|ed|ing|ation)", 2, "utilize", "use"],
    ["vibrant", 2, "vibrant", "cut or be specific"],
    ["thriving", 2, "thriving", "growing"],
    ["daunting", 2, "daunting", "hard"],
    ["paradigms?", 2, "paradigm", "model"],
    ["complexities", 2, "complexities", "name them"],
    ["serves as", 2, "serves as", "is"],
    ["stands as (?:a|an|the)", 2, "stands as", "is"],
    ["best practices", 2, "best practices", "what works"],
    ["commenc(?:e|es|ed|ing)", 2, "commence", "start"],
    ["ascertain", 2, "ascertain", "find out"],
    ["endeavou?rs?", 2, "endeavor", "effort"],
    [
      "(?:digital|business|competitive|media|tech(?:nology)?|political|cultural|evolving|ever-changing|changing|current|modern|ai|regulatory|financial|economic|social|creative|marketing|startup|job|healthcare|educational|information|content|investment) landscape",
      2,
      "the … landscape",
      "field, market",
    ],
  ];

  const TIER2 = [
    "harness(?:es|ed|ing)?",
    "navigat(?:e|es|ed|ing)",
    "foster(?:s|ed|ing)?",
    "elevat(?:e|es|ed|ing)",
    "unleash(?:es|ed|ing)?",
    "streamlin(?:e|es|ed|ing)",
    "empower(?:s|ed|ing|ment)?",
    "bolster(?:s|ed|ing)?",
    "spearhead(?:s|ed|ing)?",
    "resonat(?:e|es|ed|ing)",
    "revolutioniz(?:e|es|ed|ing)",
    "facilitat(?:e|es|ed|ing)",
    "underpin(?:s|ned|ning|nings)?",
    "nuanced",
    "crucial(?:ly)?",
    "multifaceted",
    "ecosystems?",
    "myriad",
    "plethora",
    "encompass(?:es|ed|ing)?",
    "catalyz(?:e|es|ed|ing)",
    "reimagin(?:e|es|ed|ing)",
    "galvaniz(?:e|es|ed|ing)",
    "augment(?:s|ed|ing)?",
    "cultivat(?:e|es|ed|ing)",
    "illuminat(?:e|es|ed|ing)",
    "elucidat(?:e|es|ed|ing)",
    "juxtapos(?:e|es|ed|ing)",
    "transformative",
    "cornerstones?",
    "paramount",
    "poised",
    "burgeoning",
    "nascent",
    "quintessential",
    "overarching",
    "unlock(?:s|ed|ing)?",
    "vital",
    "invaluable",
    "insightful",
    "profound(?:ly)?",
    "enhanc(?:e|es|ed|ing)",
    "optimiz(?:e|es|ed|ing)",
    "innovative",
  ];

  const TIER3 = [
    "significant(?:ly)?",
    "innovation",
    "effective(?:ly)?",
    "dynamic(?:s)?",
    "scalab(?:le|ility)",
    "compelling",
    "unprecedented",
    "exceptional(?:ly)?",
    "remarkabl(?:e|y)",
    "sophisticated",
    "instrumental",
    "world[- ]class",
    "state[- ]of[- ]the[- ]art",
    "best[- ]in[- ]class",
    "key",
    "essential",
    "valuable",
    "powerful",
    "ensur(?:e|es|ed|ing)",
  ];

  const S = "(?:^|[.!?]\\s+|\\n\\s*)"; // sentence start
  // w = weight per hit, cap = hits counted at most; every pattern is case-insensitive
  const PHRASES = [
    {
      id: "cutoff",
      label: "model disclaimer",
      fix: "cut it",
      w: 6,
      cap: 2,
      re: "\\b(?:as an ai(?: language model)?|as a large language model|as of my (?:last|latest) (?:update|knowledge|training)|i (?:don't|do not) have (?:personal (?:opinions|experiences)|access to real[- ]time))",
    },
    {
      id: "chatbot",
      label: "chatbot tic",
      fix: "cut it",
      w: 4,
      cap: 3,
      re:
        "(?:\\bi hope (?:this|that) helps\\b|\\bgreat question\\b|\\bexcellent question\\b|" +
        S +
        "(?:certainly|absolutely|of course)!)",
    },
    {
      id: "polite",
      label: "boilerplate courtesy",
      fix: "say the thing",
      w: 2,
      cap: 3,
      re: "\\b(?:feel free to (?:reach out|ask|let me know)|(?:please )?don'?t hesitate to (?:reach out|contact|ask|let)|let me know if you (?:have any|need anything|'d like)|happy to help|i hope (?:this|my) (?:email|message|note) finds you well|(?:sincerely |deeply )?apologi[sz]e for any inconvenience|i completely understand how frustrating|we (?:truly|really) value your|i had the pleasure of)\\b",
    },
    {
      id: "cliche",
      label: "stock phrase",
      fix: "say it in your own words",
      w: 2,
      cap: 4,
      re: "\\b(?:embrace the (?:journey|uncertainty|process|chaos)|the (?:best|truest) version of (?:yourself|myself|ourselves)|you can'?t pour from an empty cup|celebrate (?:the )?small wins|every twist and turn|growth isn'?t linear|(?:a|this|the) new chapter|step(?:ping)? into (?:the new year|this new chapter|my power)|set against the backdrop of|a (?:poignant|powerful|beautifully crafted|thought-provoking|searing|profound|compelling|timely) (?:exploration|meditation|portrait|examination|reminder) of|from the moment (?:you|we|i) (?:step|walk|arrive)|went above and beyond|a must-(?:visit|read|watch|have|try|see)|hidden gem|something for everyone|perfect harmony of|the perfect blend of|key takeaways?|(?:your|my|our|their|the) (?:coding|learning|healing|growth|fitness|career|wellness|entrepreneurial|creative) journey|cut(?:s|ting)? through the noise|at the intersection of)\\b",
    },
    {
      id: "meta",
      label: "in this article, we'll explore",
      fix: "start with the point",
      w: 3,
      cap: 1,
      re: "\\bin this (?:article|guide|post|blog post|piece|video|thread),? (?:we'?ll|we will|i'?ll|i will|you'?ll) (?:explore|delve|walk|dive|look|cover|break|unpack|discuss)|\\(?a thread\\)?\\s*🧵|🧵\\s*👇",
    },
    {
      id: "reframe",
      label: "not just X, but Y",
      fix: "say the positive claim",
      w: 3,
      cap: 3,
      re: "\\bnot (?:just|only|merely|simply) (?:about )?[^.!?\\n]{1,80}?,? but (?:also )?",
    },
    {
      id: "reframe2",
      label: "it's not X — it's Y",
      fix: "say the positive claim",
      w: 3,
      cap: 2,
      re: "\\b(?:it'?s not|it is not|this is not|that'?s not|this isn'?t|it isn'?t|that isn'?t|isn'?t|is not|wasn'?t|was not|aren'?t|are not)\\s+(?:just\\s+|only\\s+|merely\\s+|really\\s+)?(?:about\\s+)?[^.!?;:\\n]{1,60}?(?:[,;—–]|\\.\\s+|\\s-\\s)\\s*(?:it'?s|it is|this is|that'?s|they'?re|we'?re|you'?re)\\s+(?:about\\s+)?",
    },
    {
      id: "steer",
      label: "here's the thing",
      fix: "just say it",
      w: 2,
      cap: 3,
      re: "\\bhere'?s (?:the thing|why|what|how|the kicker|the catch|the truth|the secret|where|my take|the deal|the reality)\\b|\\bhere is (?:the thing|why)\\b",
    },
    {
      id: "lets",
      label: "let's + verb",
      fix: "start with the point",
      w: 2,
      cap: 3,
      re: "\\blet'?s (?:dive|delve|explore|unpack|break (?:it|this|that) down|take a (?:closer )?look|examine|get started|talk about|be honest|be real)\\b",
    },
    {
      id: "filler",
      label: "it's worth noting",
      fix: "state the fact",
      w: 3,
      cap: 3,
      re: "\\bit(?:'s| is) (?:important|worth|crucial|essential|vital) (?:to note|noting|mentioning|remembering|to remember|to understand|to recognize|to consider)\\b|\\bit(?:'s| is) worth noting\\b|\\bthe reality is(?: that)?\\b",
    },
    {
      id: "opening",
      label: "in today's fast-paced world",
      fix: "lead with the point",
      w: 3,
      cap: 2,
      re: "\\bin (?:today'?s|the modern|this|our) (?:fast-paced|ever-changing|ever-evolving|rapidly (?:changing|evolving)|digital|increasingly (?:connected|digital|complex)|modern|hyper-connected) (?:world|age|era|landscape|environment|economy|society)\\b|\\bin an (?:era|age|world) (?:where|of|defined by)\\b|\\bin the (?:ever-evolving|rapidly evolving|ever-changing|fast-paced) (?:world|landscape|realm|field) of\\b",
    },
    {
      id: "whether",
      label: "whether you're X or Y",
      fix: "pick the reader",
      w: 2,
      cap: 2,
      re: "\\bwhether you'?re (?:a |an |just )?[^.!?,\\n]{1,40}? or (?:a |an |just |simply )?",
    },
    {
      id: "role",
      label: "plays a crucial role",
      fix: "say what it does",
      w: 2,
      cap: 2,
      re: "\\bplays? (?:a|an) (?:crucial|pivotal|vital|key|significant|important|critical|central|instrumental|essential) role\\b",
    },
    {
      id: "conclusion",
      label: "generic conclusion",
      fix: "cut it",
      w: 3,
      cap: 2,
      re: "\\b(?:the future (?:looks|is) bright|only time will tell|one thing is (?:certain|clear)|as we (?:move|look) forward|the possibilities are endless|the sky'?s the limit|in an ever[- ]changing world)\\b",
    },
    {
      id: "summary",
      label: "in conclusion,",
      fix: "cut it",
      w: 2,
      cap: 2,
      re: S + "(?:in conclusion|in summary|to summarize|to sum up|all in all|ultimately|overall),",
    },
    {
      id: "transition",
      label: "moreover / furthermore",
      fix: "and, also",
      w: 1,
      cap: 4,
      re:
        S +
        "(?:moreover|furthermore|additionally|notably|importantly|interestingly|crucially|consequently)\\b",
    },
    {
      id: "rhetorical",
      label: "the result?",
      fix: "just say it",
      w: 2,
      cap: 3,
      re:
        S +
        "(?:the (?:result|answer|catch|kicker|truth|secret|best part|problem|reason|twist|lesson|takeaway|verdict|outcome)|what happened next|sound familiar|the kicker)\\?(?=\\s)",
    },
    {
      id: "announce",
      label: "thrilled to announce",
      fix: "say what happened",
      w: 3,
      cap: 1,
      re: "\\b(?:i'?m|i am|we'?re|we are) (?:thrilled|excited|humbled|hono(?:u)?red|delighted|proud|beyond excited) to (?:announce|share)\\b",
    },
    {
      id: "bait",
      label: "engagement bait",
      fix: "cut it",
      w: 2,
      cap: 3,
      re: "\\b(?:let that sink in|read that again|nobody (?:is )?talking about|no one (?:is )?talking about|what nobody tells you|the (?:insight|thing) (?:everyone|nobody)(?:'s| is) missing|drop (?:a|your) [^.\\n]{1,20} (?:below|in the comments)|comment below|follow for more|repost (?:if|to)|♻️)",
    },
    {
      id: "flatline",
      label: "what surprised me most",
      fix: "show it",
      w: 2,
      cap: 2,
      re: "\\bwhat (?:surprised|struck|fascinated|excited|amazed) me (?:the )?most\\b|\\bi was (?:fascinated|excited|surprised|amazed) to (?:learn|discover|find|see)\\b",
    },
    {
      id: "attribution",
      label: "experts believe",
      fix: "name the source",
      w: 1,
      cap: 2,
      re: "\\b(?:experts|studies|research|scientists|industry leaders|many people) (?:believe|show|suggest|agree|say)\\b",
    },
    {
      id: "step",
      label: "a significant step forward",
      fix: "say what changed",
      w: 2,
      cap: 2,
      re: "\\ba (?:significant|major|crucial|pivotal|bold|big|giant|meaningful|important|critical) step (?:forward|towards?|in the right direction)\\b",
    },
    {
      id: "range",
      label: "…and everything in between",
      fix: "list what you mean",
      w: 2,
      cap: 1,
      re: "\\band everything in between\\b",
    },
  ];

  // --- compile once -----------------------------------------------------------
  const wb = (src) => new RegExp("\\b(?:" + src + ")\\b", "gi");
  const T1 = TIER1.map(([src, w, label, fix]) => ({
    re: wb(src),
    w,
    label,
    fix,
  }));
  const T2 = TIER2.map((src) => ({ re: wb(src), src }));
  const T3 = TIER3.map((src) => wb(src));
  const PH = PHRASES.map((p) => ({ ...p, re: new RegExp(p.re, "gi") }));
  const EMOJI_LINE = /^\s*(?:\p{Extended_Pictographic}|[✓✔➡→▶►])️?\s*\S/gmu;
  const BOLD = /\*\*[^*\n]{2,80}\*\*/g;
  const HEADING = /^#{1,3} \S/gm;
  const DASH = /—|\s--\s|\w--\w/g;
  const TRIAD = /\b[\w-]+, [\w-]+,? and [\w-]+\b/g;
  const INTENSIFIER =
    /\b(?:truly|genuinely|incredibly|deeply|undoubtedly|profoundly|remarkably|utterly|wholeheartedly|sincerely)\b/gi;
  const PROMO =
    /\b(?:delightful|captivating|breathtaking|unforgettable|charming|stunning|exquisite|immersive|unparalleled|world-class|sleek|irresistible|heartfelt|awe-inspiring|picturesque|mouthwatering|velvety|elevated|curated|timeless|iconic|premium|effortless(?:ly)?)\b/gi;

  const SENS = {
    gentle: { slop: 9, suspect: 6 },
    balanced: { slop: 6, suspect: 3.5 },
    strict: { slop: 4, suspect: 2.5 },
  };

  function normalize(text) {
    return String(text || "")
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  function countWords(t) {
    const m = t.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g);
    return m ? m.length : 0;
  }

  function matches(re, t) {
    re.lastIndex = 0;
    const out = [];
    let m;
    while ((m = re.exec(t))) {
      out.push(m[0].trim());
      if (m[0].length === 0) re.lastIndex++;
    }
    return out;
  }

  function sentences(t) {
    return t
      .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n+/)
      .map((s) => s.trim())
      .filter((s) => countWords(s) >= 2);
  }

  function englishish(t) {
    const letters = t.match(/\p{L}/gu);
    if (!letters || letters.length < 20) return true;
    const ascii = t.match(/[A-Za-z]/g);
    return (ascii ? ascii.length : 0) / letters.length > 0.8;
  }

  /**
   * analyze(text, { sensitivity }) → {
   *   words, raw, density, verdict: "clean" | "suspect" | "slop",
   *   tells: [{ id, label, count, weight, sample, fix }]
   * }
   */
  function analyze(input, opts) {
    const sens = SENS[(opts && opts.sensitivity) || "balanced"] || SENS.balanced;
    const minWords = (opts && opts.minWords) || 0;
    const text = normalize(input);
    const words = countWords(text);
    const empty = { words, raw: 0, density: 0, verdict: "clean", tells: [] };
    if (words < Math.max(8, minWords)) return empty;
    if (!englishish(text)) return Object.assign(empty, { skipped: "not english" });

    const tells = [];
    const add = (id, label, count, weight, sample, fix) => {
      if (count > 0 && weight > 0) tells.push({ id, label, count, weight, sample, fix });
    };

    for (const t of T1) {
      const hits = matches(t.re, text);
      if (hits.length)
        add("w:" + t.label, t.label, hits.length, t.w * Math.min(hits.length, 3), hits[0], t.fix);
    }

    const t2hits = [];
    for (const t of T2) {
      const hits = matches(t.re, text);
      if (hits.length) t2hits.push({ word: hits[0].toLowerCase(), n: hits.length });
    }
    if (t2hits.length >= 2) {
      const n = t2hits.reduce((a, h) => a + Math.min(h.n, 2), 0);
      add(
        "cluster",
        "buzzword cluster",
        t2hits.length,
        Math.min(1.5 * n, 7),
        t2hits
          .map((h) => h.word)
          .slice(0, 5)
          .join(", "),
        "plain verbs: use, help, build, lead",
      );
    }

    const t3 = T3.reduce((a, re) => a + matches(re, text).length, 0);
    if (t3 >= 3 && t3 / words >= 0.025)
      add(
        "density",
        "vague praise density",
        t3,
        2,
        t3 + " in " + words + " words",
        "numbers and specifics",
      );

    const intens = matches(INTENSIFIER, text);
    if (intens.length >= 2 && intens.length / words >= 0.012)
      add(
        "intensifier",
        "hollow intensifiers",
        intens.length,
        intens.length >= 4 ? 3 : 2,
        intens.slice(0, 4).join(", "),
        "cut them",
      );

    const promo = matches(PROMO, text);
    const promoKinds = new Set(promo.map((w) => w.toLowerCase())).size;
    if (promoKinds >= 2)
      add(
        "promo",
        "brochure adjectives",
        promo.length,
        Math.min(1.5 * promoKinds, 5),
        promo.slice(0, 4).join(", "),
        "describe, don't sell",
      );

    for (const p of PH) {
      const hits = matches(p.re, text);
      if (hits.length)
        add(
          p.id,
          p.label,
          hits.length,
          p.w * Math.min(hits.length, p.cap),
          hits[0].slice(0, 90),
          p.fix,
        );
    }

    // structure ---------------------------------------------------------------
    const dashes = matches(DASH, text).length;
    const dashPer100 = (dashes / words) * 100;
    if (dashes >= 2 && dashPer100 >= 0.9)
      add(
        "dash",
        "em-dash density",
        dashes,
        dashPer100 >= 2 ? 3 : 2,
        dashes + " dashes",
        "commas, periods",
      );

    const emojiLines = matches(EMOJI_LINE, text).length;
    if (emojiLines >= 2)
      add(
        "emoji",
        "emoji bullets",
        emojiLines,
        emojiLines >= 4 ? 3 : 2,
        emojiLines + " lines",
        "plain sentences",
      );

    const bold = matches(BOLD, text);
    if (bold.length) add("bold", "markdown bold residue", bold.length, 2, bold[0], "no bold");
    const heads = matches(HEADING, text).length;
    if (heads >= 1)
      add("heading", "markdown heading residue", heads, 2, heads + " headings", "no headings");

    const lines = text
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length >= 5) {
      const short = lines.filter((l) => countWords(l) <= 14 && sentences(l).length <= 1).length;
      if (short / lines.length >= 0.75)
        add(
          "broetry",
          "one-line paragraphs",
          lines.length,
          3,
          short + " of " + lines.length + " lines",
          "join into paragraphs",
        );
    }

    const sl = sentences(text).map(countWords);
    if (sl.length >= 6) {
      const mean = sl.reduce((a, b) => a + b, 0) / sl.length;
      const sd = Math.sqrt(sl.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sl.length);
      const cv = sd / mean;
      if (cv < 0.3 && mean >= 11)
        add(
          "rhythm",
          "metronome rhythm",
          sl.length,
          2,
          "sentence lengths vary by " + Math.round(cv * 100) + "%",
          "mix short and long",
        );
    }

    const triads = matches(TRIAD, text).length;
    if (triads >= 3 && triads / words >= 1 / 70)
      add("triad", "rule of three", triads, 1, triads + " triads", "two or four");

    const raw = tells.reduce((a, t) => a + t.weight, 0);
    const density = (raw * 100) / Math.max(words, 80);
    const distinct = tells.length;
    let verdict = "clean";
    if (density >= sens.slop && distinct >= 2) verdict = "slop";
    else if (density >= sens.suspect && distinct >= 2) verdict = "suspect";
    tells.sort((a, b) => b.weight - a.weight);
    return {
      words,
      raw: Math.round(raw * 10) / 10,
      density: Math.round(density * 10) / 10,
      verdict,
      tells,
    };
  }

  const api = { analyze, normalize, countWords, SENS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NoSlop = Object.assign(root.NoSlop || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
