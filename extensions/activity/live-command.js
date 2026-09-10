/** Internal OSC 8 target used only by Pi's fullscreen mouse handler. */
export const LIVE_COMMAND_URL = "pi://activity/live-command";

const OPEN = `\x1b]8;;${LIVE_COMMAND_URL}\x1b\\`;
const CLOSE = "\x1b]8;;\x1b\\";
const HOOK = Symbol.for("pi.activity.live-command-url-hook");

function commandText(command) {
  return String(command ?? "").trim();
}

/** Compact whitespace only in the preview; expanded mode preserves the command. */
export function compactLiveCommand(command, maxChars = 58) {
  const text = commandText(command).replace(/\s+/g, " ");
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + "…";
}

/** Build the activity label, optionally making the command an internal link. */
export function formatLiveBashLabel(command, expanded = false, clickable = false) {
  const text = expanded ? commandText(command) : compactLiveCommand(command);
  if (!clickable || !text) return `bash · ${text}`;
  const linked = `${OPEN}\x1b[4m${text}\x1b[24m  ` +
    `\x1b[2m(click to ${expanded ? "collapse" : "expand"})\x1b[22m${CLOSE}`;
  return `bash · ${linked}`;
}

function hookState(tui) {
  const state = tui?.[HOOK];
  return state && typeof state === "object" ? state : undefined;
}

/**
 * Intercept the private link while preserving Pi's normal URL opener.
 *
 * Pi 0.84's fullscreen TUI recognizes OSC 8 links during its own mouse
 * selection pass, but does not expose component click callbacks. This small
 * pass-through adapter uses that supported link path and ignores regular mode.
 */
export function attachLiveCommandClick(tui, onToggle) {
  if (tui?.mode !== "fullscreen" || typeof tui.openUrl !== "function") return false;

  let state = hookState(tui);
  if (!state) {
    const original = tui.openUrl;
    const handlers = new Set();
    const wrapper = function (url) {
      if (url === LIVE_COMMAND_URL) {
        for (const handler of handlers) handler();
        return;
      }
      return original.call(this, url);
    };
    state = { handlers };
    tui[HOOK] = state;
    tui.openUrl = wrapper;
  }
  state.handlers.add(onToggle);
  return true;
}

/** Remove this extension's callback; the empty adapter remains a pass-through. */
export function detachLiveCommandClick(tui, onToggle) {
  const state = hookState(tui);
  if (!state) return;
  state.handlers.delete(onToggle);
}
