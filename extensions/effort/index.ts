/**
 * effort — jump straight to a thinking level.
 *
 *   /effort            show the current level and what this model supports
 *   /effort low        set it
 *   /effort off        disable thinking
 *
 * Shift+Tab already cycles, but reaching a specific level can take four presses.
 * This is one command. It also names the cost, because on this stack the choice
 * is expensive: xhigh measured 5.5x the wall clock of low on an identical task.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const ORDER: Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Short, honest note per level. Empty where there is nothing useful to say. */
const NOTE: Partial<Record<Level, string>> = {
  off: "no thinking — fastest, weakest on hard problems",
  low: "the daily driver",
  medium: "harder problems, still responsive",
  xhigh: "deep reasoning — measured 5.5x the wall clock of low",
};

const ALIASES: Record<string, Level> = {
  none: "off", no: "off", zero: "off",
  min: "minimal", lo: "low", med: "medium", mid: "medium",
  hi: "high", xh: "xhigh", x: "xhigh", maximum: "max",
};

export function createEffort(pi: ExtensionAPI): void {
  // The model's own capability map, e.g.
  //   { off: "none", minimal: null, low: "low", ..., high: null, max: null }
  // A null means the chat template does not expose that level -- asking for it
  // returns 400 from the server, which is exactly the failure that blocks
  // Claude Code. An absent key means the provider default applies.
  let levelMap: Partial<Record<Level, string | null>> | undefined;

  pi.on("session_start", (_e: any, ctx: any) => {
    levelMap = ctx?.model?.thinkingLevelMap ?? undefined;
  });

  const current = (): Level => {
    try { return (pi as any).getThinkingLevel?.() as Level; } catch { return "low"; }
  };

  const supported = (): Level[] => {
    if (!levelMap) return ORDER;                       // unknown: offer everything
    return ORDER.filter((l) => !(l in levelMap) || levelMap[l] !== null);
  };

  const show = (ctx: any, extra?: string) => {
    const now = current();
    const line = supported().map((l) => (l === now ? `[${l}]` : l)).join("  ");
    const note = NOTE[now] ? `\n   ${now}: ${NOTE[now]}` : "";
    ctx.ui?.notify?.(
      `${extra ? extra + "\n" : ""}thinking: ${now}\n   ${line}${note}\n   usage: /effort <level>`,
      "info",
    );
  };

  const apply = (raw: string, ctx: any) => {
    const want = (ALIASES[raw] ?? raw) as Level;
    if (!ORDER.includes(want)) {
      show(ctx, `x "${raw}" is not a thinking level.`);
      return;
    }
    if (!supported().includes(want)) {
      show(ctx, `x "${want}" is not exposed by this model's chat template.`);
      return;
    }
    const before = current();
    try {
      (pi as any).setThinkingLevel?.(want);
    } catch {
      ctx.ui?.notify?.(`x could not set thinking to ${want}`, "error");
      return;
    }
    // Read back rather than trust the write -- pi clamps to model capability.
    const after = current();
    if (after === want) {
      const note = NOTE[after] ? ` - ${NOTE[after]}` : "";
      ctx.ui?.notify?.(
        before === after ? `thinking: already ${after}${note}` : `thinking: ${before} -> ${after}${note}`,
        "info",
      );
    } else {
      show(ctx, `x ${want} was clamped; still ${after}.`);
    }
  };

  const opts = {
    description: "Set thinking level (/effort low|medium|xhigh|off)",
    handler: async (args: string, ctx: any) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (!arg) return show(ctx);
      apply(arg, ctx);
    },
  };

  pi.registerCommand("effort", opts);
}

export default function (pi: ExtensionAPI) {
  createEffort(pi);
}
