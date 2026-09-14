import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";

/**
 * activity publishes the final OpenAI request here after all Pi payload hooks
 * and after its own `return_progress` field have been applied. Keeping the bus
 * on Symbol.for lets independently-loaded extension modules share it without a
 * filesystem dependency between their install directories.
 */
export const CONTEXT_PAYLOAD_LISTENERS = Symbol.for("pi-ninfer.context-payload-listeners");

type ViewMode = "live" | "diff";
type Marker = " " | "+" | "-" | "=";
type Tone = "system" | "user" | "assistant" | "thinking" | "tool" | "muted" | "add" | "remove" | "keep";

export interface InspectorBlock {
	marker: Marker;
	label: string;
	text: string;
	tone: Tone;
}

export interface PayloadStats {
	messages: number;
	tools: number;
	images: number;
	textChars: number;
	estimatedTokens: number;
}

type WireCapture = {
	payload: any;
	capturedAt: number;
};

type CompactionSnapshot = {
	reason: string;
	tokensBefore: number;
	previousSummary?: string;
	replacedMessages: any[];
	keptMessages: any[];
	summary?: string;
	firstKeptEntryId?: string;
	capturedAt: number;
};

type PendingCompaction = Omit<CompactionSnapshot, "summary" | "capturedAt">;

const toneColor: Record<Tone, ThemeColor> = {
	system: "accent",
	user: "mdLink",
	assistant: "success",
	thinking: "dim",
	tool: "warning",
	muted: "muted",
	add: "success",
	remove: "error",
	keep: "accent",
};

function safeText(value: unknown): string {
	const text = typeof value === "string" ? value : String(value ?? "");
	return stripTerminalSequences(text)
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
}

function mediaPlaceholder(value: string): string | undefined {
	if (!value.startsWith("data:")) return undefined;
	const comma = value.indexOf(",");
	const header = comma === -1 ? value.slice(0, 80) : value.slice(0, comma);
	if (!/^data:(?:image|audio|video)\//i.test(header)) return undefined;
	return `[${header.slice(5).replace(/;base64$/i, "")} media · ${value.length.toLocaleString()} encoded chars]`;
}

function displayValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return mediaPlaceholder(value) ?? safeText(value);
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => displayValue(item, seen));
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		result[key] = displayValue(item, seen);
	}
	return result;
}

function safeJson(value: unknown, pretty = true): string {
	try {
		return JSON.stringify(displayValue(value), null, pretty ? 2 : 0) ?? "undefined";
	} catch {
		return "[unserializable value]";
	}
}

function imagePart(part: any): boolean {
	return Boolean(part && typeof part === "object" && (
		part.type === "image" || part.type === "image_url" || part.image_url !== undefined ||
		(typeof part.url === "string" && part.url.startsWith("data:image/"))
	));
}

function imageDescription(part: any): string {
	if (typeof part?.data === "string") {
		const mime = safeText(part.mimeType ?? "image/unknown");
		return `[${mime} media · ${part.data.length.toLocaleString()} encoded chars]`;
	}
	const candidate = typeof part?.image_url === "string"
		? part.image_url
		: typeof part?.image_url?.url === "string"
			? part.image_url.url
			: typeof part?.url === "string"
				? part.url
				: "";
	return mediaPlaceholder(candidate) ?? `[image${part?.mimeType ? ` · ${safeText(part.mimeType)}` : ""}]`;
}

function textFromContent(content: unknown): { text: string; images: string[] } {
	if (typeof content === "string") return { text: safeText(content), images: [] };
	if (!Array.isArray(content)) {
		return content === null || content === undefined
			? { text: "", images: [] }
			: { text: safeJson(content), images: [] };
	}
	const text: string[] = [];
	const images: string[] = [];
	for (const part of content) {
		if (imagePart(part)) {
			images.push(imageDescription(part));
		} else if (typeof part === "string") {
			text.push(safeText(part));
		} else if (part?.type === "thinking" || part?.type === "toolCall") {
			// Rendered separately with its own role/tone by pushMessageBlocks().
			continue;
		} else if (typeof part?.text === "string") {
			text.push(safeText(part.text));
		} else if (part !== undefined) {
			text.push(safeJson(part));
		}
	}
	return { text: text.join("\n"), images };
}

function pushMessageBlocks(blocks: InspectorBlock[], message: any, marker: Marker = " ", forcedTone?: Tone): void {
	if (!message || typeof message !== "object") return;
	const role = safeText(message.role ?? "message");
	const baseTone: Tone = forcedTone ?? (
		role === "system" ? "system" :
		role === "user" ? "user" :
		role === "assistant" ? "assistant" :
		role === "tool" || role === "toolResult" || role === "bashExecution" ? "tool" : "muted"
	);

	for (const field of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
		if (typeof message[field] === "string" && message[field].length > 0) {
			blocks.push({ marker, label: `[${role} · ${field}]`, text: safeText(message[field]), tone: forcedTone ?? "thinking" });
		}
	}
	if (Array.isArray(message.content)) {
		const thinking = message.content
			.filter((part: any) => part?.type === "thinking" && typeof part.thinking === "string")
			.map((part: any) => safeText(part.thinking))
			.join("\n");
		if (thinking) blocks.push({ marker, label: `[${role} · thinking]`, text: thinking, tone: forcedTone ?? "thinking" });
	}

	const content = textFromContent(message.content);
	if (content.text || content.images.length > 0) {
		blocks.push({
			marker,
			label: `[${role}${message.name ? ` · ${safeText(message.name)}` : ""}]`,
			text: [content.text, ...content.images].filter(Boolean).join("\n"),
			tone: baseTone,
		});
	}

	const calls = Array.isArray(message.tool_calls)
		? message.tool_calls
		: Array.isArray(message.content)
			? message.content.filter((part: any) => part?.type === "toolCall")
			: [];
	for (const call of calls) {
		const fn = call?.function ?? call;
		const name = safeText(fn?.name ?? call?.name ?? "tool");
		const args = fn?.arguments ?? call?.arguments ?? {};
		blocks.push({ marker, label: `[assistant · tool call · ${name}]`, text: typeof args === "string" ? safeText(args) : safeJson(args), tone: forcedTone ?? "tool" });
	}

	if (role === "bashExecution") {
		blocks.push({ marker, label: "[bash · command]", text: safeText(message.command ?? ""), tone: baseTone });
		if (message.output) blocks.push({ marker, label: "[bash · output]", text: safeText(message.output), tone: baseTone });
	}
	if (blocks.length === 0 || blocks.at(-1)?.label !== `[${role}]`) {
		if (message.summary && typeof message.summary === "string") {
			blocks.push({ marker, label: `[${role} · summary]`, text: safeText(message.summary), tone: baseTone });
		}
	}
}

export function payloadStats(payload: any): PayloadStats {
	const messages = Array.isArray(payload?.messages) ? payload.messages : [];
	const tools = Array.isArray(payload?.tools) ? payload.tools : [];
	let images = 0;
	let textChars = 0;
	const count = (value: unknown, key = "") => {
		if (typeof value === "string") {
			if (mediaPlaceholder(value) || key === "image_url") images += 1;
			else textChars += value.length;
			return;
		}
		if (!value || typeof value !== "object") return;
		if (imagePart(value) && key !== "messages") {
			images += 1;
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) count(item, key);
			return;
		}
		for (const [childKey, item] of Object.entries(value)) count(item, childKey);
	};
	count(messages, "messages");
	count(tools, "tools");
	return {
		messages: messages.length,
		tools: tools.length,
		images,
		textChars,
		estimatedTokens: Math.ceil(textChars / 4) + images * 1024,
	};
}

export function payloadBlocks(payload: any): InspectorBlock[] {
	const blocks: InspectorBlock[] = [];
	const tools = Array.isArray(payload?.tools) ? payload.tools : [];
	for (const tool of tools) {
		const fn = tool?.function ?? tool;
		blocks.push({
			marker: " ",
			label: `[tool definition · ${safeText(fn?.name ?? "tool")}]`,
			text: safeJson(tool),
			tone: "system",
		});
	}
	for (const message of Array.isArray(payload?.messages) ? payload.messages : []) {
		pushMessageBlocks(blocks, message);
	}
	return blocks;
}

function entryMessages(entries: any[]): any[] {
	const messages: any[] = [];
	for (const entry of entries) {
		if (entry?.type === "message" && entry.message) messages.push(entry.message);
		else if (entry?.type === "custom_message") messages.push({ role: "context", content: entry.content });
		else if (entry?.type === "branch_summary") messages.push({ role: "branchSummary", summary: entry.summary });
	}
	return messages;
}

function keptMessages(branchEntries: any[], firstKeptEntryId: string): any[] {
	const index = branchEntries.findIndex((entry) => entry?.id === firstKeptEntryId);
	return index < 0 ? [] : entryMessages(branchEntries.slice(index));
}

export function compactionBlocks(snapshot: CompactionSnapshot | undefined): InspectorBlock[] {
	if (!snapshot) return [];
	const blocks: InspectorBlock[] = [];
	if (snapshot.summary) {
		blocks.push({ marker: "+", label: "[generated compaction summary]", text: safeText(snapshot.summary), tone: "add" });
	}
	if (snapshot.previousSummary) {
		blocks.push({ marker: "-", label: "[previous summary incorporated]", text: safeText(snapshot.previousSummary), tone: "remove" });
	}
	for (const message of snapshot.replacedMessages) pushMessageBlocks(blocks, message, "-", "remove");
	for (const message of snapshot.keptMessages) pushMessageBlocks(blocks, message, "=", "keep");
	return blocks;
}

function restoredCompaction(ctx: ExtensionContext): CompactionSnapshot | undefined {
	const branch = ctx.sessionManager.getBranch();
	let currentIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") { currentIndex = i; break; }
	}
	if (currentIndex < 0) return undefined;
	const current: any = branch[currentIndex];
	const keptIndex = branch.findIndex((entry) => entry?.id === current.firstKeptEntryId);
	let previousIndex = -1;
	for (let i = currentIndex - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") { previousIndex = i; break; }
	}
	const previous: any = previousIndex >= 0 ? branch[previousIndex] : undefined;
	const previousKeptIndex = previous
		? branch.findIndex((entry) => entry?.id === previous.firstKeptEntryId)
		: 0;
	const sourceStart = previousKeptIndex >= 0 ? previousKeptIndex : 0;
	return {
		reason: "restored",
		tokensBefore: Number(current.tokensBefore ?? 0),
		previousSummary: typeof previous?.summary === "string" ? previous.summary : undefined,
		replacedMessages: keptIndex >= 0 ? entryMessages(branch.slice(sourceStart, keptIndex)) : [],
		keptMessages: keptIndex >= 0 ? entryMessages(branch.slice(keptIndex, currentIndex)) : [],
		summary: typeof current.summary === "string" ? current.summary : "",
		firstKeptEntryId: current.firstKeptEntryId,
		capturedAt: Date.parse(current.timestamp) || Date.now(),
	};
}

function shortTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
	if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	return Math.max(0, Math.round(value)).toLocaleString();
}

function wrapBlock(block: InspectorBlock, width: number, theme: Theme): string[] {
	const marker = block.marker === " " ? "  " : `${block.marker} `;
	const available = Math.max(1, width - visibleWidth(marker));
	const color = toneColor[block.tone];
	const result: string[] = [];
	const add = (text: string, label = false) => {
		const wrapped = wrapTextWithAnsi(text || " ", available);
		for (const line of wrapped.length ? wrapped : [""]) {
			result.push(theme.fg(color, marker + (label ? theme.bold(line) : line)));
		}
	};
	add(block.label, true);
	for (const line of safeText(block.text).split("\n")) add(line);
	result.push("");
	return result;
}

class ContextInspectorPanel implements Component {
	focused = false;
	private scrollTop = 0;
	private followEnd = false;
	private contentWidth = 40;
	private cache?: { key: string; lines: string[] };

	constructor(
		private readonly controller: ContextInspectorController,
		private readonly tui: TUI,
		private readonly theme: Theme,
	) {}

	invalidate(): void {
		this.cache = undefined;
	}

	resetScroll(followEnd = false): void {
		this.followEnd = followEnd;
		this.scrollTop = followEnd ? Number.MAX_SAFE_INTEGER : 0;
		this.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.controller.unfocus();
			return;
		}
		if (matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
			this.controller.hide();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
			this.controller.setMode(this.controller.mode === "live" ? "diff" : "live");
			return;
		}
		if (matchesKey(data, "up")) this.scrollBy(-1);
		else if (matchesKey(data, "down")) this.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(-Math.max(1, this.viewportRows() - 2));
		else if (matchesKey(data, "pageDown")) this.scrollBy(Math.max(1, this.viewportRows() - 2));
		else if (matchesKey(data, "home") || data === "g") this.scrollTo(0, false);
		else if (matchesKey(data, "end") || data === "G") this.scrollTo(Number.MAX_SAFE_INTEGER, true);
	}

	private viewportRows(): number {
		return Math.max(3, this.tui.terminal.rows - 8);
	}

	private maxScroll(): number {
		const lines = this.cachedLines(this.contentWidth);
		return Math.max(0, lines.length - this.viewportRows());
	}

	private scrollBy(lines: number): void {
		this.scrollTo(this.scrollTop + lines, false);
	}

	private scrollTo(value: number, followEnd: boolean): void {
		this.followEnd = followEnd;
		this.scrollTop = Math.max(0, Math.min(this.maxScroll(), value));
		this.tui.requestRender();
	}

	private cachedLines(width: number): string[] {
		const key = `${this.controller.revision}:${this.controller.mode}:${width}`;
		if (this.cache?.key === key) return this.cache.lines;
		const blocks = this.controller.mode === "live"
			? payloadBlocks(this.controller.wire?.payload)
			: compactionBlocks(this.controller.compaction);
		const lines = blocks.length
			? blocks.flatMap((block) => wrapBlock(block, width, this.theme))
			: [this.theme.fg("muted", this.controller.mode === "live"
				? "  No provider request captured yet. Send a message first."
				: "  No compaction has been observed in this session yet.")];
		this.cache = { key, lines };
		return lines;
	}

	private fill(text: string, width: number): string {
		const truncated = truncateToWidth(text, Math.max(0, width), "…", true);
		return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 2);
		this.contentWidth = Math.max(1, inner - 2);
		const border = (text: string) => this.theme.fg(this.focused ? "accent" : "border", text);
		const line = (content: string) => `${border("│")}${this.fill(content, inner)}${border("│")}`;
		const all = this.cachedLines(this.contentWidth);
		const bodyRows = this.viewportRows();
		const maxScroll = Math.max(0, all.length - bodyRows);
		if (this.followEnd) this.scrollTop = maxScroll;
		else this.scrollTop = Math.min(this.scrollTop, maxScroll);
		const below = Math.max(0, maxScroll - this.scrollTop);

		const modeLabel = this.controller.mode === "live" ? "LIVE WIRE CONTEXT" : "COMPACTION DIFF";
		const tabs = this.controller.mode === "live"
			? `${this.theme.fg("accent", "[live]")}  diff`
			: `live  ${this.theme.fg("accent", "[diff]")}`;
		const stats = this.controller.statusLine();
		const scroll = all.length > bodyRows ? ` ↑${this.scrollTop} ↓${below}` : "";
		const output = [
			border(`╭${"─".repeat(inner)}╮`),
			line(` ${this.theme.bold(modeLabel)}${scroll}`),
			line(` ${tabs}  ${this.theme.fg("dim", stats)}`),
			line(this.theme.fg("dim", " Tab view · ↑↓/Pg scroll · Esc return · q close")),
			border(`├${"─".repeat(inner)}┤`),
		];
		const visible = all.slice(this.scrollTop, this.scrollTop + bodyRows);
		for (const content of visible) output.push(line(` ${content}`));
		for (let i = visible.length; i < bodyRows; i++) output.push(line(""));
		output.push(border(`╰${"─".repeat(inner)}╯`));
		return output;
	}
}

export class ContextInspectorController {
	mode: ViewMode = "live";
	revision = 0;
	wire: WireCapture | undefined;
	compaction: CompactionSnapshot | undefined;

	private ctx: ExtensionContext | undefined;
	private overlay: OverlayHandle | undefined;
	private overlayTui: TUI | undefined;
	private panel: ContextInspectorPanel | undefined;
	private pending: PendingCompaction | undefined;
	private readonly listener = (capture: WireCapture) => {
		if (!capture?.payload || !this.ctx) return;
		this.wire = capture;
		this.changed();
	};

	constructor(
		private readonly getTui: () => TUI | undefined,
		private readonly getEditor: () => Component | undefined,
	) {}

	start(ctx: ExtensionContext): void {
		this.stop();
		this.ctx = ctx;
		this.wire = undefined;
		this.compaction = restoredCompaction(ctx);
		this.pending = undefined;
		const global = globalThis as Record<symbol, unknown>;
		let listeners = global[CONTEXT_PAYLOAD_LISTENERS];
		if (!(listeners instanceof Set)) {
			listeners = new Set<(capture: WireCapture) => void>();
			global[CONTEXT_PAYLOAD_LISTENERS] = listeners;
		}
		(listeners as Set<(capture: WireCapture) => void>).add(this.listener);
		this.changed();
	}

	branchChanged(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.wire = undefined;
		this.compaction = restoredCompaction(ctx);
		this.pending = undefined;
		this.mode = this.compaction ? "diff" : "live";
		this.panel?.resetScroll(this.mode === "live");
		this.changed();
	}

	stop(): void {
		const listeners = (globalThis as Record<symbol, unknown>)[CONTEXT_PAYLOAD_LISTENERS];
		if (listeners instanceof Set) listeners.delete(this.listener);
		this.hide();
		this.ctx = undefined;
		this.pending = undefined;
	}

	beforeCompact(event: any): void {
		const prep = event?.preparation;
		if (!prep) return;
		this.pending = {
			reason: safeText(event.reason ?? "unknown"),
			tokensBefore: Number(prep.tokensBefore ?? 0),
			previousSummary: typeof prep.previousSummary === "string" ? prep.previousSummary : undefined,
			replacedMessages: [
				...(Array.isArray(prep.messagesToSummarize) ? prep.messagesToSummarize : []),
				...(Array.isArray(prep.turnPrefixMessages) ? prep.turnPrefixMessages : []),
			],
			keptMessages: keptMessages(
				Array.isArray(event.branchEntries) ? event.branchEntries : [],
				String(prep.firstKeptEntryId ?? ""),
			),
			firstKeptEntryId: prep.firstKeptEntryId,
		};
	}

	afterCompact(event: any): void {
		const entry = event?.compactionEntry;
		const pending = this.pending;
		this.compaction = {
			reason: safeText(event?.reason ?? pending?.reason ?? "unknown"),
			tokensBefore: Number(entry?.tokensBefore ?? pending?.tokensBefore ?? 0),
			previousSummary: pending?.previousSummary,
			replacedMessages: pending?.replacedMessages ?? [],
			keptMessages: pending?.keptMessages ?? [],
			summary: typeof entry?.summary === "string" ? entry.summary : "",
			firstKeptEntryId: entry?.firstKeptEntryId ?? pending?.firstKeptEntryId,
			capturedAt: Date.now(),
		};
		this.pending = undefined;
		// The last captured request describes the pre-compaction context. Wait for
		// the next real provider request rather than labelling it as current.
		this.wire = undefined;
		this.mode = "diff";
		this.panel?.resetScroll(false);
		this.changed();
	}

	setMode(mode: ViewMode): void {
		this.mode = mode;
		this.panel?.resetScroll(mode === "live");
		this.changed();
	}

	open(mode?: ViewMode): boolean {
		if (mode) this.mode = mode;
		const tui = this.getTui();
		if (!tui || !this.ctx) return false;
		if (!this.overlay || this.overlayTui !== tui) {
			this.hide();
			this.overlayTui = tui;
			this.panel = new ContextInspectorPanel(this, tui, this.ctx.ui.theme);
			this.panel.resetScroll(this.mode === "live");
			const wide = tui.terminal.columns >= 105;
			this.overlay = tui.showOverlay(this.panel, {
				anchor: wide ? "right-center" : "center",
				width: wide ? "46%" : "94%",
				minWidth: Math.max(12, Math.min(48, tui.terminal.columns - 4)),
				maxHeight: "100%",
				margin: 1,
				nonCapturing: true,
			});
		}
		this.overlay.focus();
		tui.requestRender();
		return true;
	}

	unfocus(): void {
		if (!this.overlay) return;
		this.overlay.unfocus({ target: this.getEditor() ?? null });
		this.overlayTui?.requestRender();
	}

	hide(): void {
		this.overlay?.hide();
		this.overlay = undefined;
		this.overlayTui = undefined;
		this.panel = undefined;
	}

	isVisible(): boolean {
		return Boolean(this.overlay && !this.overlay.isHidden());
	}

	statusLine(): string {
		if (this.mode === "live") {
			const stats = payloadStats(this.wire?.payload);
			return `${stats.messages} msg · ${stats.tools} tools · ${stats.images} images · ~${shortTokens(stats.estimatedTokens)} tok`;
		}
		const snapshot = this.compaction;
		if (!snapshot) return "no compaction yet";
		const summaryTokens = Math.ceil((snapshot.summary?.length ?? 0) / 4);
		return `${snapshot.reason} · ${shortTokens(snapshot.tokensBefore)} before · +~${shortTokens(summaryTokens)} tok · −${snapshot.replacedMessages.length} =${snapshot.keptMessages.length}`;
	}

	private changed(): void {
		this.revision += 1;
		this.panel?.invalidate();
		this.overlayTui?.requestRender();
	}
}

export function createContextInspector(
	pi: ExtensionAPI,
	getTui: () => TUI | undefined,
	getEditor: () => Component | undefined,
): ContextInspectorController {
	const controller = new ContextInspectorController(getTui, getEditor);
	pi.registerCommand("context", {
		description: "Inspect the exact model context and latest compaction diff",
		getArgumentCompletions: (prefix: string) => {
			const values = ["live", "diff", "off"].filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return values.length ? values.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const command = args.trim().toLowerCase();
			if (command === "off") {
				controller.hide();
				return;
			}
			if (command && command !== "live" && command !== "diff") {
				ctx.ui.notify("usage: /context [live|diff|off]", "warning");
				return;
			}
			if (!controller.open(command === "diff" ? "diff" : command === "live" ? "live" : undefined)) {
				ctx.ui.notify("context inspector requires the interactive terminal UI", "warning");
			}
		},
	});
	return controller;
}
