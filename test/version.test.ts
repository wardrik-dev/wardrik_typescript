import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { version } from "../src/index.ts";

test("version is package.json's", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(version, pkg.version);
});
