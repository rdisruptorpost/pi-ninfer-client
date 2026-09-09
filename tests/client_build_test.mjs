import assert from "node:assert/strict";
import {
  accessSync,
  constants,
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const piExecutable = (process.env.PATH ?? "")
  .split(":")
  .map((directory) => join(directory, "pi"))
  .find((candidate) => {
    try { accessSync(candidate, constants.X_OK); return true; }
    catch { return false; }
  });
if (!piExecutable) throw new Error("pi not found on PATH");

const codingAgent = process.env.PI_CODING_AGENT_PACKAGE
  ?? resolve(dirname(realpathSync(piExecutable)), "..");
const jitiUrl = pathToFileURL(join(codingAgent, "node_modules/jiti/lib/jiti.mjs")).href;
const work = mkdtempSync(join(tmpdir(), "client-build-test-"));
process.env.PI_CODING_AGENT_DIR = work;

copyFileSync(join(root, "extensions/ninfer-tui/client-build.ts"), join(work, "client-build.ts"));
mkdirSync(join(work, "node_modules/@earendil-works"), { recursive: true });
symlinkSync(codingAgent, join(work, "node_modules/@earendil-works/pi-coding-agent"), "dir");

const jiti = (await import(jitiUrl)).createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const module = await jiti.import(join(work, "client-build.ts"));
const installedCommit = "a".repeat(40);
const remoteCommit = "b".repeat(40);
const buildPath = join(work, "client-build.json");
const cachePath = join(work, "client-build-cache.json");

writeFileSync(buildPath, JSON.stringify({
  repository: "owner/project",
  ref: "main",
  commit: installedCommit,
}), "utf8");
const installed = module.readInstalledClientBuild(buildPath);
assert.equal(installed.commit, installedCommit);
assert.equal(module.formatClientBuild(installed), "client aaaaaaa · checking");

let fetches = 0;
const current = await module.checkClientBuild(installed, {
  cachePath,
  now: 1000,
  fetchRemoteCommit: async () => { fetches++; return installedCommit; },
});
assert.equal(current.status, "current");
assert.equal(module.formatClientBuild(current), "client aaaaaaa · current");
assert.equal(fetches, 1);

const cached = await module.checkClientBuild(installed, {
  cachePath,
  now: 2000,
  fetchRemoteCommit: async () => { throw new Error("fresh cache was ignored"); },
});
assert.equal(cached.status, "current");

const differentCache = join(work, "different-cache.json");
const outdated = await module.checkClientBuild(installed, {
  cachePath: differentCache,
  now: 3000,
  fetchRemoteCommit: async () => remoteCommit,
});
assert.equal(outdated.status, "update-available");
assert.equal(module.formatClientBuild(outdated), "client aaaaaaa · update bbbbbbb");
assert.equal(JSON.parse(readFileSync(differentCache, "utf8")).commit, remoteCommit);

const unavailableCache = join(work, "unavailable-cache.json");
const unavailable = await module.checkClientBuild(installed, {
  cachePath: unavailableCache,
  now: 4000,
  fetchRemoteCommit: async () => undefined,
});
assert.equal(unavailable.status, "unknown");
const unavailableCached = await module.checkClientBuild(installed, {
  cachePath: unavailableCache,
  now: 5000,
  fetchRemoteCommit: async () => { throw new Error("failed checks were not cached"); },
});
assert.equal(unavailableCached.status, "unknown");

writeFileSync(buildPath, '{"repository":"bad","ref":"main","commit":"nope"}', "utf8");
assert.equal(module.readInstalledClientBuild(buildPath), undefined);

const tuiWork = join(work, "ninfer-tui");
cpSync(join(root, "extensions/ninfer-tui"), tuiWork, { recursive: true });
mkdirSync(join(tuiWork, "node_modules/@earendil-works"), { recursive: true });
symlinkSync(codingAgent, join(tuiWork, "node_modules/@earendil-works/pi-coding-agent"), "dir");
symlinkSync(
  join(codingAgent, "node_modules/@earendil-works/pi-tui"),
  join(tuiWork, "node_modules/@earendil-works/pi-tui"),
  "dir",
);
await jiti.import(join(tuiWork, "index.ts"));
console.log("client-build test passed");
