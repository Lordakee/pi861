import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { gzipSync, brotliCompressSync, deflateSync } from "node:zlib";
import {
	authorizeTarget, defaultLookup, extractText, hostMatches, isBlockedAddress,
	nodeTransport, readWebPage, webReadOptionsFromEnv,
} from "../src/web-read.ts";
import { ControlledResults } from "../src/controlled-results.ts";

const publicOptions = (extra = {}) => ({
	enabled: true,
	policy: { publicHosts: ["example.org", "*.docs.example.org"], internal: [] },
	...extra,
});
const lookupOf = (addresses) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const stopServer = (server) => { server.close(); server.closeAllConnections(); };

// --- address guard -----------------------------------------------------------

test("SSRF guard blocks private, loopback, metadata, mapped and embedded addresses", () => {
	for (const bad of [
		"10.1.2.3", "192.168.0.1", "172.16.0.9", "172.31.255.255", "127.0.0.1", "0.0.0.1",
		"169.254.169.254", "100.64.0.1", "192.0.2.1", "198.18.0.5", "224.0.0.1", "240.0.0.1",
		"::1", "::", "fe80::1", "fc00::5", "fd12::1", "ff02::1", "2001:db8::1",
		"::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:127.0.0.1",
		"64:ff9b::192.168.0.1", "2002:0a00:0001::", "not-an-address",
	]) assert.equal(isBlockedAddress(bad), true, bad);
	for (const good of ["93.184.216.34", "1.1.1.1", "2606:2800:220:1:248:1893:25c8:1946"]) assert.equal(isBlockedAddress(good), false, good);
});

// --- approval ----------------------------------------------------------------

test("approval requires http(s), approved hosts and standard ports, and refuses credentials", () => {
	assert.equal(authorizeTarget("https://example.org/x", publicOptions().policy).kind, "public");
	assert.equal(authorizeTarget("https://deep.docs.example.org/", publicOptions().policy).kind, "public");
	assert.throws(() => authorizeTarget("https://other.example.org/", publicOptions().policy), /not approved/); // sibling subdomain is not covered
	assert.throws(() => authorizeTarget("ftp://example.org/", publicOptions().policy), /scheme/);
	assert.throws(() => authorizeTarget("https://example.org:8443/", publicOptions().policy), /port/);
	assert.throws(() => authorizeTarget("https://user:pw@example.org/", publicOptions().policy), /credentials/);
	assert.throws(() => authorizeTarget("not a url", publicOptions().policy), /Invalid URL/);
	assert.equal(hostMatches("Example.ORG", "example.org"), true);
});

test("internal endpoints use a separate exact approval type", () => {
	const policy = { publicHosts: [], internal: ["http://127.0.0.1:8912", "http://fixture.test:8912"] };
	assert.equal(authorizeTarget("http://127.0.0.1:8912/api", policy).kind, "internal");
	assert.equal(authorizeTarget("http://127.0.0.1:8912/other/path", policy).kind, "internal"); // approval covers the endpoint, paths stay open
	assert.throws(() => authorizeTarget("http://127.0.0.1:8913/api", policy), /not approved/); // wrong port
	assert.throws(() => authorizeTarget("https://127.0.0.1:8912/api", policy), /not approved/); // wrong scheme
	assert.equal(authorizeTarget("http://fixture.test:8912/x", policy).endpoint, "http://fixture.test:8912");
});

// --- DNS resolution guard (no network) ----------------------------------------

test("public hosts that resolve to blocked addresses are refused before any request", async () => {
	let fetches = 0;
	const opts = publicOptions({ fetch: async () => { fetches++; throw new Error("must not be called"); } });
	for (const address of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::ffff:192.168.1.1", "fdab::1"]) {
		await assert.rejects(readWebPage("https://example.org/", { ...opts, lookup: lookupOf([address]) }), /non-public|did not resolve/);
	}
	await assert.rejects(readWebPage("https://example.org/", { ...opts, lookup: lookupOf([]) }), /did not resolve/);
	assert.equal(fetches, 0);
});

test("disabled or unapproved reads never reach the network", async () => {
	let fetches = 0;
	const fetch = async () => { fetches++; throw new Error("must not be called"); };
	await assert.rejects(readWebPage("https://example.org/", { ...publicOptions(), enabled: false, fetch }), /disabled/);
	await assert.rejects(readWebPage("https://unknown.example/", { ...publicOptions({ fetch }), lookup: lookupOf(["93.184.216.34"]) }), /not approved/);
	assert.equal(fetches, 0);
});

// --- live fixture server over the default transport ---------------------------

const internalPolicy = (port) => ({ publicHosts: [], internal: [`http://127.0.0.1:${port}`, `http://fixture.test:${port}`] });
const internalOptions = (port, extra = {}) => ({ enabled: true, policy: internalPolicy(port), ...extra });
const page = (body, headers = {}) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", ...headers } });

test("reads pages through the default transport with extraction, untrusted marking and policy scope", async () => {
	const body = "<html><head><title>Fixture &amp; Friends</title><style>.x{color:red}</style></head><body>" +
		"<script>steal()</script><!-- hidden --><h1>Hello</h1><p>A &lt;b&gt;bold&lt;/b> claim&#65;</p></body></html>";
	const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(body); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		const found = await readWebPage(`http://127.0.0.1:${port}/doc`, internalOptions(port, { lookup: lookupOf(["127.0.0.1"]) }));
		assert.equal(found.title, "Fixture & Friends");
		assert.ok(found.text.includes("Hello"));
		assert.ok(found.text.includes("A <b>bold</b> claimA"));
		assert.ok(!found.text.includes("steal") && !found.text.includes("color:red") && !found.text.includes("hidden"));
		assert.equal(found.truncated, false);
		assert.equal(found.untrusted, true);
		assert.equal(found.policy.kind, "internal-endpoint");
		assert.equal(found.cache, "miss");
		const again = await readWebPage(`http://127.0.0.1:${port}/doc`, internalOptions(port, { lookup: lookupOf(["127.0.0.1"]) }));
		assert.equal(again.cache, "miss"); // per-options cache: a fresh options object is a fresh cache entry set
	} finally { stopServer(server); }
});

test("second read of the same URL with the same options is a cache hit without refetching", async () => {
	let hits = 0;
	const server = createServer((_req, res) => { hits++; res.writeHead(200, { "content-type": "text/plain" }); res.end("plain text"); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		const options = internalOptions(port);
		const first = await readWebPage(`http://127.0.0.1:${port}/`, options);
		const second = await readWebPage(`http://127.0.0.1:${port}/`, options);
		assert.equal(first.cache, "miss");
		assert.equal(second.cache, "hit");
		assert.equal(second.retrievedAt, first.retrievedAt);
		assert.equal(hits, 1);
	} finally { stopServer(server); }
});

test("each redirect hop is re-approved; unapproved targets are refused", async () => {
	const server = createServer((req, res) => {
		if (req.url === "/hop1") { res.writeHead(302, { location: "/hop2" }); res.end(); }
		else if (req.url === "/hop2") { res.writeHead(301, { location: "http://evil.example/" }); res.end(); }
		else { res.writeHead(200, { "content-type": "text/html" }); res.end("<p>end</p>"); }
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		await assert.rejects(readWebPage(`http://127.0.0.1:${port}/hop1`, internalOptions(port)), /not approved/);
		const ok = await readWebPage(`http://127.0.0.1:${port}/redirect?to=/final`, internalOptions(port, {
			fetch: async (url) => url.searchParams.get("to") === "/final"
				? new Response(null, { status: 302, headers: { location: "/final" } })
				: page("<p>arrived</p>"),
		}));
		assert.match(ok.text, /arrived/);
	} finally { stopServer(server); }
});

test("redirect loops and count limits stop; credentials and bad locations are rejected", async () => {
	const server = createServer((_req, res) => { res.writeHead(302, { location: "/loop" }); res.end(); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		await assert.rejects(readWebPage(`http://127.0.0.1:${port}/loop`, internalOptions(port)), /redirects/);
		const redirect = async (location) => new Response(null, { status: 302, headers: { location } });
		await assert.rejects(readWebPage(`http://fixture.test:${port}/x`, internalOptions(port, { lookup: lookupOf(["127.0.0.1"]), fetch: async () => redirect(`https://u:p@fixture.test:${port}/`) })), /credentials/);
		await assert.rejects(readWebPage(`http://fixture.test:${port}/x`, internalOptions(port, { lookup: lookupOf(["127.0.0.1"]), fetch: async () => redirect("javascript:alert(1)") })), /scheme/);
		await assert.rejects(readWebPage(`http://fixture.test:${port}/x`, internalOptions(port, { lookup: lookupOf(["127.0.0.1"]), fetch: async () => redirect("http://[::1") })), /invalid Location/);
	} finally { stopServer(server); }
});

test("gzip, deflate and brotli bodies are decompressed; unknown encodings are refused", async () => {
	const server = createServer((req, res) => {
		const encoding = req.url.slice(1);
		const body = "<html><body>compressed payload</body></html>";
		const encodings = { gzip: [gzipSync(body), "gzip"], deflate: [deflateSync(body), "deflate"], br: [brotliCompressSync(body), "br"] };
		const entry = encodings[encoding];
		if (!entry) { res.writeHead(415); res.end(); return; }
		res.writeHead(200, { "content-type": "text/html", "content-encoding": entry[1] });
		res.end(entry[0]);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		for (const encoding of ["gzip", "deflate", "br"]) {
			const found = await readWebPage(`http://127.0.0.1:${port}/${encoding}`, internalOptions(port));
			assert.match(found.text, /compressed payload/, encoding);
		}
		await assert.rejects(readWebPage(`http://127.0.0.1:${port}/gzip`, internalOptions(port, {
			fetch: async () => new Response("x", { headers: { "content-type": "text/html", "content-encoding": "compress" } }),
		})), /content-encoding/);
	} finally { stopServer(server); }
});

test("oversized pages are stopped and marked truncated", async () => {
	const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("x".repeat(64 * 1024)); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		const found = await readWebPage(`http://127.0.0.1:${port}/`, internalOptions(port, { maxBytes: 4096 }));
		assert.equal(found.truncated, true);
		assert.equal(found.bytes, 4096);
		assert.equal(found.text.length, 4096);
	} finally { stopServer(server); }
});

test("stalled servers hit the timeout; cancellation propagates and never starts a request", async () => {
	const server = createServer(() => { /* never responds */ });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		await assert.rejects(readWebPage(`http://127.0.0.1:${port}/stall`, internalOptions(port, { timeoutMs: 300 })), /timeout|abort/i);
	} finally { stopServer(server); }
	let fetches = 0;
	const controller = new AbortController();
	controller.abort(new Error("cancel"));
	await assert.rejects(readWebPage("http://fixture.test/x", internalOptions(port, {
		lookup: lookupOf(["127.0.0.1"]),
		fetch: async () => { fetches++; throw new Error("must not be called"); },
	}), controller.signal), /cancel/);
	assert.equal(fetches, 0);
});

test("non-text content types and HTTP errors are refused without body extraction", async () => {
	const server = createServer((req, res) => {
		if (req.url === "/bin") { res.writeHead(200, { "content-type": "application/octet-stream" }); res.end(Buffer.from([0, 1, 2])); }
		else { res.writeHead(500, { "content-type": "text/plain" }); res.end("boom"); }
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		await assert.rejects(readWebPage(`http://127.0.0.1:${port}/bin`, internalOptions(port)), /content type/);
		await assert.rejects(readWebPage(`http://127.0.0.1:${port}/err`, internalOptions(port)), /HTTP 500/);
	} finally { stopServer(server); }
});

test("DNS answers that change between validation and connect cannot redirect the connection", async () => {
	const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("pinned"); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		// The hostname rebinds to the metadata address after the first resolution; the
		// pinned transport must still connect to the validated 127.0.0.1.
		let resolutions = 0;
		const rebindingLookup = async () => {
			resolutions++;
			return [{ address: resolutions === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }];
		};
		const seen = [];
		const found = await readWebPage(`http://fixture.test:${port}/rebind`, internalOptions(port, {
			lookup: rebindingLookup,
			onConnect: (info) => seen.push(info.address),
		}));
		assert.match(found.text, /pinned/);
		assert.deepEqual(seen, ["127.0.0.1"]);
		assert.equal(resolutions, 1); // the connect path never re-consults DNS
	} finally { stopServer(server); }
});

test("a transport that connects to an unvalidated address is aborted (rebinding guard)", async () => {
	const port = 1;
	await assert.rejects(readWebPage("https://example.org/", {
		...publicOptions({ lookup: lookupOf(["93.184.216.34"]) }),
		fetch: async (_url, init) => {
			init.onConnect?.({ host: "example.org", address: "10.9.8.7" }); // seam contract violation
			return page("<p>never</p>");
		},
	}), (error) => `${error.message} ${error.cause?.message ?? ""}`.includes("rebind"));
	assert.ok(port);
});

test("nodeTransport pins the connection address from init and reports it", async () => {
	const server = createServer((req, res) => {
		assert.ok(req.headers.host.startsWith("site.test")); // original hostname preserved on the wire
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("via pin");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		const seen = [];
		const response = await nodeTransport(new URL(`http://site.test:${port}/pin`), {
			headers: { accept: "text/plain" },
			signal: new AbortController().signal,
			pinnedAddresses: [{ address: "127.0.0.1", family: 4 }],
			onConnect: (info) => seen.push(info),
		});
		assert.equal(response.status, 200);
		const text = await new Response(response.body).text();
		assert.match(text, /via pin/);
		assert.deepEqual(seen, [{ host: "site.test", address: "127.0.0.1" }]);
	} finally { stopServer(server); }
});

test("defaultLookup returns IP literals without DNS and webReadOptionsFromEnv stays off by default", async () => {
	assert.deepEqual(await defaultLookup("127.0.0.1"), [{ address: "127.0.0.1", family: 4 }]);
	assert.deepEqual(await defaultLookup("[::1]"), [{ address: "::1", family: 6 }]);
	const fromEnv = webReadOptionsFromEnv({});
	assert.equal(fromEnv.enabled, false);
	assert.deepEqual(fromEnv.policy, { publicHosts: [], internal: [] });
	const configured = webReadOptionsFromEnv({
		PI861_WEB_READ_ENABLED: "1",
		PI861_WEB_READ_HOSTS: " example.org , *.docs.example.org ",
		PI861_WEB_READ_INTERNAL_ENDPOINTS: "http://127.0.0.1:8912",
	});
	assert.equal(configured.enabled, true);
	assert.deepEqual(configured.policy.publicHosts, ["example.org", "*.docs.example.org"]);
	assert.deepEqual(configured.policy.internal, ["http://127.0.0.1:8912"]);
});

// --- extraction and controlled references -------------------------------------

test("extraction bounds long text and strips script tails from truncated documents", () => {
	const long = extractText(`<p>${"word ".repeat(60_000)}</p>`, 1000);
	assert.equal(long.truncated, true);
	assert.equal(long.text.length, 1000);
	const tail = extractText("<p>kept</p><script>dangerous('unfinished");
	assert.ok(!tail.text.includes("dangerous"));
	assert.ok(tail.text.includes("kept"));
});

test("controlled results page long payloads instead of inlining them", () => {
	const store = new ControlledResults({ maxEntries: 2, maxTotalBytes: 100_000, ttlMs: 60_000 });
	const small = store.wrap({ a: 1 }, 1000);
	assert.equal(small.inline, true);
	const big = store.wrap({ blob: "x".repeat(200_000) }, 1000);
	assert.equal(big.inline, false);
	const first = store.read(big.reference.resultRef, 0);
	assert.equal(first.complete, false);
	assert.ok(first.nextOffset > 0);
	assert.throws(() => store.read("missing-ref", 0), /not found/);
	assert.throws(() => store.read(big.reference.resultRef, -1), /offset/);
	let assembled = first.text;
	let pages = 1;
	let finalPage = first;
	for (let offset = first.nextOffset; ; ) {
		const next = store.read(big.reference.resultRef, offset);
		assembled += next.text;
		pages++;
		finalPage = next;
		if (next.complete) break;
		offset = next.nextOffset;
	}
	assert.ok(pages > 2);
	assert.equal(finalPage.complete, true);
	assert.equal(finalPage.nextOffset, finalPage.totalCharacters);
	assert.equal(JSON.parse(assembled).blob.length, 200_000);
});

test("a controlled-result reference past its TTL fails even on the first read (wire-rev F005)", async () => {
	const store = new ControlledResults({ maxEntries: 2, maxTotalBytes: 100_000, ttlMs: 5 });
	const big = store.wrap({ blob: "x".repeat(40_000) }, 1000);
	assert.equal(big.inline, false);
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.throws(() => store.read(big.reference.resultRef, 0), /not found or expired/);
});
test("extractText stays linear on adversarial markup padding (M5 review fix)", () => {
  const hostile = "<div>start</div>" + "<script>aaaa".repeat(30_000) + "</script><div>end</div>";
  const started = Date.now();
  const { text } = extractText(hostile);
  const elapsed = Date.now() - started;
  assert.match(text, /start/);
  assert.match(text, /end/);
  assert.ok(elapsed < 2000, `linear extraction must not stall the host (took ${elapsed}ms)`);
});
test("teredo and protocol-default ports are refused (M5 review fix)", async () => {
  await assert.rejects(
    readWebPage("http://example.org/", { ...publicOptions(), lookup: lookupOf(["2001::1"]) }),
    /non-public address|refus/i,
  );
  await assert.rejects(
    readWebPage("http://example.org:443/", { ...publicOptions(), lookup: lookupOf(["93.184.216.34"]) }),
    /protocol default/,
  );
  await assert.rejects(
    readWebPage("https://example.org:80/", { ...publicOptions(), lookup: lookupOf(["93.184.216.34"]) }),
    /protocol default/,
  );
});
