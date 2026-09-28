import { ControlledResults } from "./controlled-results.ts";

/** Explicitly configured web search; no dependency on the current reasoning model. */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}
export interface SearchResult {
	query: string;
	provider: string;
	retrievedAt: string;
	results: SearchHit[];
	truncated: boolean;
}
export interface SearchOptions {
	enabled: boolean;
	/** Backend id; only providers returned by supportedSearchProviders() are implemented. */
	provider?: "searxng";
	/** Comma-separated base URLs of self-hosted SearXNG instances (no API key); tried in order. */
	searxngUrl?: string;
	maxResults?: number;
	maxResponseBytes?: number;
	timeoutMs?: number;
	/** Total attempt cap across all instances (network errors, timeouts, 429 and 5xx only). */
	maxAttempts?: number;
	/** Total wall-clock budget for retries; no new attempt starts after it expires. */
	retryBudgetMs?: number;
	fetch?: typeof fetch;
}
/** Everything a provider implementation needs; the fetch seam keeps backends replaceable. */
export interface SearchExecution {
	searxngUrls: string[];
	maxResults: number;
	maxResponseBytes: number;
	timeoutMs: number;
	maxAttempts: number;
	retryBudgetMs: number;
	fetch: typeof fetch;
}
/** Transient transport/backend failure; retried against the next instance, never reclassified as data error. */
class TransientSearchError extends Error {}
export interface SearchProvider {
	readonly id: string;
	search(query: string, execution: SearchExecution, signal?: AbortSignal): Promise<SearchResult>;
}
export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function clean(value: unknown, max: number): string {
	return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").slice(0, max) : "";
}
async function limitedJson(response: Response, maxBytes: number): Promise<unknown> {
	if (!response.body) throw new Error("Search returned an empty body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error("Search response exceeds configured byte limit");
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return JSON.parse(text) as unknown;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
function checkQuery(query: string): string {
	if (!query.trim() || query.length > 600 || query.trim().split(/\s+/).length > 75)
		throw new Error("Search query must contain 1-600 characters and at most 75 words");
	return query.trim();
}
/** Shared bounded transport: fixed destination (no redirects), byte cap, timeout, cancellation. */
async function fetchJson(
	endpoint: URL,
	headers: Record<string, string>,
	execution: SearchExecution,
	signal?: AbortSignal,
): Promise<unknown> {
	signal?.throwIfAborted();
	const timeout = AbortSignal.timeout(execution.timeoutMs);
	const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await execution.fetch(endpoint, {
			headers,
			signal: effectiveSignal,
			redirect: "error", // Fixed destination only; never follow to another host.
		});
	} catch (error) {
		signal?.throwIfAborted(); // Caller cancellation is final; only timeouts and network faults retry.
		throw new TransientSearchError(error instanceof Error ? error.message : "Search backend request failed");
	}
	if (!response.ok) {
		await response.body?.cancel();
		const message = `Search backend returned HTTP ${response.status}`; // No key/error-body leakage.
		if (response.status === 429 || response.status >= 500) throw new TransientSearchError(message);
		throw new Error(message);
	}
	const json = await limitedJson(response, execution.maxResponseBytes);
	effectiveSignal.throwIfAborted();
	return json;
}
/** Shared hit mapping; the SearXNG snippet field is "content". */
function collectHits(hits: unknown[], execution: SearchExecution): { results: SearchHit[]; truncated: boolean } {
	const results: SearchHit[] = [];
	let truncated = hits.length > execution.maxResults;
	for (const hit of hits.slice(0, execution.maxResults)) {
		const item = record(hit);
		if (!item || typeof item.url !== "string") throw new Error("Malformed search hit");
		let url: URL;
		try {
			url = new URL(item.url);
		} catch {
			truncated = true;
			continue;
		}
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
			truncated = true;
			continue;
		}
		const title = clean(item.title, 300);
		const snippet = clean(item.content, 2000);
		if (
			(typeof item.title === "string" && item.title.length > 300) ||
			(typeof item.content === "string" && item.content.length > 2000)
		)
			truncated = true;
		results.push({ title, url: url.toString(), snippet });
	}
	return { results, truncated };
}
/** SearXNG (AGPLv3, self-hosted): no API key; every request goes only to the configured instances. */
async function searxngSearch(query: string, execution: SearchExecution, signal?: AbortSignal): Promise<SearchResult> {
	const trimmed = checkQuery(query);
	const endpoints = execution.searxngUrls.map((raw) => {
		let base: URL;
		try {
			base = new URL(raw.trim());
		} catch {
			throw new Error("Missing or invalid PI861_SEARCH_SEARXNG_URL for the searxng backend");
		}
		if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
			throw new Error("Missing or invalid PI861_SEARCH_SEARXNG_URL for the searxng backend");
		const endpoint = new URL("search", base); // Keeps an instance base path; drops its query string.
		endpoint.searchParams.set("q", trimmed);
		endpoint.searchParams.set("format", "json");
		return endpoint;
	});
	// Bounded instance-by-instance failover (hot-update tolerance): transient faults (network error,
	// timeout, 429, 5xx) try the next configured endpoint; format, size and parameter errors fail
	// immediately. Failover only changes the transport endpoint, never the query or its authorization.
	const deadline = Date.now() + execution.retryBudgetMs;
	let lastTransient: unknown;
	for (let attempt = 0; attempt < execution.maxAttempts; attempt++) {
		if (attempt > 0 && Date.now() >= deadline) break;
		const endpoint = endpoints[attempt % endpoints.length];
		if (endpoint === undefined)
			throw new Error("Missing or invalid PI861_SEARCH_SEARXNG_URL for the searxng backend");
		try {
			return await searxngSearchOnce(endpoint, trimmed, execution, signal);
		} catch (error) {
			if (!(error instanceof TransientSearchError)) throw error;
			lastTransient = error;
		}
	}
	throw lastTransient;
}
async function searxngSearchOnce(
	endpoint: URL,
	trimmed: string,
	execution: SearchExecution,
	signal?: AbortSignal,
): Promise<SearchResult> {
	const json = record(await fetchJson(endpoint, { Accept: "application/json" }, execution, signal));
	const hits = json?.results;
	if (hits !== undefined && !Array.isArray(hits)) throw new Error("Malformed search response");
	if (!json || hits === undefined) throw new Error("Search response lacks results");
	const { results, truncated } = collectHits(Array.isArray(hits) ? hits : [], execution);
	return { query: trimmed, provider: "searxng", retrievedAt: new Date().toISOString(), results, truncated };
}
export const searxngSearchProvider: SearchProvider = { id: "searxng", search: searxngSearch };
/** Accurate list of implemented search backends; adding a name here requires an implementation. */
export function supportedSearchProviders(): string[] {
	return ["searxng"];
}
export function resolveSearchProvider(id: string | undefined): SearchProvider {
	if (id === undefined || id === "searxng") return searxngSearchProvider;
	throw new Error(`Unsupported search provider "${id}"; implemented: ${supportedSearchProviders().join(", ")}`);
}
export async function webSearch(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResult> {
	if (!options.enabled) throw new Error("Web search is disabled; configure PI861_WEB_SEARCH_ENABLED=1");
	const searxngUrls = (options.searxngUrl ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (searxngUrls.length === 0) throw new Error("No search backend configured; set PI861_SEARCH_SEARXNG_URL");
	const provider = resolveSearchProvider(options.provider);
	const count = options.maxResults ?? 5;
	const maxBytes = options.maxResponseBytes ?? 262_144;
	const timeoutMs = options.timeoutMs ?? 15_000;
	const maxAttempts = options.maxAttempts ?? Math.max(3, searxngUrls.length); // Default: ~2 retries per fault.
	const retryBudgetMs = options.retryBudgetMs ?? 30_000;
	if (
		!Number.isSafeInteger(count) ||
		count < 1 ||
		count > 10 ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1024 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		!Number.isSafeInteger(maxAttempts) ||
		maxAttempts < 1 ||
		maxAttempts > 10 ||
		!Number.isSafeInteger(retryBudgetMs) ||
		retryBudgetMs < 1
	)
		throw new Error("Invalid search limits");
	return provider.search(
		query,
		{
			searxngUrls,
			maxResults: count,
			maxResponseBytes: maxBytes,
			timeoutMs,
			maxAttempts,
			retryBudgetMs,
			fetch: options.fetch ?? fetch,
		},
		signal,
	);
}
/** Search-side counterpart of webReadOptionsFromEnv; default stays opt-in off (R7.4). */
export function searchOptionsFromEnv(env: Record<string, string | undefined> = process.env): SearchOptions {
	return {
		enabled: env.PI861_WEB_SEARCH_ENABLED === "1",
		searxngUrl: env.PI861_SEARCH_SEARXNG_URL?.trim() || undefined, // Comma-separated instances stay one string.
	};
}

/** Controlled store for oversized search results (R7.7): long payloads become paged references, not inline JSON. */
export const searchResults = new ControlledResults({ maxEntries: 64, maxTotalBytes: 4_194_304, ttlMs: 600_000 });
export function searchPayload(found: SearchResult, maxInlineBytes = 16_000) {
	return searchResults.wrap(found, maxInlineBytes);
}
