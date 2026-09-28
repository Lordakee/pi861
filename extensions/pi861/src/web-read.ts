import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable, type Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/**
 * Bounded web reading (R7.6). External pages are fetched only after every hop passes
 * scheme/host/port approval and an SSRF guard over the resolved addresses (private,
 * loopback, link-local/metadata, IPv4-mapped IPv6 and NAT64/6to4 embeddings). The
 * default transport pins the TCP connection to a pre-validated address so a rebinding
 * DNS answer cannot redirect the connection; transports that resolve independently
 * report the connected address and mismatches abort the read. All extracted content
 * is untrusted external data, never instructions.
 */

export interface WebEndpointPolicy {
	/** Approved internal endpoints (exact scheme://host[:port]), a separate approval type from public hosts. */
	internal: string[];
	/** Approved public hosts; entries are exact names or "*.suffix" patterns. Every hop is DNS-guarded. */
	publicHosts: string[];
}
export interface ResolvedAddress {
	address: string;
	family: number;
}
export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;
export interface TransportInit {
	headers: Record<string, string>;
	signal: AbortSignal;
	/** Pre-validated addresses; the transport must connect to the first entry instead of re-resolving. */
	pinnedAddresses?: ResolvedAddress[];
	/** Called with the actually connected address, for rebinding detection. */
	onConnect?: (info: { host: string; address: string }) => void;
}
export interface WebResponse {
	status: number;
	headers: { get(name: string): string | null };
	body: Readable | ReadableStream<Uint8Array> | null;
}
export type TransportFetch = (url: URL, init: TransportInit) => Promise<WebResponse>;
export interface WebReadOptions {
	enabled: boolean;
	policy: WebEndpointPolicy;
	maxBytes?: number;
	timeoutMs?: number;
	maxRedirects?: number;
	cacheTtlMs?: number;
	fetch?: TransportFetch;
	lookup?: LookupFn;
	onConnect?: (info: { host: string; address: string }) => void;
}
export interface WebPageResult {
	requestedUrl: string;
	url: string;
	retrievedAt: string;
	contentType: string;
	bytes: number;
	text: string;
	title: string;
	truncated: boolean;
	cache: "hit" | "miss";
	policy: { kind: "public" } | { kind: "internal-endpoint"; endpoint: string };
	untrusted: true;
}
/** A fetched document before caching: the extracted page plus the bounded raw HTML it came from. */
export interface WebDocument {
	page: WebPageResult;
	/** Final HTTP status of the 2xx response the page was extracted from. */
	status: number;
	/** Bounded decoded document body (at most the effective maxBytes), suitable for link extraction. */
	html: string;
}
export interface AuthorizedTarget {
	url: URL;
	kind: "public" | "internal";
	endpoint?: string;
}

// --- address guard -----------------------------------------------------------

function parseIpv4(address: string): number[] | undefined {
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith("0"))) return undefined;
		const value = Number.parseInt(part, 10);
		if (value > 255) return undefined;
		octets.push(value);
	}
	return octets;
}

function parseIpv6(address: string): number[] | undefined {
	const input = (address.split("%", 2)[0] ?? "").toLowerCase();
	if (!input) return undefined;
	const sections = input.split("::");
	if (sections.length > 2) return undefined;
	const headText = sections[0] ?? "";
	const tailText = sections.length === 2 ? (sections[1] ?? "") : "";
	const parseParts = (text: string, allowTrailingIpv4: boolean): number[] | undefined => {
		if (text === "") return [];
		const parts = text.split(":");
		const groups: number[] = [];
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index] ?? "";
			if (part === "") return undefined;
			if (part.includes(".")) {
				if (!allowTrailingIpv4 || index !== parts.length - 1) return undefined;
				const octets = parseIpv4(part);
				if (!octets) return undefined;
				groups.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
			groups.push(Number.parseInt(part, 16));
		}
		return groups;
	};
	const head = parseParts(headText, sections.length === 1 || tailText === "");
	const tail = parseParts(tailText, true);
	if (!head || !tail) return undefined;
	const missing = 8 - head.length - tail.length;
	if (sections.length === 2) {
		if (missing < 1) return undefined;
		return [...head, ...new Array<number>(missing).fill(0), ...tail];
	}
	return head.length === 8 ? head : undefined;
}

function ipv4Blocked(octets: number[]): boolean {
	const value = (((octets[0] ?? 0) * 256 + (octets[1] ?? 0)) * 256 + (octets[2] ?? 0)) * 256 + (octets[3] ?? 0);
	const ranges: Array<[number, number]> = [
		[0x00000000, 0x00ffffff], // "this" network
		[0x0a000000, 0x0affffff], // private
		[0x64400000, 0x647fffff], // CGNAT
		[0x7f000000, 0x7fffffff], // loopback
		[0xa9fe0000, 0xa9feffff], // link-local incl. 169.254.169.254 metadata
		[0xac100000, 0xac1fffff], // private
		[0xc0000000, 0xc00000ff],
		[0xc0000200, 0xc00002ff],
		[0xc0586300, 0xc05863ff], // reserved / TEST-NET-1 / 6to4 relay
		[0xc0a80000, 0xc0a8ffff], // private
		[0xc6120000, 0xc613ffff], // benchmarking
		[0xc6336400, 0xc63364ff],
		[0xcb007100, 0xcb0071ff], // TEST-NET-2/3
		[0xe0000000, 0xffffffff], // multicast, reserved, broadcast
	];
	return ranges.some(([start, end]) => value >= start && value <= end);
}

/** True when an address must not be contacted for a public host; unparsable addresses fail closed. */
export function isBlockedAddress(address: string): boolean {
	const v4 = parseIpv4(address);
	if (v4) return ipv4Blocked(v4);
	const v6 = parseIpv6(address);
	if (!v6) return true;
	const [g0, g1, g2, g3, g4, g5, g6, g7] = v6;
	if ((g0 ?? 0) === 0 && (g1 ?? 0) === 0 && (g2 ?? 0) === 0 && (g3 ?? 0) === 0 && (g4 ?? 0) === 0 && (g5 ?? 0) === 0) {
		return ipv4Blocked([((g6 ?? 0) >> 8) & 0xff, (g6 ?? 0) & 0xff, ((g7 ?? 0) >> 8) & 0xff, (g7 ?? 0) & 0xff]); // ::, ::1 and IPv4-compatible/translated forms
	}
	if (
		(g0 ?? 0) === 0 &&
		(g1 ?? 0) === 0 &&
		(g2 ?? 0) === 0 &&
		(g3 ?? 0) === 0 &&
		(g4 ?? 0) === 0 &&
		(g5 ?? 0) === 0xffff
	) {
		return ipv4Blocked([((g6 ?? 0) >> 8) & 0xff, (g6 ?? 0) & 0xff, ((g7 ?? 0) >> 8) & 0xff, (g7 ?? 0) & 0xff]); // IPv4-mapped IPv6
	}
	if ((g0 ?? 0) === 0x64 && (g1 ?? 0) === 0xff9b) {
		return ipv4Blocked([((g6 ?? 0) >> 8) & 0xff, (g6 ?? 0) & 0xff, ((g7 ?? 0) >> 8) & 0xff, (g7 ?? 0) & 0xff]); // NAT64
	}
	if ((g0 ?? 0) === 0x2002) {
		return ipv4Blocked([(g1 ?? 0) >> 8, (g1 ?? 0) & 0xff, (g2 ?? 0) >> 8, (g2 ?? 0) & 0xff]); // 6to4
	}
	if ((g0 ?? 0) === 0x0100 && v6.slice(1).every((group) => group === 0)) return true; // discard-only
	if ((g0 ?? 0) === 0x2001 && (g1 ?? 0) === 0x0db8) return true; // documentation
	if ((g0 ?? 0) === 0x2001 && (g1 ?? 0) === 0x0000) return true; // Teredo (2001::/32)
	if (((g0 ?? 0) & 0xfe00) === 0xfc00) return true; // unique local
	if (((g0 ?? 0) & 0xffc0) === 0xfe80) return true; // link-local
	if (((g0 ?? 0) & 0xff00) === 0xff00) return true; // multicast
	return false;
}

// --- approval ----------------------------------------------------------------

function normalizeHost(host: string): string {
	return host.replace(/\.$/, "").toLowerCase();
}
function effectivePort(url: URL): number {
	if (url.port) return Number.parseInt(url.port, 10);
	return url.protocol === "https:" ? 443 : 80;
}
export function hostMatches(hostname: string, pattern: string): boolean {
	const host = normalizeHost(hostname);
	const rule = normalizeHost(pattern);
	if (host === rule) return true;
	if (rule.startsWith("*.")) {
		const suffix = rule.slice(1); // ".example.org"
		return host.endsWith(suffix) && host.length > suffix.length;
	}
	return false;
}

/** Scheme/host/port approval. Internal endpoints match exactly; public hosts allow standard ports only. */
export function authorizeTarget(rawUrl: string | URL, policy: WebEndpointPolicy): AuthorizedTarget {
	let url: URL;
	try {
		url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
	} catch {
		throw new Error("Invalid URL for web reading");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new Error(`Web reading refuses scheme "${url.protocol}"`);
	if (url.username || url.password) throw new Error("Web reading refuses URLs with embedded credentials");
	const host = normalizeHost(url.hostname);
	if (!host) throw new Error("Web reading requires a host");
	for (const endpoint of policy.internal) {
		let approved: URL;
		try {
			approved = new URL(endpoint);
		} catch {
			throw new Error(`Invalid approved internal endpoint "${endpoint}"`);
		}
		if (
			approved.protocol === url.protocol &&
			normalizeHost(approved.hostname) === host &&
			effectivePort(approved) === effectivePort(url)
		) {
			return { url, kind: "internal", endpoint };
		}
	}
	if (policy.publicHosts.some((pattern) => hostMatches(host, pattern))) {
		const port = effectivePort(url);
		const expected = url.protocol === "https:" ? 443 : 80;
		if (port !== expected)
			throw new Error(
				`Web reading refuses ${url.protocol}// port ${url.port || "(default)"}; only the protocol default is allowed`,
			);
		return { url, kind: "public" };
	}
	throw new Error(`Host "${host}" is not approved for web reading`);
}

export const defaultLookup: LookupFn = async (hostname) => {
	const bare = hostname.replace(/^\[/, "").replace(/\]$/, "");
	const family = isIP(bare);
	if (family !== 0) return [{ address: bare, family }];
	const found = await dnsLookup(bare, { all: true, verbatim: true });
	return found.map((entry) => ({ address: entry.address, family: entry.family }));
};

// --- default transport -------------------------------------------------------

function pinnedLookup(
	addresses: ResolvedAddress[],
	onConnect: (info: { host: string; address: string }) => void,
): LookupFunction {
	return (hostname, options, callback) => {
		const chosen = addresses[0];
		if (!chosen) {
			callback(new Error("No validated address available"), "", 0);
			return;
		}
		onConnect({ host: hostname, address: chosen.address });
		if (options?.all) {
			(callback as unknown as (error: Error | null, results: ResolvedAddress[]) => void)(null, addresses);
			return;
		}
		callback(null, chosen.address, chosen.family);
	};
}

/** Default transport over node:http/https. Connections are pinned to pre-validated addresses. */
export const nodeTransport: TransportFetch = (url, init) =>
	new Promise<WebResponse>((resolve, reject) => {
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const request = send(
			url,
			{
				method: "GET",
				headers: init.headers,
				signal: init.signal,
				lookup: init.pinnedAddresses ? pinnedLookup(init.pinnedAddresses, init.onConnect ?? (() => {})) : undefined,
			},
			(response) => {
				resolve({
					status: response.statusCode ?? 0,
					headers: {
						get: (name: string): string | null => {
							const value = response.headers[name.toLowerCase()];
							return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
						},
					},
					body: response,
				});
			},
		);
		request.on("error", reject);
		request.end();
	});

// --- bounded reading and extraction ------------------------------------------

const BYTE_LIMIT = new Error("byte limit reached");

async function drainBody(body: WebResponse["body"]): Promise<void> {
	if (body instanceof ReadableStream) await body.cancel().catch(() => {});
	else if (body) body.destroy();
}

function decoderFor(encoding: string): Transform | null {
	switch (encoding) {
		case "":
		case "identity":
			return null;
		case "gzip":
		case "x-gzip":
			return createGunzip();
		case "deflate":
			return createInflate();
		case "br":
			return createBrotliDecompress();
		default:
			throw new Error(`Web reading cannot decode content-encoding "${encoding}"`);
	}
}

async function readBounded(
	body: WebResponse["body"],
	decoder: Transform | null,
	maxBytes: number,
	signal: AbortSignal,
): Promise<{ bytes: number; text: string; truncated: boolean }> {
	if (!body) return { bytes: 0, text: "", truncated: false };
	const source =
		body instanceof ReadableStream
			? Readable.fromWeb(body as unknown as NodeWebReadableStream)
			: body instanceof Readable
				? body
				: Readable.from([]);
	const collected: Buffer[] = [];
	let total = 0;
	let truncated = false;
	const sink = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			if (total + chunk.length > maxBytes) {
				const keep = maxBytes - total;
				if (keep > 0) {
					collected.push(chunk.subarray(0, keep));
					total = maxBytes;
				}
				truncated = true;
				callback(BYTE_LIMIT); // destroys the pipeline and closes the connection
				return;
			}
			total += chunk.length;
			collected.push(chunk);
			callback();
		},
	});
	const stages: Array<Readable | Transform | Writable> = decoder ? [source, decoder, sink] : [source, sink];
	try {
		await pipeline(stages, { signal });
	} catch (error) {
		if (error !== BYTE_LIMIT) throw error;
	}
	return { bytes: total, text: Buffer.concat(collected).toString("utf8"), truncated };
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(input: string): string {
	return input.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
		let codePoint = -1;
		if (body.startsWith("#x") || body.startsWith("#X")) codePoint = Number.parseInt(body.slice(2), 16);
		else if (body.startsWith("#")) codePoint = Number.parseInt(body.slice(1), 10);
		else return ENTITIES[body] ?? whole;
		if (!Number.isInteger(codePoint) || codePoint < 0x20 || codePoint > 0x10ffff) return whole;
		try {
			return String.fromCodePoint(codePoint);
		} catch {
			return whole;
		}
	});
}
function cleanControls(input: string): string {
	return input.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

/** Linear strip of comments and script/style blocks; lazy [\s\S]*? regexes backtrack quadratically on adversarial input. */
function stripMarkupBlocks(source: string): string {
	const lower = source.toLowerCase();
	let out = "";
	let cursor = 0;
	while (cursor < source.length) {
		const nextComment = lower.indexOf("<!--", cursor);
		const nextScript = lower.indexOf("<script", cursor);
		const nextStyle = lower.indexOf("<style", cursor);
		let start = -1;
		let endTag = "";
		if (nextComment !== -1 && (start === -1 || nextComment < start)) {
			start = nextComment;
			endTag = "-->";
		}
		if (nextScript !== -1 && (start === -1 || nextScript < start)) {
			start = nextScript;
			endTag = "</script";
		}
		if (nextStyle !== -1 && (start === -1 || nextStyle < start)) {
			start = nextStyle;
			endTag = "</style";
		}
		if (start === -1) break;
		out += source.slice(cursor, start);
		const close = lower.indexOf(endTag, start + 1);
		cursor = close === -1 ? source.length : close + endTag.length; // unterminated block swallows the rest
	}
	return out + source.slice(cursor);
}

export interface ExtractedContent {
	title: string;
	text: string;
	truncated: boolean;
}

/** Naive bounded HTML-to-text extraction; removes scripts, styles, comments, tags and control characters. */
export function extractText(source: string, maxLength = 100_000): ExtractedContent {
	const titleMatch = /<title[^>]*>([\s\S]{0,4096}?)<\/title\s*>/i.exec(source);
	const title = titleMatch?.[1]
		? cleanControls(decodeEntities(titleMatch[1])).replace(/\s+/g, " ").trim().slice(0, 300)
		: "";
	const working = stripMarkupBlocks(source)
		.replace(/<(?:br|hr)\b[^>]*>/gi, "\n")
		.replace(
			/<\/(?:p|div|section|article|aside|header|footer|nav|li|ul|ol|tr|table|tbody|thead|blockquote|pre|h[1-6]|dt|dd)\s*>/gi,
			"\n",
		)
		.replace(/<[^>]*>/g, " ");
	const collapsed = cleanControls(decodeEntities(working))
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, text: collapsed.slice(0, maxLength), truncated: collapsed.length > maxLength };
}

const MAX_LINKS_PER_PAGE = 200;

/** Bounded extraction of absolute http(s) link targets from `<a href>` anchors of an HTML document. */
export function extractLinks(html: string, baseUrl: string | URL): string[] {
	const source = stripMarkupBlocks(html); // anchors inside scripts, styles or comments are not page links
	const found: string[] = [];
	const seen = new Set<string>();
	const anchors = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
	for (
		let match = anchors.exec(source);
		found.length < MAX_LINKS_PER_PAGE && match !== null;
		match = anchors.exec(source)
	) {
		const raw = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
		if (!raw || raw.startsWith("#")) continue;
		let url: URL;
		try {
			url = new URL(raw, baseUrl);
		} catch {
			continue;
		}
		if (url.protocol !== "https:" && url.protocol !== "http:") continue; // mailto:, javascript:, data: ...
		if (url.username || url.password) continue;
		url.hash = ""; // a fragment never identifies a separate document
		const normalized = url.toString(); // query stays as written: parameter order and repeats may carry meaning
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		found.push(normalized);
	}
	return found;
}

function isReadableContentType(contentType: string): boolean {
	if (contentType.startsWith("text/")) return true;
	return [
		"application/xhtml+xml",
		"application/xml",
		"application/json",
		"application/rss+xml",
		"application/atom+xml",
	].includes(contentType);
}

// --- reader ------------------------------------------------------------------

interface CacheEntry {
	page: WebPageResult;
	storedAt: number;
}
const CACHE_MAX_ENTRIES = 32;
const pageCaches = new WeakMap<WebReadOptions, Map<string, CacheEntry>>();

function cacheGet(options: WebReadOptions, key: string, ttlMs: number): WebPageResult | undefined {
	const cache = pageCaches.get(options);
	const entry = cache?.get(key);
	if (!entry) return undefined;
	if (Date.now() - entry.storedAt > ttlMs) {
		cache?.delete(key);
		return undefined;
	}
	return entry.page;
}
function cacheSet(options: WebReadOptions, key: string, page: WebPageResult, ttlMs: number): void {
	if (ttlMs < 1) return;
	let cache = pageCaches.get(options);
	if (!cache) {
		cache = new Map();
		pageCaches.set(options, cache);
	}
	cache.set(key, { page, storedAt: Date.now() });
	while (cache.size > CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
}

export function webReadOptionsFromEnv(env: Record<string, string | undefined> = process.env): WebReadOptions {
	const list = (value: string | undefined): string[] =>
		(value ?? "")
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	return {
		enabled: env.PI861_WEB_READ_ENABLED === "1",
		policy: {
			publicHosts: list(env.PI861_WEB_READ_HOSTS),
			internal: list(env.PI861_WEB_READ_INTERNAL_ENDPOINTS),
		},
	};
}

interface WebReadLimits {
	maxBytes: number;
	timeoutMs: number;
	maxRedirects: number;
	cacheTtlMs: number;
}

/** Validates enablement, policy and numeric bounds; shared by the cached reader and the document fetcher. */
function webReadLimits(options: WebReadOptions): WebReadLimits {
	if (!options.enabled)
		throw new Error("Web reading is disabled; configure PI861_WEB_READ_ENABLED=1 and host approvals");
	if (!options.policy || !Array.isArray(options.policy.internal) || !Array.isArray(options.policy.publicHosts))
		throw new Error("Web reading requires an endpoint policy");
	const limits: WebReadLimits = {
		maxBytes: options.maxBytes ?? 262_144,
		timeoutMs: options.timeoutMs ?? 15_000,
		maxRedirects: options.maxRedirects ?? 3,
		cacheTtlMs: options.cacheTtlMs ?? 600_000,
	};
	if (
		!Number.isSafeInteger(limits.maxBytes) ||
		limits.maxBytes < 1024 ||
		!Number.isSafeInteger(limits.timeoutMs) ||
		limits.timeoutMs < 1 ||
		!Number.isSafeInteger(limits.maxRedirects) ||
		limits.maxRedirects < 0 ||
		!Number.isSafeInteger(limits.cacheTtlMs) ||
		limits.cacheTtlMs < 0
	)
		throw new Error("Invalid web read limits");
	return limits;
}

/** Fetches a document through the complete request chain without any cache access. */
export async function readWebDocument(
	rawUrl: string,
	options: WebReadOptions,
	signal?: AbortSignal,
): Promise<WebDocument> {
	const { maxBytes, timeoutMs, maxRedirects } = webReadLimits(options);
	signal?.throwIfAborted();
	const deadline = AbortSignal.timeout(timeoutMs);
	const effective = signal ? AbortSignal.any([signal, deadline]) : deadline;
	let current: string | URL = rawUrl;
	for (let hop = 0; ; hop++) {
		const target = authorizeTarget(current, options.policy);
		// Resolve before connecting and pin the connection to a validated address for every
		// target kind; the public-address blocklist applies to public hosts only.
		const validated = await (options.lookup ?? defaultLookup)(target.url.hostname);
		if (validated.length === 0) throw new Error("Host did not resolve to any address");
		if (target.kind === "public") {
			for (const candidate of validated) {
				if (isBlockedAddress(candidate.address))
					throw new Error("Host resolves to a non-public address; refusing to connect (SSRF guard)");
			}
		}
		const rebind = new AbortController();
		const guard = AbortSignal.any([effective, rebind.signal]);
		const response = await (options.fetch ?? nodeTransport)(target.url, {
			headers: {
				accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.5",
				"accept-encoding": "gzip, deflate, br",
				"user-agent": "pi861-web-read/0.1 (bounded reader)",
			},
			signal: guard,
			pinnedAddresses: validated,
			onConnect: (info) => {
				if (!validated.some((entry) => entry.address === info.address)) {
					rebind.abort(new Error("DNS rebinding guard: connected address differs from the validated addresses"));
				}
				options.onConnect?.(info);
			},
		});
		if (response.status >= 300 && response.status < 400) {
			await drainBody(response.body);
			const location = response.headers.get("location");
			if (!location) throw new Error("Redirect response without a Location header");
			if (hop >= maxRedirects) throw new Error(`Web reading exceeded the limit of ${maxRedirects} redirects`);
			let next: URL;
			try {
				next = new URL(location, target.url);
			} catch {
				throw new Error("Redirect carried an invalid Location header");
			}
			current = next; // each hop is fully re-approved and re-guarded
			continue;
		}
		if (response.status < 200 || response.status >= 300) {
			await drainBody(response.body);
			throw new Error(`Web read returned HTTP ${response.status}`);
		}
		const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
		if (!isReadableContentType(contentType)) {
			await drainBody(response.body);
			throw new Error(`Web reading refuses content type "${contentType || "unknown"}"`);
		}
		const decoder = decoderFor((response.headers.get("content-encoding") ?? "").trim().toLowerCase());
		const read = await readBounded(response.body, decoder, maxBytes, guard);
		const extracted = extractText(read.text);
		const page: WebPageResult = {
			requestedUrl: rawUrl,
			url: target.url.toString(),
			retrievedAt: new Date().toISOString(),
			contentType,
			bytes: read.bytes,
			text: extracted.text,
			title: extracted.title,
			truncated: read.truncated || extracted.truncated,
			cache: "miss",
			policy:
				target.kind === "public"
					? { kind: "public" }
					: { kind: "internal-endpoint", endpoint: target.endpoint ?? "" },
			untrusted: true,
		};
		effective.throwIfAborted();
		return { page, status: response.status, html: read.text };
	}
}

/** Reads a web page under approval, SSRF, redirect, size, time and cancellation bounds. */
export async function readWebPage(
	rawUrl: string,
	options: WebReadOptions,
	signal?: AbortSignal,
): Promise<WebPageResult> {
	const { cacheTtlMs } = webReadLimits(options);
	signal?.throwIfAborted();
	const cached = cacheGet(options, rawUrl, cacheTtlMs);
	if (cached) return { ...cached, cache: "hit" };
	const { page } = await readWebDocument(rawUrl, options, signal);
	cacheSet(options, rawUrl, page, cacheTtlMs);
	return page;
}
