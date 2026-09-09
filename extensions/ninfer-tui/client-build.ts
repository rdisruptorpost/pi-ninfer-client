import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_CACHE_MS = 15 * 60 * 1000;

export type ClientBuildStatus = "checking" | "current" | "update-available" | "unknown";

export interface ClientBuild {
	repository: string;
	ref: string;
	commit: string;
	remoteCommit?: string;
	status: ClientBuildStatus;
}

interface ClientBuildCache {
	repository: string;
	ref: string;
	commit: string | null;
	checkedAt: number;
}

export interface ClientBuildCheckOptions {
	cachePath?: string;
	maxAgeMs?: number;
	now?: number;
	fetchRemoteCommit?: (repository: string, ref: string) => Promise<string | undefined>;
}

function validBuild(value: unknown): value is { repository: string; ref: string; commit: string } {
	if (!value || typeof value !== "object") return false;
	const build = value as Record<string, unknown>;
	return typeof build.repository === "string"
		&& REPOSITORY_PATTERN.test(build.repository)
		&& typeof build.ref === "string"
		&& build.ref.length > 0
		&& typeof build.commit === "string"
		&& SHA_PATTERN.test(build.commit);
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try { return JSON.parse(readFileSync(path, "utf8")); }
	catch { return undefined; }
}

export function getClientBuildPath(): string {
	return join(getAgentDir(), "client-build.json");
}

export function readInstalledClientBuild(path = getClientBuildPath()): ClientBuild | undefined {
	const value = readJson(path);
	if (!validBuild(value)) return undefined;
	return { ...value, commit: value.commit.toLowerCase(), status: "checking" };
}

export function shortCommit(commit: string): string {
	return SHA_PATTERN.test(commit) ? commit.slice(0, 7).toLowerCase() : "unknown";
}

export function formatClientBuild(build: ClientBuild): string {
	const installed = shortCommit(build.commit);
	switch (build.status) {
		case "current": return `client ${installed} · current`;
		case "update-available": return `client ${installed} · update ${shortCommit(build.remoteCommit ?? "")}`;
		case "unknown": return `client ${installed} · status unavailable`;
		default: return `client ${installed} · checking`;
	}
}

async function fetchGitHubCommit(repository: string, ref: string): Promise<string | undefined> {
	try {
		const response = await fetch(
			`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "pi-ninfer-client",
				},
				signal: AbortSignal.timeout(4_000),
			},
		);
		if (!response.ok) return undefined;
		const value = await response.json() as { sha?: unknown };
		return typeof value.sha === "string" && SHA_PATTERN.test(value.sha)
			? value.sha.toLowerCase()
			: undefined;
	} catch {
		return undefined;
	}
}

function fromRemote(build: ClientBuild, remoteCommit: string): ClientBuild {
	return {
		...build,
		remoteCommit,
		status: remoteCommit.toLowerCase() === build.commit.toLowerCase() ? "current" : "update-available",
	};
}

function writeCache(path: string, build: ClientBuild, commit: string | null, checkedAt: number): void {
	try {
		writeFileSync(path, JSON.stringify({
			repository: build.repository,
			ref: build.ref,
			commit,
			checkedAt,
		}, null, 2) + "\n", "utf8");
	} catch {
		// Update checks are advisory; a read-only agent directory is harmless.
	}
}

export async function checkClientBuild(
	build: ClientBuild,
	options: ClientBuildCheckOptions = {},
): Promise<ClientBuild> {
	const now = options.now ?? Date.now();
	const cachePath = options.cachePath ?? join(getAgentDir(), "client-build-cache.json");
	const cached = readJson(cachePath) as Partial<ClientBuildCache> | undefined;
	if (cached
		&& cached.repository === build.repository
		&& cached.ref === build.ref
		&& typeof cached.checkedAt === "number"
		&& now - cached.checkedAt >= 0
		&& now - cached.checkedAt < (options.maxAgeMs ?? DEFAULT_CACHE_MS)) {
		if (typeof cached.commit === "string" && SHA_PATTERN.test(cached.commit)) {
			return fromRemote(build, cached.commit);
		}
		if (cached.commit === null) return { ...build, status: "unknown" };
	}

	const fetchRemote = options.fetchRemoteCommit ?? fetchGitHubCommit;
	const remoteCommit = await fetchRemote(build.repository, build.ref);
	if (!remoteCommit || !SHA_PATTERN.test(remoteCommit)) {
		writeCache(cachePath, build, null, now);
		return { ...build, status: "unknown" };
	}

	const normalized = remoteCommit.toLowerCase();
	writeCache(cachePath, build, normalized, now);
	return fromRemote(build, normalized);
}
