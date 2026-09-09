import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkClientBuild, readInstalledClientBuild, type ClientBuild } from "./client-build.ts";
import { type OpenTuiConfig, DEFAULT_CONFIG, ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
import { installEditor } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { installHeader, type HeaderController } from "./header.ts";
import { emptyGitStatus, readGitStatus } from "./git.ts";
import { readRuntimeInfo } from "./runtime.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { registerSettingsCommand } from "./settings-command.ts";
import { formatTurnTelemetry, TurnTelemetryTracker } from "./telemetry.ts";
import {
	createInitialState,
	getModelMeta,
	invalidateUsageCache,
	type FooterState,
} from "./state.ts";

function isInteractiveLaunch(): boolean {
	if (!process.stdout.isTTY) return false;
	const args = process.argv.slice(2);
	const nonInteractiveFlags = ["-p", "--print", "--help", "-h", "--version", "-v", "--list-models", "--export"];
	for (const arg of args) {
		if (nonInteractiveFlags.includes(arg)) return false;
		if (arg.startsWith("--mode")) return false;
	}
	return true;
}

type PendingUiChange = "install" | "uninstall";

export function getPendingUiChange(enabled: boolean, active: boolean): PendingUiChange | undefined {
	if (enabled === active) return undefined;
	return enabled ? "install" : "uninstall";
}

function clearVisibleScreen(): void {
	if (process.stdout.isTTY) {
		process.stdout.write("\x1b[2J\x1b[H");
	}
}

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	const sessionLifecycle = new SessionLifecycle();
	const state: FooterState = createInitialState();
	const turnTelemetry = new TurnTelemetryTracker();
	let totalGenMs = 0;
	let totalGenTokens = 0;

	let config: OpenTuiConfig = structuredClone(DEFAULT_CONFIG);
	let active = false;
	let lastCtx: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let headerController: HeaderController | undefined;
	let cleanupFooter: (() => void) | undefined;
	let editor: ReturnType<typeof installEditor> | undefined;
	let pendingUiChange: PendingUiChange | undefined;
	let clientBuild: ClientBuild | undefined;

	const getThinkingLevel = () => (sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : "off");

	const applyUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		if (!active) {
			headerController = installHeader(pi, ctx, clientBuild);
			cleanupFooter = installFooter(
				ctx,
				() => state,
				() => config,
				() => getModelMeta(ctx, getThinkingLevel),
				{
					setRequestRender: (fn) => {
						requestFooterRender = fn ?? undefined;
					},
					scheduleGitRefresh: () => {
						void scheduleGitRefresh(ctx);
					},
				},
			);
			editor = installEditor(pi, ctx, config.cursorStyle, config.fullscreen.wheelScrollLines);
			active = true;
		}
	};

	const uninstallUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (active) {
			headerController?.dispose();
			cleanupFooter?.();
			editor?.cleanup();
			headerController = undefined;
			cleanupFooter = undefined;
			editor = undefined;
			requestFooterRender = undefined;
			active = false;
		}
	};

	const scheduleGitRefresh = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const segs = config.footerSegments;
		if (!segs.gitBranch && !segs.gitStatus && !segs.gitCommit) {
			state.git = emptyGitStatus();
			requestFooterRender?.();
			return;
		}
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const git = await readGitStatus(cwd, {
			readCommit: true,
			readTag: segs.gitCommit,
			readCounts: segs.gitStatus,
		});
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.git = git;
		requestFooterRender?.();
	};

	const refreshRuntime = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const runtime = await readRuntimeInfo(cwd);
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.runtime = runtime;
		requestFooterRender?.();
	};

	const refreshInteractiveState = (ctx: ExtensionContext, project = false) => {
		if (!sessionLifecycle.isCurrent() || !ctx.hasUI) return;
		if (project) {
			void scheduleGitRefresh(ctx);
			void refreshRuntime(ctx);
		}
		requestFooterRender?.();
	};

	const startWorkingTimer = () => {
		stopWorkingTimer();
		const tick = () => {
			if (!sessionLifecycle.isCurrent() || !active) return;
			requestFooterRender?.();
		};
		tick();
		workingTimer = setInterval(tick, 250);
		workingTimer.unref?.();
	};

	const stopWorkingTimer = () => {
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionLifecycle.start();
		const generation = sessionLifecycle.currentGeneration();
		lastCtx = ctx;
		state.sessionStartEpoch = Date.now();
		state.workingSince = undefined;
		state.lastDoneIn = undefined;
		invalidateUsageCache();

		ensureConfigExists();
		config = loadConfig((msg, level) => ctx.ui.notify(msg, level));
		clientBuild = readInstalledClientBuild();
		const interactive = isInteractiveLaunch();

		if (interactive && config.enabled) {
			clearVisibleScreen();
		}

		applyUi(ctx);

		refreshInteractiveState(ctx, true);
		if (interactive && clientBuild) {
			void checkClientBuild(clientBuild).then((checked) => {
				if (!sessionLifecycle.isCurrent(generation)) return;
				clientBuild = checked;
				headerController?.setClientBuild(checked);
			});
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionLifecycle.shutdown();
		stopWorkingTimer();
		if (active) {
			uninstallUi(ctx);
		}
		lastCtx = undefined;
	});

	pi.on("agent_start", (event, _ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		state.workingSince = Date.now();
		state.lastDoneIn = undefined;
		startWorkingTimer();
	});

	pi.on("agent_end", (_event, _ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		stopWorkingTimer();
		if (state.workingSince !== undefined) {
			state.lastDoneIn = Date.now() - state.workingSince;
			state.workingSince = undefined;
		}
		requestFooterRender?.();
	});

	pi.on("turn_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_update", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("tool_execution_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("turn_end", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("agent_settled", (event, ctx) => {
		const telemetry = turnTelemetry.handle(event);
		if (telemetry && telemetry.tps !== null && telemetry.generationMs > 0) {
			// Session mean weighted by generation time, so a long turn counts for
			// more than a two-token one -- a plain mean of per-turn rates is
			// dominated by trivial turns.
			state.lastTps = telemetry.tps;
			totalGenMs += telemetry.generationMs;
			totalGenTokens += telemetry.outputTokens;
			state.avgTps = totalGenMs > 0 ? totalGenTokens / (totalGenMs / 1000) : undefined;
		}
		if (telemetry && config.enabled && config.telemetry.enabled && isTuiContext(ctx)) {
			const message = formatTurnTelemetry(telemetry, ctx.ui.theme, config.telemetry, config.icons.mode);
			if (message) ctx.ui.notify(message, "info");
		}
	});

	pi.on("model_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		turnTelemetry.handle(event);
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (newConfig) => {
			const cursorStyleChanged = config.cursorStyle !== newConfig.cursorStyle;
			const wheelScrollLinesChanged = config.fullscreen.wheelScrollLines !== newConfig.fullscreen.wheelScrollLines;
			saveConfig(newConfig);
			config = newConfig;
			if (cursorStyleChanged && active && editor) {
				editor.setCursorStyle(newConfig.cursorStyle);
			}
			if (wheelScrollLinesChanged && active && editor) {
				editor.setWheelScrollLines(newConfig.fullscreen.wheelScrollLines);
			}
			if (lastCtx) {
				pendingUiChange = getPendingUiChange(newConfig.enabled, active);
			}
			const gitNeeded = newConfig.footerSegments.gitBranch || newConfig.footerSegments.gitStatus || newConfig.footerSegments.gitCommit;
			if (lastCtx && gitNeeded) {
				void scheduleGitRefresh(lastCtx);
			} else {
				state.git = emptyGitStatus();
			}
			requestFooterRender?.();
		},
		onOverlayClosed: () => {
			if (!lastCtx || pendingUiChange === undefined) return;
			const change = pendingUiChange;
			pendingUiChange = undefined;
			if (!config.enabled || change === "uninstall") {
				uninstallUi(lastCtx);
			} else {
				applyUi(lastCtx);
			}
		},
	});
}
