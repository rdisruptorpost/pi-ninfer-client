import {
  copyFileSync,
  constants,
  accessSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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
const permissionPackage = process.env.PI_PERMISSION_PACKAGE
  ?? join(homedir(), ".pi/agent/npm/node_modules/@gotgenes/pi-permission-system");
const jitiUrl = pathToFileURL(join(codingAgent, "node_modules/jiti/lib/jiti.mjs")).href;
const { createJiti } = await import(jitiUrl);
const work = mkdtempSync(join(tmpdir(), "command-judge-test-"));

copyFileSync(join(root, "extensions/command-judge/index.ts"), join(work, "index.ts"));
mkdirSync(join(work, "node_modules/@earendil-works"), { recursive: true });
mkdirSync(join(work, "node_modules/@gotgenes"), { recursive: true });
symlinkSync(codingAgent, join(work, "node_modules/@earendil-works/pi-coding-agent"), "dir");
symlinkSync(
  join(codingAgent, "node_modules/@earendil-works/pi-ai"),
  join(work, "node_modules/@earendil-works/pi-ai"),
  "dir",
);
symlinkSync(permissionPackage, join(work, "node_modules/@gotgenes/pi-permission-system"), "dir");

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const serviceApi = await jiti.import(join(permissionPackage, "src/service.ts"));
const judge = await jiti.import(join(work, "index.ts"));
const packageVersion = JSON.parse(readFileSync(join(permissionPackage, "package.json"), "utf8")).version;
const sessionId = `command-judge-test-${packageVersion}`;

let authorize;
const service = {
  registerAuthorizer(name, callback) {
    if (name !== "command-judge") throw new Error(`unexpected authorizer name: ${name}`);
    authorize = callback;
    return () => { authorize = undefined; };
  },
};
if (serviceApi.publishPermissionsService.length >= 2) {
  serviceApi.publishPermissionsService(sessionId, service);
} else {
  serviceApi.publishPermissionsService(service);
}

const eventHandlers = {};
const handlers = {};
const pi = {
  events: { on(event, callback) { (eventHandlers[event] ??= []).push(callback); } },
  on(event, callback) { (handlers[event] ??= []).push(callback); },
};
let calls = 0;
const reviewedBodies = [];
const complete = async (_model, context) => {
  calls++;
  reviewedBodies.push(context.messages[0].content);
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      name: "report_verdict",
      arguments: { verdict: "allow", rationale: "read-only hardware query" },
    }],
  };
};
const registry = {
  find: () => ({ id: "qwen3.8-27b" }),
  getApiKeyAndHeaders: async () => ({ apiKey: "test-only" }),
};
judge.createCommandJudge(pi, { complete, getRegistry: () => registry });
handlers.session_start[0]({}, {
  cwd: join(tmpdir(), "project"),
  model: { provider: "ninfer-rtx6000", id: "qwen3.8-27b" },
  sessionManager: { getSessionId: () => sessionId },
  isProjectTrusted: () => true,
  ui: { notify() {} },
});
for (const ready of eventHandlers[serviceApi.PERMISSIONS_READY_CHANNEL] ?? []) {
  ready(serviceApi.getPermissionsService.length === 0
    ? {}
    : { sessionId, adjudicatesLocally: true });
}

if (typeof authorize !== "function") {
  throw new Error(`judge did not register against permission-system ${packageVersion}`);
}
if (judge.commandReviewLimit() !== 65536) throw new Error("unexpected command review limit");
process.env.PI_JUDGE_MODE = "auto";
const command = "lspci | grep -i display";
const verdict = await authorize({
  toolName: "bash",
  command,
  surface: "bash",
  payload: { evidence: [{ label: "full command", text: command }] },
}, {}, { debug() {}, review() {} });
if (verdict.kind !== "allow" || calls !== 1) {
  throw new Error(`judge path failed: verdict=${verdict.kind}, calls=${calls}`);
}

// A subagent ask is judged by the parent session after forwarding. Current
// permission-system releases preserve command facts in the structured payload
// but deliberately omit the legacy top-level toolName/command convenience
// fields. The judge must read that forwarded shape instead of deferring to a
// manual prompt.
const forwardedCommand = "printf ok > result.txt";
const forwardedVerdict = await authorize({
  requestId: "forwarded-bash-test",
  source: "tool_call",
  agentName: "researcher",
  payload: {
    kind: "bash",
    request: {
      requester: { agentName: "researcher", forwarded: true, sessionId: "child-session" },
      surface: "bash",
      toolName: "bash",
      invokedToolName: null,
      value: "printf ok",
      matchedPattern: "*",
      commandContext: null,
      executedUnit: null,
    },
    evidence: [{ label: "full command", text: forwardedCommand, detail: null }],
    annotations: [],
  },
  surface: "bash",
  value: "printf ok",
  forwarding: { requesterAgentName: "researcher", requesterSessionId: "child-session" },
  accessIntent: { surface: "bash", matchValues: ["printf ok"], boundaryValue: null },
}, {}, { debug() {}, review() {} });
if (forwardedVerdict.kind !== "allow" || calls !== 2) {
  throw new Error(`forwarded judge path failed: verdict=${forwardedVerdict.kind}, calls=${calls}`);
}
if (!String(reviewedBodies.at(-1)).includes(forwardedCommand)) {
  throw new Error("forwarded judge did not review the full command evidence");
}

// Forwarding must not weaken deterministic denials. This also proves the full
// command (rather than the parser's stripped unit) reaches the safety rules.
const forwardedDenied = await authorize({
  requestId: "forwarded-denial-test",
  source: "tool_call",
  agentName: "researcher",
  payload: {
    kind: "bash",
    request: {
      requester: { agentName: "researcher", forwarded: true, sessionId: "child-session" },
      surface: "bash",
      toolName: "bash",
      value: "printf unsafe",
    },
    evidence: [{ label: "full command", text: "printf unsafe >> ~/.bashrc", detail: null }],
    annotations: [],
  },
  forwarding: { requesterAgentName: "researcher", requesterSessionId: "child-session" },
  accessIntent: { surface: "bash", matchValues: ["printf unsafe"], boundaryValue: null },
}, {}, { debug() {}, review() {} });
if (forwardedDenied.kind !== "deny" || calls !== 2) {
  throw new Error(`forwarded denial failed: verdict=${forwardedDenied.kind}, calls=${calls}`);
}

// File tool asks lose the top-level path at the same forwarding boundary. The
// child-fixed access intent is the authoritative structured fallback.
const forwardedWrite = await authorize({
  requestId: "forwarded-write-test",
  source: "tool_call",
  agentName: "writer",
  payload: {
    kind: "tool",
    request: {
      requester: { agentName: "writer", forwarded: true, sessionId: "child-session" },
      surface: "write",
      toolName: "write",
      invokedToolName: null,
      value: "write",
      matchedPattern: "*",
      commandContext: null,
      executedUnit: null,
    },
    evidence: [],
    annotations: [],
  },
  surface: "write",
  value: "write",
  forwarding: { requesterAgentName: "writer", requesterSessionId: "child-session" },
  accessIntent: { surface: "write", matchValues: [join(tmpdir(), "project", "result.txt")], boundaryValue: null },
}, {}, { debug() {}, review() {} });
delete process.env.PI_JUDGE_MODE;
if (forwardedWrite.kind !== "allow" || calls !== 2) {
  throw new Error(`forwarded write path failed: verdict=${forwardedWrite.kind}, calls=${calls}`);
}

if (serviceApi.unpublishPermissionsService.length >= 2) {
  serviceApi.unpublishPermissionsService(sessionId, service);
} else {
  serviceApi.unpublishPermissionsService(service);
}
console.log(`command-judge test passed with permission-system ${packageVersion}`);
