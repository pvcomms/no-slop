/*
  no-slop · provenance — does an image file say it was made by a generative model?

  Reads labels, never pixels. Looks in the first bytes of the file for:
    · IPTC digital source type (XMP or C2PA): trainedAlgorithmicMedia = generated,
      compositeWithTrainedAlgorithmicMedia = partly generated
    · a C2PA manifest whose claim generator names a known image model
    · Stable Diffusion (A1111) "parameters" and ComfyUI "workflow" PNG text chunks
  Platforms that strip metadata (most social sites) leave nothing to find; a clean result
  means "no label", not "human-made".
*/
(function (root) {
  "use strict";

  const GENERATORS = [
    "DALL-E",
    "DALL·E",
    "OpenAI",
    "ChatGPT",
    "gpt-image",
    "Midjourney",
    "Adobe Firefly",
    "Firefly",
    "Imagen",
    "Gemini",
    "Stable Diffusion",
    "StableDiffusion",
    "stability.ai",
    "Ideogram",
    "Leonardo.Ai",
    "NovelAI",
    "Flux",
    "black-forest-labs",
    "Bing Image Creator",
    "Microsoft Designer",
    "Meta AI",
  ];

  function ascii(bytes) {
    // latin1 view: every byte → one char, so byte offsets and ASCII search line up
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return s;
  }

  function scan(bytes) {
    const s = ascii(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const c2pa = /c2pa|jumb|cai:/i.test(s);
    if (s.includes("compositeWithTrainedAlgorithmicMedia"))
      return {
        ai: true,
        kind: "partly generated",
        source: c2pa ? "c2pa" : "iptc",
      };
    if (s.includes("trainedAlgorithmicMedia"))
      return { ai: true, kind: "generated", source: c2pa ? "c2pa" : "iptc" };
    if (/parameters\0[\s\S]{0,4000}Steps: \d+[\s\S]{0,400}Sampler:/.test(s))
      return {
        ai: true,
        kind: "generated",
        source: "stable diffusion metadata",
      };
    if (/(?:prompt|workflow)\0[\s\S]{0,200}"class_type"/.test(s))
      return { ai: true, kind: "generated", source: "comfyui metadata" };
    if (c2pa) {
      const gen = GENERATORS.find((g) => s.includes(g));
      if (gen) return { ai: true, kind: "generated", source: "c2pa · " + gen };
      return { ai: false, kind: "content credentials", source: "c2pa" };
    }
    return { ai: false, kind: "no label", source: "" };
  }

  const api = { scan };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NoSlopProvenance = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
