import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { GitStatus } from "./git.ts";
import { emptyGitStatus } from "./git.ts";
import type { RuntimeInfo } from "./runtime.ts";
import { fmtTokens, formatProviderLabel } from "./utils.ts";

export interface FooterState {
	git: GitStatus;
	runtime: RuntimeInfo | null;
	sessionStartEpoch: number;
	workingSince: number | undefined;
	lastDoneIn: number | undefined;
	/** Last completed turn's generation rate, tokens/second. */
	lastTps: number | undefined;
	/** Session mean, weighted by generation time rather than turn count. */
	avgTps: number | undefined;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

let usageCache: { key: string; totals: UsageTotals } | undefined;

function entriesKey(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	const last = entries.at(-1);
	return `${entries.length}:${last?.id ?? ""}:${last?.timestamp ?? ""}`;
}

export function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const key = entriesKey(ctx);
	if (usageCache && usageCache.key === key) return usageCache.totals;

	const totals: UsageTotals = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
		latestCacheHitRate: undefined,
	};
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const m = entry.message as AssistantMessage;
			const u = m.usage;
			if (!u) continue;
			totals.input += u.input ?? 0;
			totals.output += u.output ?? 0;
			totals.cacheRead += u.cacheRead ?? 0;
			totals.cacheWrite += u.cacheWrite ?? 0;
			totals.cost += u.cost?.total ?? 0;
			const promptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			if (promptTokens > 0) {
				totals.latestCacheHitRate = ((u.cacheRead ?? 0) / promptTokens) * 100;
			}
		}
	}
	usageCache = { key, totals };
	return totals;
}

export function invalidateUsageCache(): void {
	usageCache = undefined;
}

export function createInitialState(): FooterState {
	return {
		git: emptyGitStatus(),
		runtime: null,
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTps: undefined,
		avgTps: undefined,
	};
}

export interface ModelMeta {
	provider: string;
	model: string;
	effort: string | undefined;
}

export function getModelMeta(
	ctx: ExtensionContext,
	getThinkingLevel: () => string,
): ModelMeta {
	const provider = formatProviderLabel(ctx.model?.provider);
	const model = ctx.model?.name ?? ctx.model?.id ?? "no-model";
	const reasoning = ctx.model?.reasoning ?? false;
	const effort = reasoning ? getThinkingLevel() : undefined;
	return { provider, model, effort };
}
