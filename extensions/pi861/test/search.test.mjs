import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSearchProvider, searchOptionsFromEnv, searchPayload, searchResults, supportedSearchProviders, webSearch } from "../src/search.ts";
const sx = (impl) => ({ enabled: true, searxngUrl: "http://127.0.0.1:8888", fetch: impl });
const searxngResponse = (results) => Response.json({ results });
test("disabled or unconfigured search does not call a backend", async () => {
	let calls = 0;
	const fake = async () => { calls++; return searxngResponse([]); };
	await assert.rejects(webSearch("test", { ...sx(fake), enabled: false }), /disabled/);
	await assert.rejects(webSearch("test", { enabled: true, fetch: fake }), /No search backend configured; set PI861_SEARCH_SEARXNG_URL/);
	await assert.rejects(webSearch("test", { enabled: true, provider: "searxng", fetch: fake }), /No search backend configured/);
	assert.equal(calls, 0);
});
test("query and result limits are validated", async () => {
	for (const query of ["", "x".repeat(601), Array(76).fill("word").join(" ")]) {
		await assert.rejects(webSearch(query, sx(async () => searxngResponse([]))), /query/);
	}
	await assert.rejects(webSearch("ok", { ...sx(async () => searxngResponse([])), maxResults: 99 }), /limits/);
});
test("unsafe result links are omitted and omission is visible", async () => {
	const found = await webSearch("query", sx(async () => searxngResponse([
		{ title: "unsafe", url: "javascript:alert(1)", content: "x" },
		{ title: "credentials", url: "https://user:password@example.org", content: "x" },
	])));
	assert.equal(found.results.length, 0);
	assert.equal(found.truncated, true);
});
test("oversized body is stopped before full parsing", async () => {
	await assert.rejects(webSearch("query", { ...sx(async () => new Response("x".repeat(2048))), maxResponseBytes: 1024 }), /byte limit/);
});
test("error body containing credentials is not reflected", async () => {
	await assert.rejects(webSearch("query", sx(async () => new Response("SECRET-KEY", { status: 429 }))),
		(error) => error.message === "Search backend returned HTTP 429");
});
test("only implemented providers are reported and selectable", async () => {
	assert.deepEqual(supportedSearchProviders(), ["searxng"]);
	assert.equal(resolveSearchProvider(undefined).id, "searxng");
	assert.equal(resolveSearchProvider("searxng").id, "searxng");
	let calls = 0;
	const fake = async () => { calls++; return searxngResponse([]); };
	assert.throws(() => resolveSearchProvider("google"), /Unsupported search provider "google"; implemented: searxng/);
	await assert.rejects(webSearch("q", { ...sx(fake), provider: "bing" }), /Unsupported search provider "bing"/);
	assert.equal(calls, 0);
});
test("searxng searches only the configured instance without any credential", async () => {
	const found = await webSearch("TypeScript docs", sx(async (url, config) => {
		assert.equal(url.origin, "http://127.0.0.1:8888");
		assert.equal(url.pathname, "/search");
		assert.equal(url.searchParams.get("q"), "TypeScript docs");
		assert.equal(url.searchParams.get("format"), "json");
		assert.deepEqual(config.headers, { Accept: "application/json" });   // no token header anywhere
		assert.equal(config.redirect, "error");
		return searxngResponse([{ title: "Docs", url: "https://example.org/docs", content: "A reference" }]);
	}));
	assert.equal(found.provider, "searxng");
	assert.deepEqual(found.results, [{ title: "Docs", url: "https://example.org/docs", snippet: "A reference" }]);
	assert.equal(found.truncated, false);
	assert.ok(found.retrievedAt);
});
test("searxng malformed payloads are not reported as zero hits; empty results are", async () => {
	await assert.rejects(webSearch("query", sx(async () => Response.json({}))), /lacks/);
	await assert.rejects(webSearch("query", sx(async () => Response.json({ results: "wrong" }))), /Malformed/);
	const empty = await webSearch("query", sx(async () => searxngResponse([])));
	assert.deepEqual(empty.results, []);
	assert.equal(empty.truncated, false);
});
test("searxng truncation, unsafe links and size/cancel bounds reuse the shared paths", async () => {
	const over = await webSearch("query", sx(async () => searxngResponse([
		{ title: "t", url: "https://example.org", content: "a".repeat(2100) },
		{ title: "u", url: "javascript:alert(1)", content: "x" },
	])));
	assert.equal(over.truncated, true);
	assert.equal(over.results.length, 1);
	assert.equal(over.results[0].snippet.length, 2000);
	await assert.rejects(webSearch("query", { ...sx(async () => new Response("x".repeat(2048))), maxResponseBytes: 1024 }), /byte limit/);
	const controller = new AbortController();
	controller.abort(new Error("cancel"));
	let calls = 0;
	await assert.rejects(webSearch("query", sx(async () => { calls++; return searxngResponse([]); }), controller.signal), /cancel/);
	assert.equal(calls, 0);
});
test("env parsing keeps search default-off and never reaches the network unconfigured", async () => {
	const off = searchOptionsFromEnv({});
	assert.equal(off.enabled, false);
	let calls = 0;
	await assert.rejects(webSearch("q", { ...off, fetch: async () => { calls++; return searxngResponse([]); } }), /disabled/);
	assert.equal(calls, 0);
	assert.deepEqual(
		searchOptionsFromEnv({ PI861_WEB_SEARCH_ENABLED: "1", PI861_SEARCH_SEARXNG_URL: " http://127.0.0.1:8888 " }),
		{ enabled: true, searxngUrl: "http://127.0.0.1:8888" },
	);
});
test("long search results become paged references instead of inline JSON", async () => {
	const hits = Array.from({ length: 10 }, (_, index) => ({ title: `t${index}`, url: `https://example.org/${index}`, content: "d".repeat(2000) }));
	const found = await webSearch("query", { ...sx(async () => searxngResponse(hits)), maxResults: 10 });
	assert.equal(found.results.length, 10);
	const payload = searchPayload(found, 4000);
	assert.equal(payload.inline, false);
	assert.match(payload.reference.instruction, /resultRef/i);
	assert.ok(payload.reference.totalCharacters > 4000);
	const page = searchResults.read(payload.reference.resultRef, 0);
	assert.equal(page.complete, false);
	assert.ok(page.text.startsWith("{\"query\""));
	const inline = searchPayload(found, 100_000);
	assert.equal(inline.inline, true);
	assert.equal(inline.value.results.length, 10);
});
