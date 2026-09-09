/**
 * Observe NInfer's opt-in prompt_progress SSE extension without changing the
 * byte stream consumed by pi-ai's OpenAI adapter.
 */

const MAX_EVENT_BUFFER = 1024 * 1024;

function finiteInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Return a validated NInfer prompt-progress observation from one SSE event. */
export function parsePromptProgressEvent(rawEvent) {
  const data = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]" || !data.includes('"prompt_progress"')) return undefined;

  try {
    const payload = JSON.parse(data);
    const value = payload?.prompt_progress;
    const total = finiteInteger(value?.total);
    const cached = finiteInteger(value?.cache);
    const processed = finiteInteger(value?.processed);
    const timeMs = finiteInteger(value?.time_ms);
    if (
      total === undefined || cached === undefined || processed === undefined || timeMs === undefined ||
      cached > processed || processed > total
    ) return undefined;
    return { total, cached, processed, timeMs };
  } catch {
    return undefined;
  }
}

/**
 * Wrap fetch for the NInfer provider. The original Uint8Array is enqueued
 * before the monitoring work, and parsing failures never affect generation.
 */
export function createProgressFetch(baseFetch, onProgress) {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.toLowerCase().includes("text/event-stream")) return response;

    const decoder = new TextDecoder();
    let buffer = "";
    let monitoring = true;
    const inspect = (text) => {
      // Normalize after concatenation so a CR/LF pair split across transport
      // chunks still becomes one newline.
      buffer = `${buffer}${text}`.replace(/\r\n/g, "\n");
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const rawEvent = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const progress = parsePromptProgressEvent(rawEvent);
        if (progress) {
          try { onProgress(progress); } catch { /* UI telemetry must not break the response. */ }
          // Prompt progress completes before the first model delta. Stop
          // decoding here so generated output takes only the pass-through path.
          if (progress.processed === progress.total) {
            monitoring = false;
            buffer = "";
            return;
          }
        }
        split = buffer.indexOf("\n\n");
      }
      // A malformed/non-SSE response must not retain arbitrary output forever.
      if (buffer.length > MAX_EVENT_BUFFER) buffer = buffer.slice(-MAX_EVENT_BUFFER);
    };

    const monitored = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        if (!monitoring) return;
        try { inspect(decoder.decode(chunk, { stream: true })); } catch { /* pass through */ }
      },
      flush() {
        if (!monitoring) return;
        try {
          inspect(decoder.decode());
          const progress = parsePromptProgressEvent(buffer);
          if (progress) onProgress(progress);
        } catch { /* pass through */ }
      },
    }));

    return new Response(monitored, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export function compactTokens(tokens) {
  if (tokens >= 100000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 10000) return `${(tokens / 1000).toFixed(0)}k`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

/** Keep detailed progress out of sight for prompts that finish immediately. */
export function shouldShowPromptProgress(elapsedMs, delayMs = 1000) {
  return elapsedMs >= Math.max(0, delayMs);
}

/** Format exact non-cached prefill progress for the one-line activity UI. */
export function formatPromptProgress(progress, width = 10) {
  const totalWork = progress.total - progress.cached;
  const doneWork = progress.processed - progress.cached;
  const remaining = progress.total - progress.processed;
  const ratio = totalWork === 0 ? 1 : Math.min(1, doneWork / totalWork);
  const filled = ratio >= 1 ? width : Math.min(width - 1, Math.floor(ratio * width));
  const bar = `${"█".repeat(Math.max(0, filled))}${"░".repeat(Math.max(0, width - filled))}`;

  if (totalWork === 0) return `[${bar}] ${compactTokens(progress.total)} cached`;

  const bits = [
    `[${bar}] ${compactTokens(doneWork)}/${compactTokens(totalWork)}${progress.cached ? " new" : ""}`,
  ];
  if (remaining > 0) bits.push(`${compactTokens(remaining)} left`);
  if (doneWork > 0 && remaining > 0 && progress.timeMs > 0) {
    const etaMs = progress.timeMs * remaining / doneWork;
    const eta = etaMs >= 9500 ? `${Math.round(etaMs / 1000)}s` : `${(etaMs / 1000).toFixed(1)}s`;
    bits.push(`~${eta} ETA`);
  }
  if (progress.cached) bits.push(`${compactTokens(progress.cached)} cached`);
  return bits.join(" · ");
}
