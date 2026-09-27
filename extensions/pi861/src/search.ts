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
	provider?: string;
	apiKey?: string;
	maxResults?: number;
	maxResponseBytes?: number;
	timeoutMs?: number;
	fetch?: typeof fetch;
}
/** Everything a provider implementation needs; the fetch seam keeps backends replaceable. */
export interface SearchExecution {
	apiKey: string;
	maxResults: number;
	maxResponseBytes: number;
	timeoutMs: number;
	fetch: typeof fetch;
}
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
async function braveSearch(query: string, execution: SearchExecution, signal?: AbortSignal): Promise<SearchResult> {
	if (!query.trim() || query.length > 600 || query.trim().split(/\s+/).length > 75)
		throw new Error("Search query must contain 1-600 characters and at most 75 words");
	signal?.throwIfAborted();
	const timeout = AbortSignal.timeout(execution.timeoutMs);
	const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
	endpoint.searchParams.set("q", query.trim());
	endpoint.searchParams.set("count", String(execution.maxResults));
	const response = await execution.fetch(endpoint, {
		headers: { Accept: "application/json", "X-Subscription-Token": execution.apiKey },
		signal: effectiveSignal,
		redirect: "error", // Never forward the credential to a redirected host.
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Search backend returned HTTP ${response.status}`); // No key/error-body leakage.
	}
	const json = record(await limitedJson(response, execution.maxResponseBytes));
	const web = record(json?.web);
	const hits = web?.results;
	if (hits !== undefined && !Array.isArray(hits)) throw new Error("Malformed search response");
	if (!json || !web) throw new Error("Search response lacks web results");
	const results: SearchHit[] = [];
	let truncated = Array.isArray(hits) && hits.length > execution.maxResults;
	for (const hit of Array.isArray(hits) ? hits.slice(0, execution.maxResults) : []) {
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
		const snippet = clean(item.description, 2000);
		if (
			(typeof item.title === "string" && item.title.length > 300) ||
			(typeof item.description === "string" && item.description.length > 2000)
		)
			truncated = true;
		results.push({ title, url: url.toString(), snippet });
	}
	effectiveSignal.throwIfAborted();
	return { query: query.trim(), provider: "brave", retrievedAt: new Date().toISOString(), results, truncated };
}
/** The only implemented backend; the interface above is the seam for additional providers. */
export const braveSearchProvider: SearchProvider = { id: "brave", search: braveSearch };
/** Accurate list of implemented search backends; adding a name here requires an implementation. */
export function supportedSearchProviders(): string[] {
	return ["brave"];
}
export function resolveSearchProvider(id: string | undefined): SearchProvider {
	if (id === undefined || id === "brave") return braveSearchProvider;
	throw new Error(`Unsupported search provider "${id}"; implemented: ${supportedSearchProviders().join(", ")}`);
}
export async function webSearch(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResult> {
	if (!options.enabled) throw new Error("Web search is disabled; configure PI861_WEB_SEARCH_ENABLED=1");
	if (!options.apiKey?.trim()) throw new Error("Missing BRAVE_SEARCH_API_KEY");
	const count = options.maxResults ?? 5;
	const maxBytes = options.maxResponseBytes ?? 262_144;
	const timeoutMs = options.timeoutMs ?? 15_000;
	if (
		!Number.isSafeInteger(count) ||
		count < 1 ||
		count > 10 ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1024 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1
	)
		throw new Error("Invalid search limits");
	return resolveSearchProvider(options.provider).search(
		query,
		{
			apiKey: options.apiKey,
			maxResults: count,
			maxResponseBytes: maxBytes,
			timeoutMs,
			fetch: options.fetch ?? fetch,
		},
		signal,
	);
}

/** Controlled store for oversized search results (R7.7): long payloads become paged references, not inline JSON. */
export const searchResults = new ControlledResults({ maxEntries: 64, maxTotalBytes: 4_194_304, ttlMs: 600_000 });
export function searchPayload(found: SearchResult, maxInlineBytes = 16_000) {
	return searchResults.wrap(found, maxInlineBytes);
}
