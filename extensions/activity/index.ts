/**
 * activity — make pi say what it is actually doing.
 *
 * Replaces the bare "Working …" with a live description of the current step,
 * and reports timing and throughput when a turn finishes:
 *
 *   working line : ⚙ bash · wc -l f.txt · 3.2s
 *   footer       : turn 4 · 212 tok/s · session avg 198 tok/s · 12.4k tok
 *   turn summary : ⏱ 8.4s · 1,732 tok · 206 tok/s · 3 tool calls
 *
 * Throughput is measured from streaming deltas, so it reflects what the server
 * is actually delivering rather than a figure derived after the fact.
 */

import { appendFileSync } from "node:fs";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { neonBounce, pacmanChase, shimmerOf, shimmerText, type AnimationFn } from "./anim.ts";

type Ui = {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string): void;
  setWorkingMessage?(text: string): void;
};

/* Animated working line. Vendored from pi-animations (MIT). Rolled once per
 * turn, not per frame, so a turn that draws pacman keeps drawing pacman rather
 * than flickering between styles.
 *
 * shimmer is the everyday look: it is pure text plus RGB colour, so it renders
 * identically everywhere. pacman (●) and neon (block elements) are occasional
 * variants and are also safe on a plain Windows console.
 *
 * The pipeline animation was dropped: it draws Font Awesome glyphs from the
 * Unicode private use area (\uf0e7, \uf013, \uf121, \uf0ad, \uf00c), which
 * need a Nerd Font and show as tofu boxes without one. */
const DEFAULT_ANIM: { name: string; fn: AnimationFn } = { name: "shimmer", fn: shimmerText };
const RARE_ANIMS: Array<{ name: string; fn: AnimationFn }> = [
  { name: "pacman", fn: pacmanChase },
  { name: "neon", fn: neonBounce },
];
/* Chance of a rare variant instead of shimmer. 0 pins it to shimmer. */
const ANIM_CHANCE = Number(process.env.PI_ACTIVITY_ANIM_CHANCE ?? "0.2");

const N = (n: number) => n.toLocaleString("en-US");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** One-line summary of what a tool call is about to do. */
function describe(toolName: string, args: any): string {
  const a = args ?? {};
  const clip = (s: unknown, n = 58) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  switch (toolName) {
    case "bash":         return `bash · ${clip(a.command ?? a.cmd)}`;
    case "read":         return `read · ${clip(a.path, 46)}`;
    case "write":        return `write · ${clip(a.path, 46)}`;
    case "edit":         return `edit · ${clip(a.path, 46)}`;
    case "grep":         return `grep · ${clip(a.pattern, 34)}`;
    case "find":         return `find · ${clip(a.pattern ?? a.glob, 34)}`;
    case "ls":           return `ls · ${clip(a.path, 46)}`;
    case "web_search":   return `search · ${clip(a.query ?? a.q, 46)}`;
    case "fetch_content":return `fetch · ${clip(a.url, 46)}`;
    case "source_check": return `verify · ${clip(a.claim ?? a.query, 40)}`;
    case "subagent":     return `spawn ${clip(a.subagent_type, 18)} · ${clip(a.description ?? a.prompt, 34)}`;
    case "get_subagent_result": return "collecting subagent results";
    default:             return `${toolName}${a.path ? " · " + clip(a.path, 40) : ""}`;
  }
}

export function createActivity(pi: ExtensionAPI): void {
  let ui: Ui | undefined;

  // per-turn
  let turnStart = 0;
  let turnIndex = 0;
  let turnChars = 0;          // streamed characters this turn
  let firstDeltaAt = 0;
  let lastDeltaAt = 0;
  let activeMs = 0;           // time spent actually streaming, gaps excluded
  let toolCount = 0;
  let lastSeenLen = new Map<string, number>();

  // per-session
  let sessionTokens = 0;
  let sessionActiveMs = 0;
  let turns = 0;

  // the currently running step
  let stepLabel = "";
  /* What the turn is doing right now, so the working line is never a bare
   * "Thinking" for 20 seconds. The gap between turn_start and the first delta
   * is the server reading the prompt -- at ~3,900 tok/s a 100k context is 25s
   * of silence, which is what that long unexplained pause actually was. */
  let phaseLabel = "reading context";
  /* Measured from the outgoing payload, so the wait can say how much work it is
   * and how fast it is going. The client cannot see the server's progress
   * through prefill, but it knows the size going in and the elapsed time, and
   * their ratio is the number worth reporting when something feels slow. */
  let promptTokens = 0;
  let promptImages = 0;
  let prefillRate = 0;
  let sawReasoning = false;
  let sawContent = false;
  let stepStart = 0;
  let anim: { name: string; fn: AnimationFn } | undefined;
  let animFrame = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;

  // chars/4 is the usual rough token ratio; only used for the LIVE figure,
  // which is replaced by the exact count from usage when the turn ends.
  const estTokens = (chars: number) => Math.max(1, Math.round(chars / 4));

  // Only count time while deltas are arriving. A pi turn can span several
  // server requests, so wall clock includes tool execution and prefill waits --
  // measuring through those understates decode throughput badly (28 tok/s
  // against a server-reported 211).
  const GAP_MAX_MS = 2000;
  const liveRate = () => {
    if (!turnChars || activeMs < 300) return 0;
    return estTokens(turnChars) / (activeMs / 1000);
  };

  const paint = () => {
    if (!ui?.setWorkingMessage) return;
    if (anim) {
      // Keep the numbers that prove liveness; the animation takes the space
      // that is left rather than replacing the information entirely.
      const suffix: string[] = [];
      if (stepStart) suffix.push(secs(Date.now() - stepStart));
      const r0 = liveRate();
      if (r0 > 0) suffix.push(`${Math.round(r0)} tok/s`);
      const tail = suffix.length ? "  " + suffix.join(" · ") : "";
      let label = stepLabel || phaseLabel;
      if (!stepLabel && phaseLabel === "reading context" && promptTokens > 0) {
        // How much there is to read, and how fast it is being read. The rate
        // only appears once the first token lands, because until then there is
        // nothing to divide by.
        const size = promptTokens >= 1000 ? `${(promptTokens / 1000).toFixed(0)}k` : `${promptTokens}`;
        const media = promptImages ? ` + ${promptImages} image${promptImages === 1 ? "" : "s"}` : "";
        const elapsed = stepStart ? (Date.now() - stepStart) / 1000 : 0;
        const sofar = elapsed > 0.5 ? ` · ${Math.round(promptTokens / elapsed / 100) / 10}k tok/s` : "";
        label = `reading ${size} tokens${media}${sofar}`;
      }
      try {
        if (anim.name === "shimmer") {
          // Shimmer the verb only. A shimmering file path or shell command is
          // hard to read, and the moving part is meant to signal liveness, not
          // to decorate the argument.
          const cut = label.indexOf(" · ");
          const frame = animFrame++;
          const painted = cut < 0
            ? shimmerOf(label + "...", frame)
            : `${shimmerOf(label.slice(0, cut), frame)}\x1b[0m\x1b[2m${label.slice(cut)}\x1b[22m`;
          ui.setWorkingMessage(`${painted}\x1b[0m${tail}`);
          return;
        }
        const raw = anim.fn(animFrame++, Math.max(12, 46 - tail.length));
        const frame = Array.isArray(raw) ? raw[0] ?? "" : raw;
        if (!frame) throw new Error("empty frame");
        // pacman and neon are decorative, so the label rides alongside them
        // instead of being replaced by them.
        ui.setWorkingMessage(`${frame}\x1b[0m  ${label}${tail}`);
        return;
      } catch {
        anim = undefined;   // a bad frame must never wedge the working line
      }
    }
    const parts: string[] = [];
    parts.push(`▸ ${stepLabel || phaseLabel}`);
    if (stepStart) parts.push(secs(Date.now() - stepStart));
    const r = liveRate();
    if (r > 0) parts.push(`${Math.round(r)} tok/s`);
    try { ui.setWorkingMessage(parts.join(" · ")); } catch { /* ignore */ }
  };

  const startTicker = () => {
    if (ticker) { clearInterval(ticker); ticker = undefined; }
    // 1s cadence: enough to prove liveness, not enough to churn the terminal.
    ticker = setInterval(paint, anim ? 90 : 1000);
  };
  const stopTicker = () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
  };

  const footer = () => {
    // Off by default: ninfer-tui's themed footer already carries tokens and
    // tok/s, and a second status line pushed the footer to three rows. The
    // two disagree by design -- that one counts input+output+cache across the
    // whole session, this counted generated tokens only -- so showing both
    // invited a comparison that was never meaningful.
    if (process.env.PI_ACTIVITY_FOOTER !== "1") return;
    if (!ui?.setStatus) return;
    const avg = sessionActiveMs > 300 ? sessionTokens / (sessionActiveMs / 1000) : 0;
    const bits = [`turn ${turnIndex}`];
    if (avg > 0) bits.push(`avg ${Math.round(avg)} tok/s`);
    if (sessionTokens) bits.push(`${N(sessionTokens)} tok`);
    const DIM = "\x1b[2m", UNDIM = "\x1b[22m";
    try { ui.setStatus("activity", `${DIM}${bits.join(" · ")}${UNDIM}`); } catch { /* ignore */ }
  };

  // The payload is the exact wire request, so this is the true size the server
  // is about to read -- including any trimming other extensions have applied.
  pi.on("before_provider_request", (event: any) => {
    try {
      const msgs = event?.payload?.messages;
      if (!Array.isArray(msgs)) return undefined;
      let chars = 0, images = 0;
      for (const m of msgs) {
        const c = m?.content;
        if (typeof c === "string") { chars += c.length; continue; }
        if (!Array.isArray(c)) continue;
        for (const part of c) {
          if (typeof part?.text === "string") chars += part.text.length;
          else if (typeof part?.thinking === "string") chars += part.thinking.length;
          else if (part?.type === "image_url" || part?.type === "image" || part?.image_url) images += 1;
        }
      }
      // Images do not live in the text, so add their token cost separately:
      // ~1,024 tokens each once the server has clamped them to 1024x1024.
      promptTokens = estTokens(chars) + images * 1024;
      promptImages = images;
    } catch { /* the working line must never break a request */ }
    return undefined;
  });

  pi.on("session_start", (_e: any, ctx: any) => {
    ui = ctx?.ui;
    footer();
  });

  pi.on("turn_start", (event: any) => {
    turnStart = Date.now();
    turnIndex = (event?.turnIndex ?? turnIndex) + 0;
    turnChars = 0; firstDeltaAt = 0; lastDeltaAt = 0; activeMs = 0; toolCount = 0;
    lastSeenLen = new Map();
    stepLabel = ""; stepStart = Date.now();
    phaseLabel = "reading context"; sawReasoning = false; sawContent = false;
    prefillRate = 0;
    anim = Math.random() < ANIM_CHANCE
      ? RARE_ANIMS[Math.floor(Math.random() * RARE_ANIMS.length)]
      : DEFAULT_ANIM;
    animFrame = 0;
    startTicker(); paint();
  });

  // streaming deltas drive the live rate
  pi.on("message_update", (event: any) => {
    const content = event?.message?.content;
    const id = event?.message?.id ?? "cur";
    let len = 0;
    if (typeof content === "string") len = content.length;
    else if (Array.isArray(content)) {
      for (const c of content) {
        if (typeof c?.text === "string") { len += c.text.length; if (c.text.length) sawContent = true; }
        if (typeof c?.thinking === "string") { len += c.thinking.length; if (c.thinking.length) sawReasoning = true; }
      }
    }
    const prev = lastSeenLen.get(id) ?? 0;
    if (len > prev) {
      const now = Date.now();
      if (!firstDeltaAt) {
        firstDeltaAt = now;
        // Everything before the first token: queue, media prepare, and prefill.
        // Dividing the prompt by it gives the effective read rate.
        const waited = (now - (stepStart || now)) / 1000;
        if (waited > 0.05 && promptTokens > 0) prefillRate = promptTokens / waited;
      }
      else if (lastDeltaAt && now - lastDeltaAt < GAP_MAX_MS) activeMs += now - lastDeltaAt;
      lastDeltaAt = now;
      turnChars += len - prev;
      lastSeenLen.set(id, len);
      if (!stepLabel) phaseLabel = sawContent ? "writing" : sawReasoning ? "thinking" : "generating";
    }
  });

  pi.on("tool_execution_start", (event: any) => {
    toolCount += 1;
    stepLabel = describe(event?.toolName ?? "tool", event?.args);
    phaseLabel = stepLabel;
    stepStart = Date.now();
    paint();
  });

  pi.on("tool_execution_end", (event: any) => {
    const took = stepStart ? secs(Date.now() - stepStart) : "";
    if (event?.isError && ui?.notify) {
      try { ui.notify(`× ${describe(event?.toolName ?? "tool", {})} failed after ${took}`, "warning"); }
      catch { /* ignore */ }
    }
    stepLabel = ""; phaseLabel = "reading context";
    sawReasoning = false; sawContent = false;
    stepStart = Date.now();
    paint();
  });

  pi.on("turn_end", (event: any) => {
    stopTicker();
    const wall = Date.now() - turnStart;
    // exact counts when the provider reports them; estimate only as a fallback
    const u = event?.message?.usage ?? {};
    // pi's usage shape is { input, output, cacheRead, cacheWrite, reasoning,
    // totalTokens, cost }. Generated tokens are output + reasoning: thinking
    // tokens are produced by the model too, and the server counts them.
    const exact =
      typeof u.output === "number" ? u.output + (typeof u.reasoning === "number" ? u.reasoning : 0)
      : (u.outputTokens ?? u.completion_tokens ?? u.output_tokens);
    const out = exact ?? estTokens(turnChars);
    const rate = activeMs > 300 ? out / (activeMs / 1000) : 0;

    sessionTokens += out;
    sessionActiveMs += activeMs;
    turns += 1;

    const bits = [`▸ done in ${secs(wall)}`, `${N(out)} tok`];
    if (rate > 0) bits.push(`${Math.round(rate)} tok/s observed`);
    // The read rate covers queue + media prepare + prefill. A healthy figure at
    // depth is a few thousand tok/s; a sudden collapse is the signal that
    // something in preparation has gone wrong, so it is worth reporting.
    if (prefillRate > 0) {
      const media = promptImages ? `, ${promptImages} img` : "";
      bits.push(`read ${N(Math.round(promptTokens / 1000))}k${media} at ${Math.round(prefillRate)} tok/s`);
    }
    if (toolCount) bits.push(`${toolCount} tool call${toolCount === 1 ? "" : "s"}`);
    const avg = sessionActiveMs > 300 ? sessionTokens / (sessionActiveMs / 1000) : 0;
    if (turns > 1 && avg > 0) bits.push(`session avg ${Math.round(avg)} tok/s`);
    const line = bits.join(" · ");
    try { ui?.notify?.(line, "info"); } catch { /* ignore */ }
    // Optional durable record -- also the only way to see these numbers when
    // running headless (`pi -p`), where notify has no TUI to draw into.
    const logPath = process.env.PI_ACTIVITY_LOG;
    if (logPath) {
      try {
        appendFileSync(logPath, JSON.stringify({
          ts: new Date().toISOString(), turn: turnIndex, wallMs: wall,
          outputTokens: out, tokensExact: exact !== undefined,
          tokensPerSecond: Math.round(rate * 10) / 10,
          toolCalls: toolCount,
          sessionTokens, sessionAvgTokensPerSecond: Math.round(avg * 10) / 10,
        }) + "\n");
      } catch { /* logging must never break a turn */ }
    }
    footer();
  });

  pi.on("session_shutdown", () => { stopTicker(); });
}

export default function (pi: ExtensionAPI) {
  createActivity(pi);
}
