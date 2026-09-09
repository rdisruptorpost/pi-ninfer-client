/**
 * image-window — keep a conversation usable past the server's media limit.
 *
 * ninfer accepts at most 32 media items per request; beyond that it refuses the
 * whole request and the conversation stops dead. Images are also expensive in
 * context (~1,024 tokens each, so 32 of them is ~18% of a 180k window).
 *
 * This trims the OUTGOING request only: the oldest images are replaced with a
 * short note, while the session file keeps every image, so scrollback and any
 * later fork still have them. The model has usually already described an image
 * in the turn it arrived, so that description survives in the transcript even
 * once the pixels are gone.
 *
 * Hysteresis matters more than it looks. Dropping one image per turn would
 * change the start of the prompt on every turn, and the server's prefix cache
 * keys on an exact prefix -- every turn would re-prefill from scratch. Instead
 * this waits until HIGH images have accumulated and then drops to LOW in one
 * go, so the trimmed history stays byte-identical for many turns and the cache
 * keeps hitting.
 *
 *   /images            show the current policy and count
 *   /images 24 12      set high and low watermarks
 *   PI_IMAGE_WINDOW=0  disable for one run
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

const CONFIG = () => join(getAgentDir(), "image-window.json");

/* Server refuses at 33. Trim at 28 so there is room for a few images to arrive
 * within a single turn, and drop to 16 so the trimmed prefix survives roughly a
 * dozen more turns before the next trim. */
const DEFAULT_HIGH = 28;
const DEFAULT_LOW = 16;

type Policy = { high: number; low: number };

function readPolicy(): Policy {
  let p: Policy = { high: DEFAULT_HIGH, low: DEFAULT_LOW };
  try {
    const raw = JSON.parse(readFileSync(CONFIG(), "utf8"));
    if (typeof raw?.high === "number" && raw.high > 0) p.high = raw.high;
    if (typeof raw?.low === "number" && raw.low > 0) p.low = raw.low;
  } catch {
    /* absent or unreadable: defaults apply */
  }
  if (p.low >= p.high) p.low = Math.max(1, p.high - 1);
  return p;
}

function writePolicy(p: Policy): boolean {
  try {
    writeFileSync(CONFIG(), JSON.stringify(p, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

const isImagePart = (part: any) =>
  part && typeof part === "object" &&
  (part.type === "image_url" || part.type === "image" || part.image_url !== undefined);

/** Every image part in the payload, oldest first. */
function collectImages(messages: any[]): Array<{ msg: number; part: number }> {
  const found: Array<{ msg: number; part: number }> = [];
  messages.forEach((m, mi) => {
    if (!Array.isArray(m?.content)) return;
    m.content.forEach((p: any, pi: number) => {
      if (isImagePart(p)) found.push({ msg: mi, part: pi });
    });
  });
  return found;
}

export function createImageWindow(pi: ExtensionAPI): void {
  let lastNote = "no trim yet";

  /* Extensions see `before_provider_request` in readdir order, which is
   * arbitrary, and each one is handed the previous one's output. Anything that
   * captures the payload before this runs holds the UNTRIMMED version, and
   * replaying it would exceed the server's media limit. Publishing the trim lets
   * such a capture reproduce exactly what was sent, whatever the order.
   * Consumed by fast-compact; see TRIM_KEY there. */
  (globalThis as any)[Symbol.for("image-window.trim")] = (payload: any) =>
    trimPayload(payload);

  function trimPayload(payload: any): any | undefined {
    if (process.env.PI_IMAGE_WINDOW === "0") return undefined;
    if (!payload || !Array.isArray(payload.messages)) return undefined;

    const policy = readPolicy();
    const images = collectImages(payload.messages);
    if (images.length <= policy.high) return undefined;

    const dropCount = images.length - policy.low;
    const doomed = images.slice(0, dropCount);

    // Copy only the messages being altered; everything else keeps its identity,
    // which keeps the untouched tail of the prompt byte-identical.
    const messages = payload.messages.slice();
    const touched = new Map<number, any>();
    for (const { msg, part } of doomed) {
      if (!touched.has(msg)) {
        const original = messages[msg];
        touched.set(msg, { ...original, content: original.content.slice() });
      }
      const copy = touched.get(msg);
      copy.content[part] = {
        type: "text",
        text: "[older image dropped from context to stay within the server's media limit; " +
              "its description earlier in this conversation still applies]",
      };
    }
    for (const [index, replacement] of touched) messages[index] = replacement;

    lastNote = `dropped ${dropCount} of ${images.length}, kept ${policy.low}`;
    return { ...payload, messages };
  }

  pi.on("before_provider_request", (event: any, ctx: any) => {
    const trimmed = trimPayload(event?.payload);
    if (!trimmed) return undefined;
    try {
      ctx?.ui?.notify?.(
        `image-window: ${lastNote}. The session still has every image; only this ` +
        `request was trimmed.`, "info");
    } catch { /* notification must never block the request */ }
    return trimmed;
  });

  pi.registerCommand("images", {
    description: "Show or set the image window (high low)",
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/).filter(Boolean).map(Number);
      if (parts.length === 2 && parts.every((n) => Number.isFinite(n) && n > 0)) {
        const next = { high: parts[0], low: parts[1] };
        if (next.low >= next.high) { ctx?.ui?.notify?.("image-window: low must be below high.", "warning"); return; }
        if (!writePolicy(next)) { ctx?.ui?.notify?.("image-window: could not save.", "warning"); return; }
        ctx?.ui?.notify?.(`image-window: trim at ${next.high}, keep ${next.low}.`, "info");
        return;
      }
      const p = readPolicy();
      ctx?.ui?.notify?.(
        `image-window: trims at ${p.high} images, keeps the newest ${p.low}\n` +
        `   the server refuses any request over 32 media items\n` +
        `   images stay in the session file; only the request is trimmed\n` +
        `   last: ${lastNote}\n` +
        `   usage: /images <high> <low>   ·   PI_IMAGE_WINDOW=0 disables`,
        "info");
    },
  });
}

export default function (pi: ExtensionAPI) {
  createImageWindow(pi);
}
