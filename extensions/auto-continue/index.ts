/**
 * auto-continue — resume a reply that hit the output limit.
 *
 * A long answer can exhaust maxTokens mid-sentence; pi then prints "Response was
 * truncated before completion" and waits. Typing "continue" works, but it is
 * manual and the wording matters: a bare "continue" often makes the model
 * restart its explanation or repeat the last paragraph.
 *
 * This detects `stopReason === "length"` and sends one continuation itself,
 * with an instruction that tells the model where it actually is.
 *
 * Guarded deliberately:
 *  - at most MAX_CHAIN consecutive resumes, so a reply that keeps hitting the
 *    limit cannot loop forever burning tokens unattended;
 *  - the counter resets whenever a turn ends normally;
 *  - every resume is announced, so an unattended chain is visible afterwards.
 *
 *   /continue            show state
 *   /continue on|off     toggle (persists)
 *   /continue 5          set the chain limit
 *   PI_AUTO_CONTINUE=0   disable for one run
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG = () => join(getAgentDir(), "auto-continue.json");
const DEFAULT_MAX_CHAIN = 3;
/* Up to a second, checked every 5ms, for the queued resume to become visible. */
const QUEUE_WAIT_TICKS = 200;
const QUEUE_WAIT_MS = 5;

/* Naming where it stopped matters more than the word "continue": without this
 * the model tends to re-introduce the answer or repeat the last paragraph. */
const RESUME =
  "Your previous message stopped because it reached the output token limit, " +
  "not because it was finished. Resume from the exact point it stopped. " +
  "Do not repeat any text you already wrote, do not restart or re-introduce " +
  "the answer, and do not summarise what you have written so far. If you were " +
  "inside a code block, continue inside that same code block.";

type Config = { enabled: boolean; maxChain: number };

function readConfig(): Config {
  let cfg: Config = { enabled: process.env.PI_AUTO_CONTINUE !== "0", maxChain: DEFAULT_MAX_CHAIN };
  try {
    const raw = JSON.parse(readFileSync(CONFIG(), "utf8"));
    if (raw?.enabled === false) cfg.enabled = false;
    if (typeof raw?.maxChain === "number" && raw.maxChain > 0) cfg.maxChain = raw.maxChain;
  } catch {
    /* absent or unreadable: defaults apply */
  }
  if (process.env.PI_AUTO_CONTINUE === "0") cfg.enabled = false;
  return cfg;
}

function writeConfig(cfg: Config): boolean {
  try {
    writeFileSync(CONFIG(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export function createAutoContinue(pi: ExtensionAPI): void {
  let chain = 0;
  let last = "nothing resumed yet";

  pi.on("agent_end", async (event: any, ctx: any) => {
    if (ctx?.mode !== "tui") return undefined;
    const cfg = readConfig();
    if (!cfg.enabled) return undefined;

    const msgs = event?.messages ?? [];
    let final: any;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "assistant") { final = msgs[i]; break; }
    }
    // Only an output-limit stop. An aborted turn is the user's decision, and an
    // errored one should surface rather than be papered over with a retry.
    if (final?.stopReason !== "length") {
      chain = 0;
      return undefined;
    }

    if (chain >= cfg.maxChain) {
      last = `stopped after ${chain} resumes`;
      ctx?.ui?.notify?.(
        `auto-continue: stopping after ${chain} consecutive resumes. Type "continue" to go on, ` +
        `or raise the limit with /continue ${cfg.maxChain + 2}.`, "warning");
      chain = 0;
      return undefined;
    }

    // Something is already queued -- the user typed while the reply was running.
    // That message continues the run on its own, and it is a better continuation
    // than a generic resume, so stay out of the way.
    if (ctx?.hasPendingMessages?.()) {
      last = "skipped, a message was already queued";
      chain = 0;
      return undefined;
    }

    chain += 1;
    last = `resumed ${chain}/${cfg.maxChain}`;
    ctx?.ui?.notify?.(`auto-continue: reply hit the output limit — resuming (${chain}/${cfg.maxChain})`, "info");
    try {
      pi.sendUserMessage(RESUME, { deliverAs: "followUp" });
    } catch (err) {
      chain = 0;
      ctx?.ui?.notify?.(
        `auto-continue: could not resume automatically (${err instanceof Error ? err.message : String(err)}). ` +
        `Type "continue".`, "warning");
      return undefined;
    }

    // sendUserMessage is fire-and-forget and queues asynchronously, but the loop
    // checks for queued messages as soon as this handler returns. Without waiting
    // for the message to actually land, that is a race: lose it and the run ends
    // with the resume sitting unsent in the queue. Extension handlers are awaited,
    // so blocking here is what holds the loop open.
    for (let i = 0; i < QUEUE_WAIT_TICKS && !ctx?.hasPendingMessages?.(); i++) {
      await new Promise((resolve) => setTimeout(resolve, QUEUE_WAIT_MS));
    }
    if (!ctx?.hasPendingMessages?.()) {
      chain = 0;
      last = "queueing the resume timed out";
      ctx?.ui?.notify?.('auto-continue: the resume did not queue in time. Type "continue".', "warning");
    }
    return undefined;
  });

  pi.registerCommand("continue", {
    description: "Auto-resume replies that hit the output limit",
    getArgumentCompletions: (prefix: string) => {
      const m = ["on", "off"].filter((c) => c.startsWith(prefix));
      return m.length === 0 ? null : m.map((value) => ({ value, label: value }));
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      const cfg = readConfig();
      if (arg === "on" || arg === "off") {
        cfg.enabled = arg === "on";
        if (!writeConfig(cfg)) { ctx?.ui?.notify?.("auto-continue: could not save.", "warning"); return; }
        ctx?.ui?.notify?.(`auto-continue is ${arg}.`, "info");
        return;
      }
      const n = Number(arg);
      if (Number.isFinite(n) && n > 0) {
        cfg.maxChain = Math.floor(n);
        if (!writeConfig(cfg)) { ctx?.ui?.notify?.("auto-continue: could not save.", "warning"); return; }
        ctx?.ui?.notify?.(`auto-continue: up to ${cfg.maxChain} consecutive resumes.`, "info");
        return;
      }
      ctx?.ui?.notify?.(
        `auto-continue is ${cfg.enabled ? "on" : "off"}\n` +
        `   resumes a reply that stopped at the output limit, up to ${cfg.maxChain} times in a row\n` +
        `   the counter resets as soon as a turn finishes normally\n` +
        `   last: ${last}\n` +
        `   usage: /continue on|off  ·  /continue <max>  ·  PI_AUTO_CONTINUE=0`,
        "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  createAutoContinue(pi);
}
