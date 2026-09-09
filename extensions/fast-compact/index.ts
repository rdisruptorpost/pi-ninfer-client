/**
 * fast-compact — compaction that reuses the warm prefix instead of re-reading
 * the whole session.
 *
 * pi's own compactor re-serialises the conversation into one new user message
 * wrapped in <conversation> tags. That is a different prompt from the live one,
 * so the server cannot reuse the cached prefix and every compaction pays a full
 * cold prefill. Measured on a 144k session: 38.5s of prefill out of 42.8s total.
 *
 * This asks the same question as a continuation of the conversation that is
 * already warm, so the prefill collapses:
 *
 *     pi default      38.47s prefill + 4.23s decode = 42.79s
 *     fast-compact     0.66s prefill + 3.83s decode =  4.64s
 *
 * The summary is produced by the same model with pi's own prompt, and pi keeps
 * doing its own cut-point selection and entry surgery -- `firstKeptEntryId` and
 * `tokensBefore` are passed straight back from `preparation`. Only the way the
 * summary text is generated changes.
 *
 * Three things make or break the prefix match, all verified by measurement:
 *   1. the request must carry pi's exact system prompt and tool definitions,
 *      so the captured payload is reused verbatim;
 *   2. it must summarise the FULL live conversation, not just the messages
 *      being cut -- a shorter prompt fails the server's
 *      `checkpoint.frontier <= prompt_tokens` test and falls back to full_reset;
 *   3. nothing else in the payload may change. Altering `reasoning_effort`
 *      alone re-renders the chat template and costs the full prefill again
 *      (measured 0.36s -> 10.30s).
 *
 * If the warm continuation cannot be used, a bounded cold fallback summarises
 * the discarded history in chunks. This matters because pi's stock fallback
 * flattens the entire transcript (including long reasoning blocks) into one
 * request, which can itself be larger than the model's context window.
 *
 *   /fastcompact          show state and the last run
 *   /fastcompact on|off   toggle (persists to ~/.pi/agent/fast-compact.json)
 *   PI_FAST_COMPACT=0     disable for one run
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG = () => join(getAgentDir(), "fast-compact.json");
const TIMEOUT_MS = 180_000;
/* Room the summary needs to be generated in, on top of the conversation itself. */
const MIN_HEADROOM_TOKENS = 6_000;
/* Emergency cold compaction bounds. Long reasoning and tool output are clipped
 * before chunking, so this is normally one call and only pathological sessions
 * need more. */
const COLD_CHUNK_CHARS = 260_000;
const COLD_MAX_TOKENS = 6_144;
const SUMMARY_THINKING_CHARS = 1_500;
const SUMMARY_TOOL_RESULT_CHARS = 2_000;
const SUMMARY_TOOL_ARGS_CHARS = 4_000;

const COLD_SYSTEM_PROMPT =
  "You are a context summarization assistant. Read the supplied transcript part " +
  "and output only the requested structured checkpoint. Never continue the " +
  "conversation and never call tools.";

/* pi's own compaction prompts, copied verbatim from
 * dist/core/compaction/compaction.js so the summary keeps the same shape and
 * the same section headings the rest of pi expects. */
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/* pi normally puts this in a system prompt. We cannot: the live system prompt is
 * part of the cached prefix and must not change, so the instruction rides along
 * with the appended user message instead. */
const NO_CONTINUE =
  "Do NOT continue the conversation and do NOT call any tools. Your only task is " +
  "to write a structured context checkpoint of everything above.\n\n" +
  "Treat the conversation above as the factual record of this session. Report what " +
  "was stated, decided and requested; do not evaluate whether the earlier work was " +
  "correct, do not question whether it really happened, and do not comment on its " +
  "quality. You are transcribing a record, not reviewing it.\n\n" +
  "Cover the WHOLE conversation from its very first message, not just the recent " +
  "turns. Every decision, constraint, preference, bug, blocker, number, file path " +
  "and next step stated anywhere above must appear in the summary, including ones " +
  "mentioned only once and long ago.\n\n" +
  // No word cap, and an explicit single pass. Tuned on real transcript content,
  // because generated sessions are uniform and mislead badly here:
  //   cap 500 words          5/21 probes  (looked best on generated sessions)
  //   no cap, no pass order  0/21 or 13/21 -- reasoning sometimes ate the whole
  //                          budget and returned an empty body
  //   single pass, no cap    truncated at the budget, losing the last sections
  //   single pass + terse   15/21, completes, ~10k chars, same length as pi's own
  // "No deliberation" matters most: it cut thinking from 52,853 to ~8,700 chars.
  // Turning reasoning off outright would be better still, but changing
  // reasoning_effort re-renders the prompt and loses the cached prefix.
  "One short line per item, no elaboration.\n\n" +
  "Make a single pass from the first message to the last, listing each item as " +
  "you reach it. No deliberation.\n\n" +
  "Output only the structured summary described below."

function readConfig(): { enabled: boolean } {
  let enabled = process.env.PI_FAST_COMPACT !== "0";
  try {
    const raw = JSON.parse(readFileSync(CONFIG(), "utf8"));
    if (raw?.enabled === false) enabled = false;
  } catch {
    /* absent or unreadable: on by default */
  }
  return { enabled };
}

function writeEnabled(on: boolean): boolean {
  try {
    writeFileSync(CONFIG(), JSON.stringify({ enabled: on }, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n\n");
}

function clipped(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... ${text.length - limit} characters omitted]`;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? "undefined"; }
  catch { return "[unserializable value]"; }
}

function summaryContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

/* Equivalent in spirit to pi's serializeConversation(), but deliberately caps
 * internal reasoning and bulky tool material. Those are the fields that made a
 * 180k live session expand into a 363k stock-compaction prompt. */
function serializeForSummary(message: any): string {
  if (!message || typeof message !== "object") return "";
  if (message.role === "user") {
    const content = summaryContent(message.content);
    return content ? `[User]: ${content}` : "";
  }
  if (message.role === "assistant") {
    const parts: string[] = [];
    const blocks = Array.isArray(message.content) ? message.content : [];
    const thinking = blocks
      .filter((b: any) => b?.type === "thinking" && typeof b.thinking === "string")
      .map((b: any) => b.thinking)
      .join("\n");
    if (thinking) parts.push(`[Assistant thinking]: ${clipped(thinking, SUMMARY_THINKING_CHARS)}`);
    const answer = blocks
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    if (answer) parts.push(`[Assistant]: ${answer}`);
    const calls = blocks
      .filter((b: any) => b?.type === "toolCall")
      .map((b: any) => `${b.name ?? "tool"}(${clipped(safeJson(b.arguments ?? {}), SUMMARY_TOOL_ARGS_CHARS)})`);
    if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    return parts.join("\n\n");
  }
  if (message.role === "toolResult") {
    const content = summaryContent(message.content);
    return content ? `[Tool result]: ${clipped(content, SUMMARY_TOOL_RESULT_CHARS)}` : "";
  }
  if (message.role === "bashExecution") {
    return `[Bash]: ${message.command ?? ""}\n${clipped(String(message.output ?? ""), SUMMARY_TOOL_RESULT_CHARS)}`;
  }
  if (message.role === "compactionSummary" || message.role === "branchSummary") {
    return `[Prior summary]: ${message.summary ?? ""}`;
  }
  if (message.role === "custom") {
    const content = summaryContent(message.content);
    return content ? `[Context]: ${content}` : "";
  }
  return "";
}

function transcriptChunks(messages: any[]): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current);
    current = "";
  };
  for (const message of messages) {
    let part = serializeForSummary(message).trim();
    if (!part) continue;
    while (part.length > COLD_CHUNK_CHARS) {
      if (current) push();
      chunks.push(part.slice(0, COLD_CHUNK_CHARS));
      part = part.slice(COLD_CHUNK_CHARS);
    }
    if (current && current.length + part.length + 2 > COLD_CHUNK_CHARS) push();
    current += `${current ? "\n\n" : ""}${part}`;
  }
  push();
  return chunks.length ? chunks : ["[No textual transcript content was available.]"];
}

function contextTokensOf(message: any): number | undefined {
  const usage = message?.usage;
  if (!usage) return undefined;
  const total = Number(usage.totalTokens ?? 0);
  if (Number.isFinite(total) && total > 0) return total;
  const calculated = Number(usage.input ?? 0) + Number(usage.output ?? 0) +
    Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
  return Number.isFinite(calculated) && calculated > 0 ? calculated : undefined;
}

/* Recreate the OpenAI assistant message emitted by pi-ai. Capturing the full
 * message (including reasoning_content) is more reliable than keeping only the
 * visible text, especially when a context-capacity stop occurs during thinking. */
function assistantAnchor(message: any): any | undefined {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.trim())
    .map((b: any) => b.text)
    .join("");
  const thinkingBlocks = message.content
    .filter((b: any) => b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim());
  const calls = message.content.filter((b: any) => b?.type === "toolCall");
  if (!text && thinkingBlocks.length === 0 && calls.length === 0) return undefined;

  const anchor: any = { role: "assistant", content: text || null };
  if (thinkingBlocks.length) {
    const signature = thinkingBlocks.find((b: any) =>
      ["reasoning", "reasoning_content", "reasoning_text"].includes(b.thinkingSignature),
    )?.thinkingSignature ?? "reasoning_content";
    anchor[signature] = thinkingBlocks.map((b: any) => b.thinking).join("\n");
  }
  if (calls.length) {
    anchor.tool_calls = calls.map((call: any) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: safeJson(call.arguments ?? {}) },
    }));
  }
  return anchor;
}

function sameAssistant(left: any, right: any): boolean {
  if (left?.role !== "assistant" || right?.role !== "assistant") return false;
  const comparable = (m: any) => ({
    content: m.content ?? null,
    reasoning: m.reasoning,
    reasoning_content: m.reasoning_content,
    reasoning_text: m.reasoning_text,
    tool_calls: m.tool_calls,
  });
  return safeJson(comparable(left)) === safeJson(comparable(right));
}

function combineUsage(first: any, second: any): any {
  if (!first) return second;
  if (!second) return first;
  const cost = (key: string) => Number(first.cost?.[key] ?? 0) + Number(second.cost?.[key] ?? 0);
  return {
    input: Number(first.input ?? 0) + Number(second.input ?? 0),
    output: Number(first.output ?? 0) + Number(second.output ?? 0),
    cacheRead: Number(first.cacheRead ?? 0) + Number(second.cacheRead ?? 0),
    cacheWrite: Number(first.cacheWrite ?? 0) + Number(second.cacheWrite ?? 0),
    totalTokens: Number(first.totalTokens ?? 0) + Number(second.totalTokens ?? 0),
    cost: {
      input: cost("input"), output: cost("output"), cacheRead: cost("cacheRead"),
      cacheWrite: cost("cacheWrite"), total: cost("total"),
    },
  };
}

function fileTracking(prep: any): {
  suffix: string;
  details: { readFiles: string[]; modifiedFiles: string[] };
} {
  const list = (value: any): string[] => {
    if (value instanceof Set) return [...value].filter((v): v is string => typeof v === "string");
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    return [];
  };
  const modified = new Set<string>([
    ...list(prep?.fileOps?.written),
    ...list(prep?.fileOps?.edited),
  ]);
  const modifiedFiles = [...modified].sort();
  const readFiles = list(prep?.fileOps?.read).filter((path) => !modified.has(path)).sort();
  const sections: string[] = [];
  if (readFiles.length) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return {
    suffix: sections.length ? `\n\n${sections.join("\n\n")}` : "",
    details: { readFiles, modifiedFiles },
  };
}

/** pi records usage on the compaction entry; give it a well-formed object. */
function toUsage(u: any) {
  const input = u?.prompt_tokens ?? 0;
  const output = u?.completion_tokens ?? 0;
  const cacheRead = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input, output, cacheRead, cacheWrite: 0,
    totalTokens: u?.total_tokens ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function createFastCompact(pi: ExtensionAPI): void {
  let lastPayload: any;
  let lastAnchor: any;
  let lastContextTokens: number | undefined;
  let last = "not run yet";
  let warned = false;

  // Capture the exact request pi sends, so the summarisation call can reuse the
  // same system prompt, tools and sampling fields. Returning undefined leaves
  // the outgoing payload untouched.
  pi.on("before_provider_request", (event: any) => {
    const p = event?.payload;
    if (p && Array.isArray(p.messages) && p.messages.length > 0) {
      lastPayload = p;
      // The next completed assistant message belongs to this payload. Do not
      // accidentally pair it with an anchor from an earlier provider call.
      lastAnchor = undefined;
      lastContextTokens = undefined;
    }
    return undefined;
  });

  const captureAssistant = (message: any) => {
    const anchor = assistantAnchor(message);
    if (anchor) lastAnchor = anchor;
    const tokens = contextTokensOf(message);
    if (tokens) lastContextTokens = tokens;
  };

  // message_end is the authoritative finalized message and gives us provider
  // usage. agent_end remains a compatibility fallback for older pi builds.
  pi.on("message_end", (event: any) => {
    if (event?.message?.role === "assistant") captureAssistant(event.message);
    return undefined;
  });
  pi.on("agent_end", (event: any) => {
    const msgs = event?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "assistant") { captureAssistant(msgs[i]); break; }
    }
    return undefined;
  });

  /* A decline is not an error -- pi's own compactor still runs and the session
   * is fine -- but it is invisible, and an invisible decline is indistinguishable
   * from a slow compaction. Announce each distinct reason once per session so the
   * cost has a stated cause; /fastcompact still shows the most recent one. */
  const announced = new Set<string>();
  const decline = (ctx: any, reason: string) => {
    last = `skipped: ${reason}`;
    if (!announced.has(reason)) {
      announced.add(reason);
      ctx?.ui?.notify?.(`fast-compact: using pi's compaction this time (${reason}).`, "info");
    }
    return undefined;
  };

  const coldCompaction = async (event: any, ctx: any, reason: string) => {
    const prep = event.preparation;
    const model = ctx.model;
    const provider = ctx.modelRegistry?.getProvider?.(model?.provider);
    if (!model || !provider) return decline(ctx, `${reason}; no provider for safe fallback`);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok) return decline(ctx, `${reason}; no credentials for safe fallback`);

    const discarded = [
      ...(Array.isArray(prep.messagesToSummarize) ? prep.messagesToSummarize : []),
      ...(Array.isArray(prep.turnPrefixMessages) ? prep.turnPrefixMessages : []),
    ];
    const chunks = transcriptChunks(discarded);
    let checkpoint = typeof prep.previousSummary === "string" ? prep.previousSummary.trim() : "";
    let usage: any;
    const effective = auth.baseUrl === undefined ? model : { ...model, baseUrl: auth.baseUrl };
    const started = Date.now();

    try {
      for (let i = 0; i < chunks.length; i++) {
        const updating = Boolean(checkpoint);
        const instructions = updating ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
        const previous = updating
          ? `\n\n<previous-summary>\n${checkpoint}\n</previous-summary>`
          : "";
        const focus = event.customInstructions
          ? `\n\nAdditional focus: ${event.customInstructions}`
          : "";
        const prompt =
          `<conversation-part index="${i + 1}" total="${chunks.length}">\n${chunks[i]}\n` +
          `</conversation-part>${previous}\n\nThis is chronological part ${i + 1} of ${chunks.length}. ` +
          `Incorporate it into the checkpoint; keep earlier checkpoint facts that this part does not change.\n\n` +
          `${instructions}${focus}`;

        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
        const onAbort = () => abort.abort();
        event.signal?.addEventListener?.("abort", onAbort, { once: true });
        let reply: any;
        try {
          ctx.ui?.setWorkingMessage?.(
            chunks.length === 1 ? "compacting (bounded fallback)…" :
              `compacting (bounded fallback ${i + 1}/${chunks.length})…`,
          );
          reply = await provider.streamSimple(
            effective,
            {
              systemPrompt: COLD_SYSTEM_PROMPT,
              messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
              tools: [],
            },
            {
              signal: abort.signal,
              cacheRetention: "none",
              maxTokens: COLD_MAX_TOKENS,
              reasoning: "off",
              sessionId: `${ctx.sessionId ?? "compaction"}:cold:${Date.now()}:${i}`,
              apiKey: auth.apiKey,
              headers: auth.headers,
              env: auth.env,
            },
          ).result();
        } finally {
          clearTimeout(timer);
          event.signal?.removeEventListener?.("abort", onAbort);
        }
        if (reply?.stopReason === "error") {
          throw new Error(reply.errorMessage || `fallback part ${i + 1} failed`);
        }
        const next = textOf(reply?.content).trim();
        if (next.length < 200) throw new Error(`fallback part ${i + 1} returned an empty/short summary`);
        checkpoint = next;
        usage = combineUsage(usage, reply?.usage);
      }
    } finally {
      ctx.ui?.setWorkingMessage?.();
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const tracking = fileTracking(prep);
    last = `${secs}s bounded fallback (${chunks.length} part${chunks.length === 1 ? "" : "s"})`;
    ctx.ui?.notify?.(
      `fast-compact: recovered with bounded fallback in ${secs}s ` +
      `(${chunks.length} part${chunks.length === 1 ? "" : "s"}; ${reason})`,
      "info",
    );
    return {
      compaction: {
        summary: checkpoint + tracking.suffix,
        firstKeptEntryId: prep.firstKeptEntryId,
        tokensBefore: prep.tokensBefore,
        usage,
        details: tracking.details,
      },
    };
  };

  const safeFallback = async (event: any, ctx: any, reason: string) => {
    try {
      return await coldCompaction(event, ctx, reason);
    } catch (err) {
      last = `bounded fallback failed: ${err instanceof Error ? err.message : String(err)}`;
      ctx?.ui?.notify?.(
        `fast-compact: bounded fallback failed (${last}); trying pi's compactor.`,
        "warning",
      );
      return undefined;
    }
  };

  pi.on("session_before_compact", async (event: any, ctx: any) => {
    if (!readConfig().enabled) { return undefined; }

    const prep = event?.preparation;
    if (!prep?.firstKeptEntryId) { last = "skipped: pi supplied no cut point"; return undefined; }
    // Split turns need no special handling here. pi splits its summary in two
    // because it only summarises the messages being discarded, so a turn cut in
    // half loses the half it keeps. This summarises the whole live conversation,
    // which is what makes the prefix reusable, so the prefix of a split turn is
    // already covered and pi's cut point still applies unchanged.
    if (!lastPayload) { return safeFallback(event, ctx, "no captured request yet"); }

    // The server's checkpoint sits after the completed assistant response, so the
    // request only reuses the cache if it reproduces that response. With no reply
    // anchor to append we cannot, and the request would re-prefill the WHOLE
    // conversation -- which is larger than the slice pi would have summarised, so
    // conversation. Use the bounded cold path instead.
    if (!lastAnchor) { return safeFallback(event, ctx, "the last turn produced no replayable anchor"); }

    // Appending to the live conversation only works if there is still room to
    // generate the summary inside the context window. Normally there is: pi
    // compacts at contextWindow - reserveTokens, so ~reserveTokens is free. But
    // overflow recovery can fire with the window essentially full, and then the
    // request would return finish_reason=length with an empty body after paying
    // for the prefill. Check first and use the bounded cold path for those.
    const window = ctx.model?.contextWindow ?? 0;
    // Pi's preparation estimate can be stale after image trimming or overflow
    // recovery. Provider usage belongs to the exact payload+anchor we will replay.
    const currentTokens = lastContextTokens ?? prep.tokensBefore ?? 0;
    const headroom = window - currentTokens;
    if (window > 0 && headroom < MIN_HEADROOM_TOKENS) {
      return safeFallback(event, ctx, `only ${headroom.toLocaleString()} measured tokens of headroom`);
    }

    const started = Date.now();
    try {
      const ask = prep.previousSummary
        ? `${NO_CONTINUE}\n\n<previous-summary>\n${prep.previousSummary}\n</previous-summary>\n\n${UPDATE_SUMMARIZATION_PROMPT}`
        : `${NO_CONTINUE}\n\n${SUMMARIZATION_PROMPT}`;
      const extra = event.customInstructions
        ? `${ask}\n\nAdditional focus: ${event.customInstructions}`
        : ask;

      // Only the message list changes. Every other field is passed through, because
      // altering any of them re-renders the prompt and loses the cached prefix.
      // The captured payload may predate image-window's trim, because extensions
      // see before_provider_request in readdir order and nothing guarantees ours
      // runs last. Replaying the untrimmed payload would exceed the server's
      // media limit and diverge from the prefix the server actually cached, so
      // apply the same trim it applied. No-op when there are few enough images.
      const trim = (globalThis as any)[Symbol.for("image-window.trim")];
      const basePayload = (typeof trim === "function" ? trim(lastPayload) : undefined) ?? lastPayload;
      const body: any = { ...basePayload };
      // Only append the reply when the captured payload does not already end with
      // it. A turn that made tool calls issues several requests, and the last one
      // can already include the assistant message we tracked.
      const tailMsg = basePayload.messages[basePayload.messages.length - 1];
      const alreadyThere = sameAssistant(tailMsg, lastAnchor);
      const tail = !alreadyThere ? [lastAnchor] : [];
      body.messages = [...basePayload.messages, ...tail, { role: "user", content: extra }];
      body.stream = false;
      delete body.stream_options;
      const reserve = prep.settings?.reserveTokens ?? 32768;
      const modelBudget = Number(ctx.model?.maxTokens ?? 0) > 0
        ? Number(ctx.model.maxTokens)
        : Number.MAX_SAFE_INTEGER;
      const budget = Math.max(512, Math.min(
        Math.floor(0.8 * reserve),
        modelBudget,
        headroom > 0 ? headroom - 1024 : Number.MAX_SAFE_INTEGER,
      ));
      delete body.max_tokens;
      body.max_completion_tokens = budget;

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth?.ok) { last = "skipped: no credentials"; return undefined; }
      const base = String(auth.baseUrl ?? ctx.model?.baseUrl ?? "").replace(/\/+$/, "");
      if (!base) { last = "skipped: no base url"; return undefined; }

      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
      const onAbort = () => abort.abort();
      event.signal?.addEventListener?.("abort", onAbort, { once: true });
      let json: any;
      try {
        ctx.ui?.setWorkingMessage?.("compacting (warm)…");
        const res = await fetch(`${base}/chat/completions`, {
          method: "POST",
          signal: abort.signal,
          headers: {
            "Content-Type": "application/json",
            ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}),
            ...(auth.headers ?? {}),
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          return safeFallback(event, ctx, `warm request returned HTTP ${res.status}`);
        }
        json = await res.json();
      } finally {
        clearTimeout(timer);
        event.signal?.removeEventListener?.("abort", onAbort);
        ctx.ui?.setWorkingMessage?.();
      }

      const msg = json?.choices?.[0]?.message;
      if (msg?.tool_calls?.length) return safeFallback(event, ctx, "warm summary called a tool");
      const summaryBody = textOf(msg?.content).trim();
      // A summary far shorter than a section header means something went wrong;
      // The bounded compactor is safer than accepting a truncated checkpoint.
      if (summaryBody.length < 200) {
        const why = json?.choices?.[0]?.finish_reason === "length" ? "hit the output limit" : "summary too short";
        return safeFallback(event, ctx, `warm summary ${why}`);
      }
      const tracking = fileTracking(prep);
      const summary = summaryBody + tracking.suffix;
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      last = `${secs}s, ${summary.length.toLocaleString()} chars`;
      ctx.ui?.notify?.(`fast-compact: summarised in ${secs}s (warm prefix)`, "info");

      return {
        compaction: {
          summary,
          // pi's own cut point and accounting, passed straight through.
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
          usage: toUsage(json?.usage),
          details: tracking.details,
        },
      };
    } catch (err) {
      last = `fell back: ${err instanceof Error ? err.message : String(err)}`;
      if (!warned) {
        warned = true;
        ctx?.ui?.notify?.("fast-compact: warm path failed; using the bounded fallback.", "warning");
      }
      return safeFallback(event, ctx, last);
    }
  });

  // Once pi has compacted, the captured payload describes the session as it was
  // before the cut. Reusing it on a later compaction would summarise a
  // conversation that no longer exists, so drop it and wait for a fresh turn.
  pi.on("session_compact", () => {
    lastPayload = undefined;
    lastAnchor = undefined;
    lastContextTokens = undefined;
    return undefined;
  });

  pi.registerCommand("fastcompact", {
    description: "Toggle warm-prefix compaction",
    getArgumentCompletions: (prefix: string) => {
      const m = ["on", "off"].filter((c) => c.startsWith(prefix));
      return m.length === 0 ? null : m.map((value) => ({ value, label: value }));
    },
    handler: async (args: string, ctx: any) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        if (!writeEnabled(arg === "on")) { ctx.ui?.notify?.("fast-compact: could not write config.", "warning"); return; }
        ctx.ui?.notify?.(`fast-compact is ${arg}.`, "info");
        return;
      }
      ctx.ui?.notify?.(
        `fast-compact is ${readConfig().enabled ? "on" : "off"}\n` +
        `   summarises as a continuation of the warm conversation instead of\n` +
        `   re-reading it cold (measured 42.8s -> 4.6s on a 144k session)\n` +
        `   pi still chooses the cut point; only the summary call changes\n` +
        `   uses a bounded cold fallback when the warm prefix is unavailable\n` +
        `   last run: ${last}\n` +
        `   usage: /fastcompact on|off`,
        "info",
      );
    },
  });
}

export default function (pi: ExtensionAPI) {
  createFastCompact(pi);
}
