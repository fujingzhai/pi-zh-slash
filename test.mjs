import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root =
  process.env.PI_AGENT_ROOT ||
  path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const require = createRequire(path.join(root, "package.json"));
const { createJiti } = require("jiti");
const agent = path.join(root, "dist/index.js");
const tuiPath = require.resolve("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": agent,
    "@earendil-works/pi-tui": tuiPath,
  },
});

const {
  DEFAULT_ALIASES,
  resolveToken,
  rewriteWholeInput,
  scoreCommand,
} = await jiti.import("./extensions/index.ts");

const aliases = new Map(Object.entries(DEFAULT_ALIASES).map(([k, v]) => [k, [...v]]));

assert.equal(resolveToken("设置", aliases, []), "settings");
assert.equal(resolveToken("模型", aliases, []), "model");
assert.equal(resolveToken("名", aliases, []), "name");
assert.equal(resolveToken("settings", aliases, []), "settings");
assert.equal(rewriteWholeInput("、设置", aliases, []), "/settings");
assert.equal(rewriteWholeInput("、模型 sonnet", aliases, []), "/model sonnet");
assert.equal(rewriteWholeInput("/settings", aliases, []), undefined);
assert.equal(rewriteWholeInput("、没有这个命令", aliases, []), undefined);

const extra = new Map(aliases);
extra.set("auto-rename", ["自动命名"]);
assert.equal(resolveToken("名", extra, ["auto-rename"]), "name");
assert.equal(resolveToken("自动命名", extra, ["auto-rename"]), "auto-rename");

const nameScore = scoreCommand("名", "name", ["命名"]);
const autoScore = scoreCommand("名", "auto-rename", ["自动命名"]);
assert.ok(nameScore < autoScore);

assert.ok(!DEFAULT_ALIASES.ccstyle);
assert.ok(!DEFAULT_ALIASES.llama);
assert.ok(!DEFAULT_ALIASES["web-tools"]);
assert.ok(!DEFAULT_ALIASES["auto-rename"]);
assert.deepEqual(DEFAULT_ALIASES.settings, ["设置"]);
assert.deepEqual(DEFAULT_ALIASES.outline, ["大纲"]);

console.log("PASS: zh-slash aliases, unique resolve, no personal extras");
