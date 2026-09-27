import assert from "node:assert/strict";
import { test } from "node:test";
import { SkillCatalog, authorizeInvocation } from "../src/capabilities.ts";

function fixture() {
	const catalog = new SkillCatalog();
	const raw = { id: "vendor-debug", revision: "v1", files: { "SKILL.md": "Reproduce before changing code.", "scripts/check.sh": "echo check" } };
	const hash = catalog.archive(raw);
	const binding = { toolId: "browser.logs", accountId: "a1", resourceId: "project1", schemaHash: "hash1", phase: "inspect" };
	const skill = { id: "debug", revision: "r1", title: "Debug", category: "code", instructions: "Never infer success without evidence.",
		sources: [{ id: raw.id, revision: raw.revision, hash }],
		branches: [
			{ id: "browser", when: "Evidence points to client rendering", instructions: "Inspect console.", environment: ["browser"],
				conflictsWith: ["offline"], tools: [binding] },
			{ id: "offline", when: "No browser is available", instructions: "Read existing evidence.", environment: [],
				conflictsWith: ["browser"], tools: [] },
		] };
	catalog.publish(skill);
	const role = { id: "reviewer", skillIds: ["debug"], grants: [{ toolId: "browser.logs", accountId: "a1", resourceIds: ["project1"] }] };
	const definitions = [{ id: "browser.logs", schemaHash: "hash1" }];
	return { catalog, raw, hash, skill, role, definitions };
}
test("raw skills are archived but absent from automatic browsing", () => {
	const f = fixture();
	assert.deepEqual(f.catalog.browse(f.role).map((x) => x.id), ["debug"]);
	assert.equal(f.catalog.readOriginal("vendor-debug", "v1").files["SKILL.md"], f.raw.files["SKILL.md"]);
});
test("original and published versions cannot silently change", () => {
	const f = fixture();
	assert.throws(() => f.catalog.archive({ ...f.raw, files: { "SKILL.md": "Changed" } }), /immutable/);
	assert.throws(() => f.catalog.publish({ ...f.skill, instructions: "Changed" }), /immutable/);
});
test("source path traversal and unknown source hashes are rejected", () => {
	const f = fixture();
	assert.throws(() => f.catalog.archive({ ...f.raw, revision: "v2", files: { "SKILL.md": "x", "../escape": "x" } }), /Unsafe/);
	assert.throws(() => f.catalog.publish({ ...f.skill, revision: "r2", sources: [{ id: "absent", revision: "x", hash: "x" }] }), /source/);
});
test("activating a skill returns only its selected phase bindings", () => {
	const f = fixture();
	const activation = f.catalog.activate(f.role, "debug", "r1", ["browser"], "inspect", ["browser"], f.definitions);
	assert.equal(activation.tools.length, 1);
	assert.match(activation.instructions, /Never infer/);
	assert.match(activation.instructions, /Inspect console/);
	assert.equal(f.catalog.activate(f.role, "debug", "r1", ["browser"], "report", ["browser"], f.definitions).tools.length, 0);
});
test("unauthorized required tool does not silently disappear", () => {
	const f = fixture();
	assert.throws(() => f.catalog.activate({ ...f.role, grants: [] }, "debug", "r1", ["browser"], "inspect", ["browser"], f.definitions), /authorized/);
	assert.deepEqual(f.catalog.branches({ ...f.role, grants: [] }, "debug").map((x) => x.id), ["offline"]);
});
test("environment and mutually exclusive branches are checked", () => {
	const f = fixture();
	assert.throws(() => f.catalog.activate(f.role, "debug", "r1", ["browser"], "inspect", [], f.definitions), /prerequisites/);
	assert.throws(() => f.catalog.activate(f.role, "debug", "r1", ["browser", "offline"], "inspect", ["browser"], f.definitions), /Conflicting/);
});
test("interface drift prevents activation", () => {
	const f = fixture();
	assert.throws(() => f.catalog.activate(f.role, "debug", "r1", ["browser"], "inspect", ["browser"], []), /schema/);
});
test("every invocation checks current grants and exact account/resource", () => {
	const f = fixture();
	const a = f.catalog.activate(f.role, "debug", "r1", ["browser"], "inspect", ["browser"], f.definitions);
	assert.equal(authorizeInvocation(a, f.role, f.definitions, a.tools[0]).toolId, "browser.logs");
	assert.throws(() => authorizeInvocation(a, { ...f.role, grants: [] }, f.definitions, a.tools[0]), /authorized/);
	assert.throws(() => authorizeInvocation(a, f.role, f.definitions, { ...a.tools[0], resourceId: "project2" }), /authorized/);
	assert.throws(() => authorizeInvocation(a, f.role, [{ id: "browser.logs", schemaHash: "changed" }], a.tools[0]), /schema/);
});
test("new publications do not mutate already-pinned versions", () => {
	const f = fixture();
	f.catalog.publish({ ...f.skill, revision: "r2", instructions: "New verified instructions" });
	const a = f.catalog.activate(f.role, "debug", "r1", ["offline"], "inspect", [], []);
	assert.match(a.instructions, /Never infer/);
	assert.equal(f.catalog.browse(f.role)[0].revision, "r2");
});
test("rolled-back revisions are fenced from new activation; running activations keep authorizing (AX5/R4.10)", () => {
	const f = fixture();
	const running = f.catalog.activate(f.role, "debug", "r1", ["browser"], "inspect", ["browser"], f.definitions);
	f.catalog.publish({ ...f.skill, revision: "r2", instructions: "New verified instructions" });
	f.catalog.revoke("debug", "r1"); // rollback withdrew r1 from new activations
	assert.throws(
		() => f.catalog.activate(f.role, "debug", "r1", ["browser"], "inspect", ["browser"], f.definitions),
		/rolled back.*active revision is r2/,
	);
	assert.equal(f.catalog.activate(f.role, "debug", "r2", ["offline"], "inspect", [], []).skillRevision, "r2"); // the active revision activates
	assert.equal(authorizeInvocation(running, f.role, f.definitions, running.tools[0]).toolId, "browser.logs"); // the pinned snapshot keeps authorizing
});
test("returned data cannot mutate archived sources or grants", () => {
	const f = fixture();
	f.catalog.readOriginal("vendor-debug", "v1").files["SKILL.md"] = "mutated";
	assert.notEqual(f.catalog.readOriginal("vendor-debug", "v1").files["SKILL.md"], "mutated");
	assert.deepEqual(f.catalog.browse({ ...f.role, skillIds: [] }), []);
});
