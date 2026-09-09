/**
 * digest — a short summary of each answer, for the reader only.
 *
 * After a turn ends, this asks the local model to condense the reply into a
 * few bullets and appends that as its own transcript entry:
 *
 *   ▸ Digest
 *     - Prefix caching turns repeated prefill from O(P) to O(1) amortized
 *     - 4k-token prefill: ~200ms → ~5–10ms for shared-prefix workloads
 *
 * The agent's own output, system prompt and context are untouched. The digest
 * is a second, independent call that never enters the conversation the model
 * sees, so it cannot change how the model reasons or answers. It is a reading
 * aid, nothing more.
 *
 * Measured on Qwen3.8-27B over six explanation-heavy replies: 453 words in,
 * 67 words out, 0.7s median with thinking off. Thinking on was 7x slower and
 * returned an empty body 1 time in 6, so this always calls with thinking off.
 *
 *   /digest            show state
 *   /digest off|on     toggle (persists to ~/.pi/agent/digest.json)
 *   PI_DIGEST=0        disable for one run, without touching the config
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "digest.summary";
const HEADING = "▸ Digest";
const CONFIG = () => join(getAgentDir(), "digest.json");

/* Only summarise replies long enough for a summary to save reading. Below
 * this the digest would be about as long as the answer. Counted on prose with
 * code fences removed, so a short note wrapped around a long listing is
 * correctly treated as short. */
const MIN_WORDS = 160;

/* This used to be capped low. The server keeps one warm prefix per lane, and
 * lane selection used to send every non-matching request to lane 0, so a digest
 * call evicted whatever conversation was warm there and the next turn paid a
 * full re-prefill -- 25s at 100k context.
 *
 * The lane-affinity patch (see lane-affinity.patch in the project root) makes an
 * unrelated request pick an idle lane instead. Measured after it, same 100k
 * conversation, same digest-sized side call:
 *
 *     next turn penalty  +25.0s  ->  -0.00s
 *
 * So the cap is effectively off. It stays configurable because a stock,
 * unpatched ninfer still has the old behaviour: set PI_DIGEST_MAX_CONTEXT=25000
 * there, or point this client at the patched server. */
const DEFAULT_MAX_CONTEXT_TOKENS = 1_000_000;
const CHARS_PER_TOKEN = 4;   // rough, but only used to pick a side of the limit
const MAX_TARGET_CHARS = 24_000;   // clip runaway replies before sending
const TIMEOUT_MS = 25_000;
// Digests are capped at 90 words. Avoid reserving the main model's full output budget and
// displacing a retained interactive-session prefix for this disposable side request.
const MAX_TOKENS = 2048;

const PROMPT = [
  "Summarise the target for a busy engineer who will read only your summary.",
  "Lead with the answer or the decision, not background.",
  "At most 5 short bullet points, or 3 sentences if bullets do not fit.",
  "Keep every number, name, path, command and caveat that changes a decision.",
  "Drop restatement of the question, preamble, and closing summaries.",
  "Never exceed 90 words.",
  "Output only the summary, with no label or commentary.",
].join("\n");

const words = (t: string) => (t.match(/[A-Za-z0-9'._/-]+/g) ?? []).length;

/** Drop fenced code blocks, so length reflects prose the reader must parse. */
function stripFences(text: string): string {
  const out: string[] = [];
  let fence: { marker: string; len: number } | undefined;
  for (const line of text.split("\n")) {
    if (fence) {
      if (new RegExp(`^\\s*${fence.marker}{${fence.len},}\\s*$`).test(line)) fence = undefined;
      continue;
    }
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m?.[1]) { fence = { marker: m[1][0] === "`" ? "`" : "~", len: m[1].length }; continue; }
    out.push(line);
  }
  return out.join("\n");
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n\n");
}

const hasToolCall = (msg: any) =>
  Array.isArray(msg?.content) && msg.content.some((b: any) => b?.type === "toolCall");

function readConfig(): { enabled: boolean; maxContextTokens: number } {
  let enabled = process.env.PI_DIGEST !== "0";
  let maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS;
  try {
    const raw = JSON.parse(readFileSync(CONFIG(), "utf8"));
    if (raw?.enabled === false) enabled = false;
    if (typeof raw?.maxContextTokens === "number" && raw.maxContextTokens > 0) {
      maxContextTokens = raw.maxContextTokens;
    }
  } catch {
    /* no config, or unreadable: defaults apply */
  }
  const env = Number(process.env.PI_DIGEST_MAX_CONTEXT);
  if (Number.isFinite(env) && env > 0) maxContextTokens = env;
  return { enabled, maxContextTokens };
}

const readEnabled = () => readConfig().enabled;

/** Rough size of the whole conversation, which is what gets re-prefilled. */
function estimateContextTokens(messages: readonly any[]): number {
  let chars = 0;
  for (const m of messages) chars += textOf(m?.content).length;
  return Math.round(chars / CHARS_PER_TOKEN);
}

function writeEnabled(on: boolean): boolean {
  try {
    const { maxContextTokens } = readConfig();
    writeFileSync(CONFIG(), JSON.stringify({ enabled: on, maxContextTokens }, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Lowest thinking level the model actually exposes; "off" whenever possible. */
function thinkingOff(model: any): string | undefined {
  if (!model?.reasoning) return undefined;              // non-reasoning: send nothing
  const map = model.thinkingLevelMap;
  if (!map) return undefined;
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    if (map[level] !== null) return level === "off" ? undefined : level;
  }
  return undefined;
}

export function createDigest(pi: ExtensionAPI): void {
  const done = new Set<string>();
  let warned = false;
  let warnedLarge = false;

  pi.registerEntryRenderer<{ display: string }>(ENTRY_TYPE, (entry, _opts, theme) => {
    const data: any = entry.data;
    if (typeof data?.display !== "string") return undefined;
    const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.bold(HEADING), 0, 0));
    box.addChild(new Markdown(data.display, 0, 1, getMarkdownTheme()));
    return box;
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    const cfg = readConfig();
    if (ctx?.mode !== "tui" || !cfg.enabled) return;

    try {
      const messages = event?.messages ?? [];
      let msg: any;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "assistant") { msg = messages[i]; break; }
      }
      if (!msg || msg.stopReason !== "stop" || hasToolCall(msg)) return;

      const target = textOf(msg.content).trim();
      if (!target) return;

      const originalWords = words(stripFences(target));
      if (originalWords < MIN_WORDS) return;            // short enough to just read

      // Skip once the re-prefill this call would cause outweighs the reading saved.
      const contextTokens = estimateContextTokens(messages);
      if (contextTokens > cfg.maxContextTokens) {
        if (!warnedLarge) {
          warnedLarge = true;
          ctx.ui?.notify?.(
            `digest: paused above ~${cfg.maxContextTokens.toLocaleString()} tokens of context ` +
            `(now ~${contextTokens.toLocaleString()}); a side call here would re-prefill the ` +
            `conversation on your next turn. Raise it with PI_DIGEST_MAX_CONTEXT if you want it anyway.`,
            "info",
          );
        }
        return;
      }

      // De-duplicate against the transcript entry, so a re-render or a second
      // agent_end for the same reply does not summarise it twice.
      const branch = ctx.sessionManager?.getBranch?.() ?? [];
      let key: string | undefined;
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i];
        if (e?.type === "message" && e.message?.role === "assistant" && textOf(e.message.content).trim() === target) {
          key = e.id; break;
        }
      }
      key ??= `${msg.timestamp ?? ""}:${target.length}`;
      if (done.has(key)) return;
      done.add(key);

      const model = ctx.model;
      const provider = ctx.modelRegistry?.getProvider?.(model?.provider);
      if (!model || !provider) return;
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth?.ok) return;

      const clipped = target.length > MAX_TARGET_CHARS ? target.slice(0, MAX_TARGET_CHARS) : target;

      // Own deadline, and still cancels with the turn.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
      const onTurnAbort = () => abort.abort();
      ctx.signal?.addEventListener?.("abort", onTurnAbort, { once: true });

      let reply: any;
      try {
        ctx.ui?.setWorkingMessage?.("summarising…");
        const options: any = {
          signal: abort.signal,
          cacheRetention: "none",       // keep the digest out of the session's prefix cache
          maxTokens: MAX_TOKENS,
          sessionId: ctx.sessionId,
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
        };
        const reasoning = thinkingOff(model);
        if (reasoning) options.reasoning = reasoning;

        const effective = auth.baseUrl === undefined ? model : { ...model, baseUrl: auth.baseUrl };
        reply = await provider.streamSimple(
          effective,
          {
            systemPrompt: PROMPT,
            messages: [{ role: "user", content: `Target:\n${clipped}`, timestamp: 0 }],
            tools: [],
          },
          options,
        ).result();
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener?.("abort", onTurnAbort);
        ctx.ui?.setWorkingMessage?.();
      }

      const summary = textOf(reply?.content).trim();
      if (!summary) return;                                    // empty body: say nothing

      // A "summary" that did not condense is not worth the reader's time.
      if (words(stripFences(summary)) >= originalWords * 0.7) return;

      pi.appendEntry(ENTRY_TYPE, { display: summary });
    } catch {
      if (!warned) {
        warned = true;
        ctx?.ui?.notify?.("digest: could not summarise this reply (further failures are silent).", "warning");
      }
    }
  });

  pi.registerCommand("digest", {
    description: "Toggle the per-answer summary",
    getArgumentCompletions: (prefix: string) => {
      const m = ["on", "off"].filter((c) => c.startsWith(prefix));
      return m.length === 0 ? null : m.map((value) => ({ value, label: value }));
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        const on = arg === "on";
        if (!writeEnabled(on)) { ctx.ui?.notify?.("digest: could not write config.", "warning"); return; }
        const pinned = process.env.PI_DIGEST === "0" ? "  (PI_DIGEST=0 still overrides for this run)" : "";
        ctx.ui?.notify?.(`digest is ${on ? "on" : "off"}.${pinned}`, "info");
        return;
      }
      const c = readConfig();
      ctx.ui?.notify?.(
        `digest is ${c.enabled ? "on" : "off"}\n` +
        `   summarises replies over ${MIN_WORDS} words, using ${ctx.model?.id ?? "the session model"}\n` +
        `   paused above ~${c.maxContextTokens.toLocaleString()} tokens of context, because a side\n` +
        `   call evicts the warm prefix and costs the next turn a re-prefill\n` +
        `   (measured: 0.5s at 5k, 3.4s at 25k, 8.4s at 50k, 25s at 100k)\n` +
        `   the agent's own answer is never modified\n` +
        `   usage: /digest on|off   ·   PI_DIGEST_MAX_CONTEXT=<tokens> to change the limit`,
        "info",
      );
    },
  });
}

export default function (pi: ExtensionAPI) {
  createDigest(pi);
}
