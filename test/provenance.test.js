const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { scan } = require("../src/provenance.js");

const pages = join(__dirname, "pages");
const bytes = (s) => new TextEncoder().encode(s);

test(
  "IPTC trainedAlgorithmicMedia in XMP → generated",
  { skip: !existsSync(join(pages, "labelled.png")) },
  () => {
    const r = scan(readFileSync(join(pages, "labelled.png")));
    assert.equal(r.ai, true);
    assert.equal(r.kind, "generated");
  },
);

test(
  "an unlabelled image → no label (which is not the same as human-made)",
  { skip: !existsSync(join(pages, "plain.png")) },
  () => {
    assert.deepEqual(scan(readFileSync(join(pages, "plain.png"))), {
      ai: false,
      kind: "no label",
      source: "",
    });
  },
);

test("composite label → partly generated", () => {
  assert.equal(
    scan(bytes("xmp ... compositeWithTrainedAlgorithmicMedia ...")).kind,
    "partly generated",
  );
});

test("C2PA manifest naming a generator → generated; without one → just credentials", () => {
  assert.equal(scan(bytes("jumb c2pa.claim claim_generator: OpenAI-API")).ai, true);
  const cam = scan(bytes("jumb c2pa.claim claim_generator: Leica M11-P"));
  assert.equal(cam.ai, false);
  assert.equal(cam.kind, "content credentials");
});

test("Stable Diffusion and ComfyUI PNG text chunks", () => {
  assert.equal(
    scan(bytes("tEXtparameters\0a castle, Steps: 30, Sampler: DPM++ 2M, CFG scale: 7")).source,
    "stable diffusion metadata",
  );
  assert.equal(
    scan(bytes('tEXtworkflow\0{"nodes":[{"class_type":"KSampler"}]}')).source,
    "comfyui metadata",
  );
});
