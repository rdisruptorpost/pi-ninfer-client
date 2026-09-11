import assert from "node:assert/strict";
import {
  createProgressFetch,
  formatPromptProgress,
  parsePromptProgressEvent,
  shouldShowPromptProgress,
} from "../extensions/activity/ninfer-progress.js";
import {
  attachLiveCommandClick,
  compactLiveCommand,
  detachLiveCommandClick,
  formatLiveBashLabel,
  LIVE_COMMAND_URL,
} from "../extensions/activity/live-command.js";
import {
  LiveTokenRate,
  liveRateWindowMs,
} from "../extensions/activity/live-rate.js";

assert.equal(liveRateWindowMs(undefined), 2000);
assert.equal(liveRateWindowMs("250"), 500);
assert.equal(liveRateWindowMs("25000"), 10000);
assert.equal(liveRateWindowMs("invalid"), 2000);

const liveRate = new LiveTokenRate(2000, 300);
liveRate.add(40, 0);
for (let at = 100; at <= 2000; at += 100) liveRate.add(40, at);
assert.equal(liveRate.rate(2000), 100, "steady 100 tok/s stream");
for (let at = 2100; at <= 3000; at += 100) liveRate.add(2, at);
assert.equal(liveRate.rate(3000), 52.5, "window should react midway through a slowdown");
for (let at = 3100; at <= 4000; at += 100) liveRate.add(2, at);
assert.equal(liveRate.rate(4000), 5, "window should fully reflect the slower stream in two seconds");
assert.equal(liveRate.rate(5000), 2.5, "rate should decay while no deltas arrive");
assert.equal(liveRate.rate(6000), 0, "a sustained stall should visibly reach zero");
liveRate.reset();
assert.equal(liveRate.rate(7000), undefined);

const longCommand = "printf '%s\\n' one two three four five six seven eight nine ten eleven twelve";
assert.equal(compactLiveCommand("one\n  two\tthree", 12), "one two thr…");
assert.match(formatLiveBashLabel(longCommand), /^bash · .*…$/);
assert.equal(formatLiveBashLabel("one\ntwo", true), "bash · one\ntwo");
assert.match(formatLiveBashLabel(longCommand, false, true), /click to expand/);
assert.match(formatLiveBashLabel(longCommand, true, true), /click to collapse/);

const opened = [];
let toggles = 0;
const originalOpenUrl = (url) => opened.push(url);
const fullscreenTui = { mode: "fullscreen", openUrl: originalOpenUrl };
const toggle = () => { toggles += 1; };
assert.equal(attachLiveCommandClick(fullscreenTui, toggle), true);
fullscreenTui.openUrl(LIVE_COMMAND_URL);
fullscreenTui.openUrl("https://example.test/docs");
assert.equal(toggles, 1);
assert.deepEqual(opened, ["https://example.test/docs"]);
detachLiveCommandClick(fullscreenTui, toggle);
fullscreenTui.openUrl(LIVE_COMMAND_URL);
fullscreenTui.openUrl("https://example.test/after-detach");
assert.equal(toggles, 1);
assert.deepEqual(opened, ["https://example.test/docs", "https://example.test/after-detach"]);
assert.equal(attachLiveCommandClick({ mode: "regular", openUrl: originalOpenUrl }, toggle), false);

const progressEvent =
  'data: {"choices":[{"delta":{}}],"prompt_progress":' +
  '{"total":143000,"cache":130000,"processed":135000,"time_ms":500}}';
const completeEvent =
  'data: {"choices":[{"delta":{}}],"prompt_progress":' +
  '{"total":143000,"cache":130000,"processed":143000,"time_ms":1300}}';

assert.deepEqual(parsePromptProgressEvent(progressEvent), {
  total: 143000,
  cached: 130000,
  processed: 135000,
  timeMs: 500,
});
assert.equal(parsePromptProgressEvent("data: [DONE]"), undefined);
assert.equal(shouldShowPromptProgress(999), false);
assert.equal(shouldShowPromptProgress(1000), true);
assert.equal(
  parsePromptProgressEvent(
    'data: {"prompt_progress":{"total":10,"cache":8,"processed":7,"time_ms":1}}',
  ),
  undefined,
);

assert.equal(
  formatPromptProgress({ total: 143000, cached: 130000, processed: 135000, timeMs: 500 }),
  "[███░░░░░░░] 5.0k/13k new · 8.0k left · ~0.8s ETA · 130k cached",
);
assert.equal(
  formatPromptProgress({ total: 143000, cached: 143000, processed: 143000, timeMs: 0 }),
  "[██████████] 143k cached",
);

const wire = [
  'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
  progressEvent,
  completeEvent,
  'data: {"choices":[{"delta":{"content":"OK"}}]}',
  "data: [DONE]",
  "",
].join("\r\n\r\n");
const encoded = new TextEncoder().encode(wire);
const splitAtCr = wire.indexOf("\r\n") + 1;
const observed = [];
const baseFetch = async () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(encoded.slice(0, splitAtCr));
    controller.enqueue(encoded.slice(splitAtCr));
    controller.close();
  },
}), { headers: { "content-type": "text/event-stream; charset=utf-8" } });

const monitoredFetch = createProgressFetch(baseFetch, (progress) => observed.push(progress));
const monitoredResponse = await monitoredFetch("http://ninfer.invalid/v1/chat/completions");
assert.equal(await monitoredResponse.text(), wire, "monitor must preserve every response byte");
assert.deepEqual(observed, [
  { total: 143000, cached: 130000, processed: 135000, timeMs: 500 },
  { total: 143000, cached: 130000, processed: 143000, timeMs: 1300 },
]);

const plain = new Response("plain response", { headers: { "content-type": "text/plain" } });
const passthrough = createProgressFetch(async () => plain, () => {
  throw new Error("non-SSE response was inspected");
});
assert.equal(await passthrough("http://ninfer.invalid").then((response) => response.text()), "plain response");

console.log("activity progress test passed");
