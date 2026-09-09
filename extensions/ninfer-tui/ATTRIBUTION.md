# ninfer-tui

A fork of [pi-open-tui](https://github.com/OldSuns/pi-open-tui) by OldSuns (MIT,
`LICENSE.upstream`), modified for a self-hosted NInfer server.

## What changed

The upstream footer and header show a running **USD cost**, which is meaningless
against a model on your own GPU — it is always `$0.000`. That segment is replaced
by **throughput**: last-turn tokens/second and the session average.

Upstream already computes this. `telemetry.ts` tracks `tps`, `ttftMs`,
`generationMs` and `stallMs` per turn, and excludes stalls from the rate, so the
figure reflects real generation speed rather than wall clock. The fork surfaces
that number in the footer instead of discarding it.

Everything else is upstream: the animated header, git segments, runtime
detection, rounded editor, and extension-status lines (which is how the
`activity` extension's line continues to render).
