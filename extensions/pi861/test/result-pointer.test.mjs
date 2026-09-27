import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStateStore } from "../src/live/store.ts";
import { SkillRepository, emptySkillState } from "../src/live/skill-repository.ts";

// R5.8 field-level reads: readResult accepts an RFC 6901 pointer. Pointer evaluation happens
// only after the existing owner authorization, so a pointer can never widen read access.
function setup(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi861-ptr-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return new SkillRepository(new FileStateStore(join(directory, "skills.json"), emptySkillState()));
}
const principalOwner = {
	owner: "principal",
	tenantId: "t1",
	principalId: "main",
	roleId: "developer",
	toolName: "bash",
	toolCallId: "call-1",
};
const principalReader = { tenantId: "t1", principalId: "main", role: { id: "developer", skillIds: [], grants: [] } };
const doc = {
	title: "report",
	"a/b": "slash key",
	"m~n": "tilde key",
	count: 0,
	enabled: false,
	note: null,
	empty: "",
	tags: ["alpha", "beta"],
	rows: [
		{ id: 1, cells: ["x", "y"] },
		{ id: 2, cells: [] },
	],
};

test("pointer selects fields with root, escapes, arrays and legal falsy values (R5.8)", async (t) => {
	const repo = setup(t);
	const ref = await repo.storeResult(doc, principalOwner);
	assert.equal(JSON.parse((await repo.readResult(ref, principalReader, 0, "")).text).title, "report"); // empty pointer = root
	assert.equal((await repo.readResult(ref, principalReader, 0, "/title")).text, '"report"');
	assert.equal((await repo.readResult(ref, principalReader, 0, "/a~1b")).text, '"slash key"'); // ~1 -> /
	assert.equal((await repo.readResult(ref, principalReader, 0, "/m~0n")).text, '"tilde key"'); // ~0 -> ~
	assert.equal((await repo.readResult(ref, principalReader, 0, "/tags/0")).text, '"alpha"');
	assert.equal((await repo.readResult(ref, principalReader, 0, "/tags/1")).text, '"beta"');
	assert.deepEqual(JSON.parse((await repo.readResult(ref, principalReader, 0, "/rows/1")).text), { id: 2, cells: [] });
	assert.deepEqual(JSON.parse((await repo.readResult(ref, principalReader, 0, "/rows/1/cells")).text), []);
	// Legal null/false/0/"" are selected values, not "missing".
	assert.equal((await repo.readResult(ref, principalReader, 0, "/note")).text, "null");
	assert.equal((await repo.readResult(ref, principalReader, 0, "/enabled")).text, "false");
	assert.equal((await repo.readResult(ref, principalReader, 0, "/count")).text, "0");
	assert.equal((await repo.readResult(ref, principalReader, 0, "/empty")).text, '""');
});

test("illegal pointers, array boundaries, prototype names and missing paths are rejected (R5.8)", async (t) => {
	const repo = setup(t);
	const ref = await repo.storeResult(doc, principalOwner);
	for (const pointer of [
		"title", // not pointer syntax: no leading slash
		"#/title", // URI fragment form
		"/a~2b", // illegal escape
		"/m~", // dangling escape
		"/ti?le", // query expression
		"/tags/*", // wildcard
		"/*", // wildcard
	]) await assert.rejects(repo.readResult(ref, principalReader, 0, pointer), /JSON Pointer/);
	for (const pointer of [
		"/tags/2", // out of bounds
		"/tags/-", // append marker is not a readable index
		"/tags/01", // leading zero
		"/tags/x",
	]) await assert.rejects(repo.readResult(ref, principalReader, 0, pointer), /JSON Pointer/);
	for (const pointer of ["/constructor", "/__proto__"]) // inherited names are not addressable
		await assert.rejects(repo.readResult(ref, principalReader, 0, pointer), /not found/);
	await assert.rejects(repo.readResult(ref, principalReader, 0, "/missing"), /not found/);
	await assert.rejects(repo.readResult(ref, principalReader, 0, "/title/length"), /scalar/); // crossing a scalar
	await assert.rejects(repo.readResult(ref, principalReader, 0, "/note/x"), /scalar/); // crossing null
});

test("pointer evaluation happens only after owner authorization (R5.8/R6.7)", async (t) => {
	const repo = setup(t);
	const ref = await repo.storeResult(doc, principalOwner);
	// Unauthorized readers get the authorization error, never a pointer or content error, and a
	// pointer cannot bypass authorization for an authorized reader of a different artifact.
	await assert.rejects(repo.readResult(ref, { ...principalReader, principalId: "other" }, 0, "/title"), /not found/);
	await assert.rejects(
		repo.readResult(ref, { ...principalReader, role: { id: "reviewer", skillIds: [], grants: [] } }, 0, "/title"),
		/not found/,
	);
	const binding = { toolId: "local/lookup", accountId: "a", resourceId: "p", schemaHash: "h", phase: "execute" };
	const skillRef = await repo.storeResult({ secret: "sk-live", rows: [1] }, { owner: "skill", roleId: "developer", skillId: "debug", binding });
	const role = {
		id: "developer",
		skillIds: ["debug"],
		grants: [{ toolId: "local/lookup", accountId: "a", resourceIds: ["p"] }],
	};
	assert.equal((await repo.readResult(skillRef, { role }, 0, "/rows/0")).text, "1");
	await assert.rejects(repo.readResult(skillRef, { role: { ...role, grants: [] } }, 0, "/rows/0"), /not found/); // grant revoked
	await assert.rejects(repo.readResult(skillRef, { role: { ...role, skillIds: [] } }, 0, "/rows/0"), /not found/); // Skill revoked
	assert.rejects(repo.readResult(ref, { role }, 0, "/secret"), /not found/); // skill reader is not the principal owner
});

test("selected values paginate over their own serialization (R5.8)", async (t) => {
	const repo = setup(t);
	const ref = await repo.storeResult({ summary: "s", body: "y".repeat(17_000) }, principalOwner);
	const first = await repo.readResult(ref, principalReader, 0, "/body");
	assert.equal(first.complete, false);
	assert.equal(first.totalCharacters, JSON.stringify("y".repeat(17_000)).length); // selected value, not the artifact
	assert.equal(first.text, '"' + "y".repeat(15_999)); // 16_000 characters of the quoted serialization
	const last = await repo.readResult(ref, principalReader, first.nextOffset, "/body");
	assert.equal(last.complete, true);
	assert.equal(last.text, "y".repeat(1_001) + '"');
	const whole = await repo.readResult(ref, principalReader); // root still pages over the whole artifact
	assert.ok(whole.totalCharacters > 17_000);
	await assert.rejects(repo.readResult(ref, principalReader, first.totalCharacters + 1, "/body"), /offset/); // bounds follow the selection
});
