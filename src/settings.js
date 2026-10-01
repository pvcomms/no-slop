// no-slop · settings shared by the content script, the service worker and the options page.
(function (root) {
  "use strict";
  const DEFAULTS = {
    eat: true,
    sensitivity: "balanced", // gentle | balanced | strict
    action: "blur", // blur | label
    images: true,
    cook: true,
    pangram: "off", // off | selection | confirm
    paused: {}, // host → time paused
  };
  async function load() {
    return Object.assign({}, DEFAULTS, await chrome.storage.sync.get(DEFAULTS));
  }
  root.NoSlopSettings = { DEFAULTS, load };
})(globalThis);
