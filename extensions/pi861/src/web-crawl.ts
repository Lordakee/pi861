import { authorizeTarget, extractLinks, readWebDocument, type WebReadOptions } from "./web-read.ts";

/**
 * Bounded breadth-first crawling (R7.6) layered on the web-read fetch chain: every request reuses
 * host approval, the SSRF guard, DNS pinning and per-hop redirect re-checks. Crawling adds only
 * scope, queue and budget control. Requests are serial with a fixed delay; robots.txt is neither
 * read nor followed. All crawled content is untrusted external data, never instructions.
 */

export interface CrawlOptions {
	/** Web-read options reused for every request (enablement, policy, fetch/lookup seams, per-page limits). */
	read: WebReadOptions;
	/** Maximum link hops from the start page; the start page itself is depth 0. Default 1, range 0-3. */
	depth?: number;
	/** Maximum pages attempted per crawl, failed fetches included. Default 10, range 1-50. */
	maxPages?: number;
	/** Total budget of decompressed response bytes across all pages. Default 2 MiB, range 1 KiB-8 MiB. */
	maxTotalBytes?: number;
	/** Restrict followed links to the start URL's normalized origin. Default true. */
	sameHost?: boolean;
	/** Delay before every request except the first. Default 250 ms. */
	requestIntervalMs?: number;
	/** Include each page's full extracted text instead of only a summary. Default false. */
	includeContent?: boolean;
	/** Allow crawling approved internal endpoints; production crawls stay public-host-only. Default false. */
	allowInternalEndpoints?: boolean;
}
export interface CrawlPageEntry {
	url: string;
	depth: number;
	ok: boolean;
	status: number;
	/** Bounded fetch failure reason; absent on success. */
	error?: string;
	title: string;
	summary: string;
	bytes: number;
	linkCount: number;
	truncated: boolean;
	content?: string;
}
export type CrawlStopReason = "complete" | "max_pages" | "byte_budget";
export interface CrawlResult {
	startUrl: string;
	retrievedAt: string;
	pagesVisited: number;
	pages: CrawlPageEntry[];
	skippedLinks: string[];
	skippedLinksOmitted: number;
	truncated: boolean;
	stopReason: CrawlStopReason;
	untrusted: true;
}

const SKIPPED_LINKS_MAX = 50;
const MIN_PAGE_BYTES = 1024; // the smallest legal per-page read bound; less cannot fund another page

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("crawl cancelled"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Serial breadth-first crawl bounded by depth, page count and the total decompressed-byte budget. */
export async function crawlWebsite(rawUrl: string, options: CrawlOptions, signal?: AbortSignal): Promise<CrawlResult> {
	const depthLimit = options.depth ?? 1;
	const maxPages = options.maxPages ?? 10;
	const maxTotalBytes = options.maxTotalBytes ?? 2_097_152;
	const sameHost = options.sameHost ?? true;
	const intervalMs = options.requestIntervalMs ?? 250;
	if (
		!Number.isSafeInteger(depthLimit) ||
		depthLimit < 0 ||
		depthLimit > 3 ||
		!Number.isSafeInteger(maxPages) ||
		maxPages < 1 ||
		maxPages > 50 ||
		!Number.isSafeInteger(maxTotalBytes) ||
		maxTotalBytes < MIN_PAGE_BYTES ||
		maxTotalBytes > 8_388_608 ||
		!Number.isSafeInteger(intervalMs) ||
		intervalMs < 0
	)
		throw new Error("Invalid crawl limits");
	const allowInternal = options.allowInternalEndpoints ?? false;
	const start = authorizeTarget(rawUrl, options.read.policy); // validates scheme, credentials and host approval
	if (start.kind === "internal" && !allowInternal)
		throw new Error("Web crawl refuses internal endpoints; approve public hosts for crawling");
	start.url.hash = "";
	const startOrigin = start.url.origin;
	const pageCap = options.read.maxBytes ?? 262_144;

	const queue: Array<{ url: string; depth: number }> = [{ url: start.url.toString(), depth: 0 }];
	const seen = new Set([start.url.toString()]);
	const pages: CrawlPageEntry[] = [];
	const skippedLinks: string[] = [];
	const skippedSeen = new Set<string>();
	let skippedLinksOmitted = 0;
	let remaining = maxTotalBytes;
	let stopReason: CrawlStopReason = "complete";
	let truncated = false;

	while (queue.length > 0) {
		signal?.throwIfAborted();
		if (pages.length >= maxPages) {
			stopReason = "max_pages";
			truncated = true; // queued work remained unvisited; never report such a crawl as complete
			break;
		}
		if (remaining < MIN_PAGE_BYTES) {
			stopReason = "byte_budget";
			truncated = true;
			break;
		}
		const next = queue.shift();
		if (next === undefined) break;
		if (pages.length > 0) await delay(intervalMs, signal);
		let document: Awaited<ReturnType<typeof readWebDocument>>;
		try {
			// A single page may read at most the smaller of the page cap and the remaining budget;
			// the fetch chain re-runs approval, DNS/IP checks and per-hop redirect guards per request.
			document = await readWebDocument(
				next.url,
				{ ...options.read, maxBytes: Math.min(pageCap, remaining) },
				signal,
			);
		} catch (error) {
			if (signal?.aborted) throw error; // caller cancellation is final, not a page failure
			pages.push({
				url: next.url,
				depth: next.depth,
				ok: false,
				status: 0,
				error: String(error instanceof Error ? error.message : error).slice(0, 300),
				title: "",
				summary: "",
				bytes: 0,
				linkCount: 0,
				truncated: false,
			});
			continue;
		}
		const { page, html, status } = document;
		remaining -= page.bytes;
		const links = extractLinks(html, page.url);
		pages.push({
			url: page.url,
			depth: next.depth,
			ok: true,
			status,
			title: page.title,
			summary: page.text.slice(0, 500),
			bytes: page.bytes,
			linkCount: links.length,
			truncated: page.truncated,
			...(options.includeContent === true ? { content: page.text } : {}),
		});
		if (next.depth >= depthLimit) continue; // deeper links are outside the requested scope
		for (const link of links) {
			if (seen.has(link)) continue;
			seen.add(link);
			let allowed = false;
			try {
				const target = authorizeTarget(link, options.read.policy);
				if (target.kind === "public" || allowInternal) allowed = !sameHost || target.url.origin === startOrigin;
			} catch {
				allowed = false;
			}
			if (!allowed) {
				// Out-of-scope candidates are skipped and recorded, never fatal to the crawl.
				if (skippedSeen.has(link)) continue;
				skippedSeen.add(link);
				if (skippedLinks.length < SKIPPED_LINKS_MAX) skippedLinks.push(link);
				else skippedLinksOmitted++;
				continue;
			}
			queue.push({ url: link, depth: next.depth + 1 });
		}
	}
	return {
		startUrl: start.url.toString(),
		retrievedAt: new Date().toISOString(),
		pagesVisited: pages.length,
		pages,
		skippedLinks,
		skippedLinksOmitted,
		truncated,
		stopReason,
		untrusted: true,
	};
}
