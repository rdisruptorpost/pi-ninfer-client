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
const complete = async () => {
  calls++;
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
delete process.env.PI_JUDGE_MODE;
if (verdict.kind !== "allow" || calls !== 1) {
  throw new Error(`judge path failed: verdict=${verdict.kind}, calls=${calls}`);
}

if (serviceApi.unpublishPermissionsService.length >= 2) {
  serviceApi.unpublishPermissionsService(sessionId, service);
} else {
  serviceApi.unpublishPermissionsService(service);
}
console.log(`command-judge test passed with permission-system ${packageVersion}`);
