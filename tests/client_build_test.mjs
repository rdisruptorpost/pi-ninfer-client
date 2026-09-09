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

const activityWork = join(work, "activity");
cpSync(join(root, "extensions/activity"), activityWork, { recursive: true });
mkdirSync(join(activityWork, "node_modules/@earendil-works"), { recursive: true });
symlinkSync(codingAgent, join(activityWork, "node_modules/@earendil-works/pi-coding-agent"), "dir");
symlinkSync(
  join(codingAgent, "node_modules/@earendil-works/pi-ai"),
  join(activityWork, "node_modules/@earendil-works/pi-ai"),
  "dir",
);
const activityModule = await jiti.import(join(activityWork, "index.ts"));
const providerRegistrations = [];
const activityHandlers = new Map();
activityModule.createActivity({
  on(name, handler) { activityHandlers.set(name, handler); },
  registerProvider(name, config) { providerRegistrations.push({ name, config }); },
});
assert.equal(providerRegistrations.length, 1);
assert.equal(providerRegistrations[0].name, "ninfer-rtx6000");
assert.equal(providerRegistrations[0].config.api, "openai-completions");
assert.equal(typeof providerRegistrations[0].config.streamSimple, "function");

const workingLines = [];
activityHandlers.get("session_start")({}, {
  ui: {
    setWorkingMessage(line) { workingLines.push(line.replace(/\x1b\[[0-9;]*m/g, "")); },
    notify() {},
  },
});
activityHandlers.get("turn_start")({ turnIndex: 1 });

let sentPayload;
const completionId = "chatcmpl-progress-test";
const sse = [
  { id: completionId, model: "qwen3.8-27b", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
  { id: completionId, model: "qwen3.8-27b", choices: [{ index: 0, delta: {}, finish_reason: null }], prompt_progress: { total: 143000, cache: 130000, processed: 130000, time_ms: 0 } },
  { id: completionId, model: "qwen3.8-27b", choices: [{ index: 0, delta: {}, finish_reason: null }], prompt_progress: { total: 143000, cache: 130000, processed: 135000, time_ms: 500 } },
  { id: completionId, model: "qwen3.8-27b", choices: [{ index: 0, delta: {}, finish_reason: null }], prompt_progress: { total: 143000, cache: 130000, processed: 143000, time_ms: 1300 } },
  { id: completionId, model: "qwen3.8-27b", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] },
  { id: completionId, model: "qwen3.8-27b", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  { id: completionId, model: "qwen3.8-27b", choices: [], usage: { prompt_tokens: 143000, completion_tokens: 1, total_tokens: 143001, prompt_tokens_details: { cached_tokens: 130000 } } },
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

const model = {
  id: "qwen3.8-27b",
  name: "Qwen3.8-27B",
  api: "openai-completions",
  provider: "ninfer-rtx6000",
  baseUrl: "http://ninfer.invalid/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 262144,
  maxTokens: 16384,
};
const stream = providerRegistrations[0].config.streamSimple(model, {
  systemPrompt: "",
  messages: [{ role: "user", content: "Say OK", timestamp: Date.now() }],
  tools: [],
}, {
  apiKey: "test-only-key",
  maxTokens: 1,
  onPayload: async (payload) => {
    await activityHandlers.get("before_provider_request")({ payload });
    return payload;
  },
  fetch: async (_input, init) => {
    sentPayload = JSON.parse(String(init?.body));
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  },
});
const streamedEvents = [];
for await (const event of stream) streamedEvents.push(event);
activityHandlers.get("session_shutdown")();

assert.equal(sentPayload.return_progress, true);
assert.ok(workingLines.some((line) => line.includes("5.0k/13k new")));
const doneEvent = streamedEvents.find((event) => event.type === "done");
assert.equal(doneEvent.message.content.find((part) => part.type === "text").text, "OK");
console.log("client-build test passed");
