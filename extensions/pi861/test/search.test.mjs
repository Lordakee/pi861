import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSearchProvider, searchPayload, searchResults, supportedSearchProviders, webSearch } from "../src/search.ts";
const opts = (impl) => ({ enabled: true, apiKey: "test-only-placeholder", fetch: impl });
const response = (results) => Response.json({ web: { results } });
test("disabled or missing-key search does not call a backend", async () => {
	let calls = 0;
	const fake = async () => { calls++; return response([]); };
	await assert.rejects(webSearch("test", { ...opts(fake), enabled: false }), /disabled/);
	await assert.rejects(webSearch("test", { ...opts(fake), apiKey: undefined }), /Missing/);
	assert.equal(calls, 0);
});
test("uses fixed endpoint and credential header, never a query-string key", async () => {
	const found = await webSearch("TypeScript docs", opts(async (url, config) => {
		assert.equal(url.origin, "https://api.search.brave.com");
		assert.equal(url.searchParams.get("q"), "TypeScript docs");
		assert.equal(url.searchParams.has("api_key"), false);
		assert.equal(config.headers["X-Subscription-Token"], "test-only-placeholder");
		assert.equal(config.redirect, "error");
		return response([{ title: "Docs", url: "https://example.org/docs", description: "A reference" }]);
	}));
	assert.equal(found.results[0].url, "https://example.org/docs");
	assert.equal(found.truncated, false);
	assert.ok(found.retrievedAt);
});
test("query and result limits are validated", async () => {
	for (const query of ["", "x".repeat(601), Array(76).fill("word").join(" ")]) {
		await assert.rejects(webSearch(query, opts(async () => response([]))), /query/);
	}
	await assert.rejects(webSearch("ok", { ...opts(async () => response([])), maxResults: 99 }), /limits/);
});
test("unsafe result links are omitted and omission is visible", async () => {
	const found = await webSearch("query", opts(async () => response([
		{ title: "unsafe", url: "javascript:alert(1)", description: "x" },
		{ title: "credentials", url: "https://user:password@example.org", description: "x" },
	])));
	assert.equal(found.results.length, 0);
	assert.equal(found.truncated, true);
});
test("oversized body is stopped before full parsing", async () => {
	await assert.rejects(webSearch("query", { ...opts(async () => new Response("x".repeat(2048))), maxResponseBytes: 1024 }), /byte limit/);
});
test("error body containing credentials is not reflected", async () => {
	await assert.rejects(webSearch("query", opts(async () => new Response("SECRET-KEY", { status: 429 }))),
		(error) => error.message === "Search backend returned HTTP 429");
});
test("malformed service payload is not reported as successful zero hits", async () => {
	await assert.rejects(webSearch("query", opts(async () => Response.json({}))), /lacks/);
	await assert.rejects(webSearch("query", opts(async () => Response.json({ web: { results: "wrong" } }))), /Malformed/);
});
test("truncated snippets are marked", async () => {
	const found = await webSearch("query", opts(async () => response([{ title: "x", url: "https://example.org", description: "a".repeat(2100) }])));
	assert.equal(found.truncated, true);
	assert.equal(found.results[0].snippet.length, 2000);
});
test("a cancelled request never reaches the network", async () => {
	const controller = new AbortController();
	controller.abort(new Error("cancel"));
	let calls = 0;
	await assert.rejects(webSearch("query", opts(async () => { calls++; return response([]); }), controller.signal), /cancel/);
	assert.equal(calls, 0);
});
test("only implemented providers are reported and selectable", async () => {
	assert.deepEqual(supportedSearchProviders(), ["brave"]);
	assert.equal(resolveSearchProvider(undefined).id, "brave");
	let calls = 0;
	const fake = async () => { calls++; return response([]); };
	assert.throws(() => resolveSearchProvider("google"), /Unsupported search provider "google"; implemented: brave/);
	await assert.rejects(webSearch("q", { ...opts(fake), provider: "bing" }), /Unsupported search provider "bing"/);
	assert.equal(calls, 0);
});
test("long search results become paged references instead of inline JSON", async () => {
	const hits = Array.from({ length: 10 }, (_, index) => ({ title: `t${index}`, url: `https://example.org/${index}`, description: "d".repeat(2000) }));
	const found = await webSearch("query", { ...opts(async () => response(hits)), maxResults: 10 });
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
