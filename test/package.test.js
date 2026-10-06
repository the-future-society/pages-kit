import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { KIT_VERSION } from "../kit.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

test("package version and KIT_VERSION agree", () => {
  assert.equal(pkg.version, KIT_VERSION);
});

test("the package is publishable and ships exactly the kit files", () => {
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.publishConfig.access, "public");
  assert.deepEqual([...pkg.files].sort(), ["LICENSE", "README.md", "form.js", "kit-css.js", "kit.css", "kit.js", "markdown.js", "save.js", "transport.js"].sort());
});

test("no runtime dependencies", () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
});

test("no file in the package carries real-looking TFS row ids", () => {
  for (const f of readdirSync(new URL("..", import.meta.url))) {
    if (!/\.(js|css|md)$/.test(f)) continue;
    const s = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(s, /\bi-[A-Za-z0-9_-]{10}\b/, f);
  }
});
