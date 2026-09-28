import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { crawlWebsite } from "../src/web-crawl.ts";

/**
 * Crawl fixture matrix over the real default transport. The fixture server is reached through an
 * approved internal endpoint (allowInternalEndpoints is a test seam; production crawls are
 * public-host-only). All SSRF, redirect and rebinding guarantees come from the reused web-read
 * chain and stay covered by test/web-read.test.mjs.
 */

const stopServer = (server) => { server.close(); server.closeAllConnections(); };
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const link = (href, text = "l") => `<a href="${href}">${text}</a>`;
const doc = (title, body) => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const crawlOptions = (port, extra = {}) => ({
	read: { enabled: true, policy: { publicHosts: [], internal: [`http://127.0.0.1:${port}`, `http://fixture.test:${port}`] } },
	allowInternalEndpoints: true,
	requestIntervalMs: 1,
	...extra,
});
const crawlOptionsWithRead = (port, readExtra = {}, extra = {}) => ({
	...crawlOptions(port, extra),
	read: { ...crawlOptions(port).read, ...readExtra },
});

test("validation: internal endpoints are refused by default and limits are bounded", async () => {
	const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(doc("t", "")); });
	await listen(server);
	const port = server.address().port;
	try {
		await assert.rejects(
			crawlWebsite(`http://127.0.0.1:${port}/`, crawlOptions(port, { allowInternalEndpoints: undefined })),
			/refuses internal endpoints/,
		);
		await assert.rejects(crawlWebsite(`http://127.0.0.1:${port}/`, crawlOptions(port, { depth: 4 })), /Invalid crawl limits/);
		await assert.rejects(crawlWebsite(`http://127.0.0.1:${port}/`, crawlOptions(port, { maxPages: 51 })), /Invalid crawl limits/);
		await assert.rejects(crawlWebsite(`http://127.0.0.1:${port}/`, crawlOptions(port, { maxTotalBytes: 8_388_609 })), /Invalid crawl limits/);
		await assert.rejects(crawlWebsite("http://evil.example/", crawlOptions(port)), /not approved/);
		let fetches = 0;
		const refused = { ...crawlOptions(port, { allowInternalEndpoints: undefined }) };
		refused.read = { ...refused.read, fetch: async () => { fetches++; throw new Error("must not be called"); } };
		await assert.rejects(crawlWebsite(`http://127.0.0.1:${port}/`, refused), /refuses internal endpoints/);
		assert.equal(fetches, 0);
	} finally { stopServer(server); }
});

test("BFS order, depth bounds and per-page fields", async () => {
	const server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		if (req.url === "/start") res.end(doc("start", link("/b") + link("/c")));
		else if (req.url === "/b") res.end(doc("b", link("/d")));
		else if (req.url === "/c") res.end(doc("c", ""));
		else if (req.url === "/d") res.end(doc("d", link("/e")));
		else res.end(doc("e", ""));
	});
	await listen(server);
	const port = server.address().port;
	try {
		const shallow = await crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptions(port, { depth: 1 }));
		assert.deepEqual(shallow.pages.map((p) => [p.url, p.depth]), [
			[`http://127.0.0.1:${port}/start`, 0],
			[`http://127.0.0.1:${port}/b`, 1],
			[`http://127.0.0.1:${port}/c`, 1],
		]);
		assert.equal(shallow.stopReason, "complete");
		assert.equal(shallow.truncated, false);
		assert.equal(shallow.pagesVisited, 3);
		assert.equal(shallow.pages[0].title, "start");
		assert.equal(shallow.pages[0].status, 200);
		assert.equal(shallow.pages[0].ok, true);
		assert.equal(shallow.pages[0].linkCount, 2);
		assert.equal(shallow.untrusted, true);

		const deep = await crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptions(port, { depth: 2 }));
		assert.deepEqual(deep.pages.map((p) => [p.url.split("/").pop(), p.depth]), [
			["start", 0],
			["b", 1],
			["c", 1],
			["d", 2],
		]);

		const onlyStart = await crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptions(port, { depth: 0 }));
		assert.equal(onlyStart.pagesVisited, 1);
		assert.equal(onlyStart.pages[0].linkCount, 2); // links are counted but not followed
		assert.equal(onlyStart.stopReason, "complete");
	} finally { stopServer(server); }
});

test("cross-host and unapproved links are skipped and recorded, not fatal; overflow truncated (crawl-F003)", async () => {
	const server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		if (req.url === "/start") {
			// 2 boundary-case links plus 60 off-host links: skippedLinks caps at 50 with an omitted count
			const overflow = Array.from({ length: 60 }, (_, i) => `<a href="http://bulk-${i}.example/p">b</a>`).join("");
			res.end(doc("start", link("/ok") + link("http://evil.example/x") + link(`http://fixture.test:${port}/cross`) + overflow));
		} else res.end(doc("ok", ""));
	});
	await listen(server);
	const port = server.address().port;
	try {
		const found = await crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptions(port));
		assert.equal(found.pagesVisited, 2);
		assert.equal(found.skippedLinks.length, 50);
		assert.equal(found.skippedLinksOmitted, 12); // 2 boundary + 60 bulk = 62, capped at 50
		assert.equal(found.stopReason, "complete");
	} finally { stopServer(server); }
});

test("sameHost=false widens scope only to other approved hosts", async () => {
	const server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		if (req.url === "/start") res.end(doc("start", link(`http://fixture.test:${port}/cross`)));
		else res.end(doc("cross", ""));
	});
	await listen(server);
	const port = server.address().port;
	try {
		// fixture.test is an approved internal endpoint but a different origin; sameHost=false follows it.
		const lookup = async (hostname) => [{ address: hostname === "fixture.test" ? "127.0.0.1" : hostname, family: 4 }];
		const found = await crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptionsWithRead(port, { lookup }, { sameHost: false }));
		assert.equal(found.pagesVisited, 2);
		assert.deepEqual(found.skippedLinks, []);
		// With the default sameHost=true the identical graph skips the cross-origin page.
		const scoped = await crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptionsWithRead(port, { lookup }));
		assert.equal(scoped.pagesVisited, 1);
		assert.deepEqual(scoped.skippedLinks, [`http://fixture.test:${port}/cross`]);
	} finally { stopServer(server); }
});

test("fragment, relative and repeated-query duplicates are fetched once; distinct queries kept", async () => {
	const hits = [];
	const server = createServer((req, res) => {
		hits.push(req.url);
		res.writeHead(200, { "content-type": "text/html" });
		if (req.url === "/start") {
			res.end(doc("start", [
				link("/x"), link("x"), link("/x#frag"), link(`http://127.0.0.1:${port}/x`),
				link("/y?a=1&b=2"), link("/y?b=2&a=1"),
			].join("")));
		} else res.end(doc(req.url, ""));
	});
	await listen(server);
	const port = server.address().port;
	try {
		const found = await crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptions(port));
		assert.deepEqual(hits.sort(), ["/start", "/x", "/y?a=1&b=2", "/y?b=2&a=1"]);
		assert.equal(found.pagesVisited, 4); // start, one /x, two distinct /y queries
	} finally { stopServer(server); }
});

test("redirects to unapproved or private addresses stay blocked and do not abort the crawl", async () => {
	const server = createServer((req, res) => {
		if (req.url === "/start") { res.writeHead(200, { "content-type": "text/html" }); res.end(doc("start", link("/ra") + link("/rb") + link("/ok"))); return; }
		if (req.url === "/ra") { res.writeHead(302, { location: "http://evil.example/" }); res.end(); return; }
		if (req.url === "/rb") { res.writeHead(302, { location: "http://rebind.example/leak" }); res.end(); return; }
		res.writeHead(200, { "content-type": "text/html" }); res.end(doc("ok", ""));
	});
	await listen(server);
	const port = server.address().port;
	try {
		// rebind.example is an approved public name that resolves to a private address: the reused
		// fetch chain must refuse it before any connection, exactly as for single reads.
		const lookup = async (hostname) =>
			hostname === "127.0.0.1" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "10.0.0.1", family: 4 }];
		const read = { enabled: true, policy: { publicHosts: ["rebind.example"], internal: [`http://127.0.0.1:${port}`] }, lookup };
		const found = await crawlWebsite(`http://127.0.0.1:${port}/start`, { read, allowInternalEndpoints: true, requestIntervalMs: 1 });
		assert.equal(found.pagesVisited, 4); // start plus both blocked hops plus the reachable page
		const failures = found.pages.filter((p) => p.ok === false);
		assert.equal(failures.length, 2);
		assert.match(failures[0].error, /not approved/);
		assert.match(failures[1].error, /non-public address|refusing to connect/);
		assert.equal(failures[0].status, 0);
		assert.ok(found.pages.some((p) => p.ok === true && p.url.endsWith("/ok")));
		assert.equal(found.stopReason, "complete");
	} finally { stopServer(server); }
});

test("compressed responses count decompressed bytes against the total budget", async () => {
	const server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
		if (req.url === "/start") res.end(gzipSync(doc("start", link("/big1") + link("/big2"))));
		else res.end(gzipSync(doc(req.url.slice(1), "G".repeat(3000))));
	});
	await listen(server);
	const port = server.address().port;
	try {
		const found = await crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptions(port, { maxTotalBytes: 2048 }));
		assert.equal(found.pagesVisited, 2); // start plus one big page, then the budget stops the queue
		assert.equal(found.stopReason, "byte_budget");
		assert.equal(found.truncated, true);
		const startBytes = found.pages[0].bytes;
		assert.ok(found.pages[0].bytes < 500, "fixture start page must stay small for stable accounting");
		assert.equal(found.pages[1].bytes, 2048 - startBytes); // per-page cap = min(page cap, remaining budget)
		assert.equal(found.pages[1].truncated, true); // 3000 decompressed characters did not fit
		assert.ok(!found.pages[1].content && found.pages[1].summary.length <= 500);
	} finally { stopServer(server); }
});

test("the page-count cap stops the queue and is reported honestly", async () => {
	const hits = [];
	const server = createServer((req, res) => {
		hits.push(req.url);
		res.writeHead(200, { "content-type": "text/html" });
		const index = Number.parseInt(req.url.slice(2), 10);
		res.end(doc(`p${index}`, link(`/p${index + 1}`)));
	});
	await listen(server);
	const port = server.address().port;
	try {
		const found = await crawlWebsite(`http://127.0.0.1:${port}/p0`, crawlOptions(port, { maxPages: 2, depth: 3 }));
		assert.equal(found.pagesVisited, 2);
		assert.equal(found.stopReason, "max_pages");
		assert.equal(found.truncated, true);
		assert.deepEqual(hits, ["/p0", "/p1"]);
	} finally { stopServer(server); }
});

test("requests are serial with the configured delay; the first request waits for nothing", async () => {
	const times = [];
	const server = createServer((req, res) => {
		times.push(Date.now());
		res.writeHead(200, { "content-type": "text/html" });
		if (req.url === "/start") res.end(doc("start", link("/a")));
		else res.end(doc("a", ""));
	});
	await listen(server);
	const port = server.address().port;
	try {
		await crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptions(port, { requestIntervalMs: 120 }));
		assert.equal(times.length, 2);
		assert.ok(times[1] - times[0] >= 110, `gap was ${times[1] - times[0]}ms`);
	} finally { stopServer(server); }
});

test("cancellation stops the crawl immediately during the delay and inside a request", async () => {
	const hits = [];
	const server = createServer((req, res) => {
		hits.push(req.url);
		if (req.url === "/hang") return; // never responds
		res.writeHead(200, { "content-type": "text/html" });
		if (req.url === "/start") res.end(doc("start", link("/x1") + link("/x2")));
		else res.end(doc("x", ""));
	});
	await listen(server);
	const port = server.address().port;
	try {
		const duringDelay = new AbortController();
		const crawling = crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptions(port, { requestIntervalMs: 4000 }), duringDelay.signal);
		setTimeout(() => duringDelay.abort(new Error("cancel-delay")), 150);
		await assert.rejects(crawling, /cancel-delay|abort/i);
		assert.deepEqual(hits, ["/start"]); // nothing after the start page

		const duringRequest = new AbortController();
		const hung = crawlWebsite(`http://127.0.0.1:${port}/hang`, crawlOptions(port), duringRequest.signal);
		setTimeout(() => duringRequest.abort(new Error("cancel-request")), 150);
		await assert.rejects(hung, /cancel-request|abort/i);
		assert.deepEqual(hits, ["/start", "/hang"]);
	} finally { stopServer(server); }
});

test("includeContent defaults to a 500-character summary; content is opt-in", async () => {
	const server = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		if (req.url === "/start") res.end(doc("start", `<p>${"w".repeat(800)}</p>` + link("/other")));
		else res.end(doc("other", ""));
	});
	await listen(server);
	const port = server.address().port;
	try {
		const summary = await crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptions(port, { depth: 0 }));
		assert.equal(summary.pages[0].summary.length, 500);
		assert.equal(summary.pages[0].content, undefined);
		const full = await crawlWebsite(`http://127.0.0.1:${port}/start`, crawlOptions(port, { depth: 0, includeContent: true }));
		assert.equal(full.pages[0].content, `start ${"w".repeat(800)}\nl`); // title and link text stay in the full text
		assert.ok(full.pages[0].content.startsWith(full.pages[0].summary));
	} finally { stopServer(server); }
});
