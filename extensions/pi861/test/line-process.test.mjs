import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LineProcess } from "../src/live/line-process.ts";

// Every path involved (fixture, cwd, data file) contains spaces; LineProcess must pass them
// verbatim because it spawns with an argument array and shell: false on both platforms.
const fixture = fileURLToPath(new URL("./fixtures/space dir/protocol worker.mjs", import.meta.url));
const groupFixture = fileURLToPath(new URL("./fixtures/space dir/group child.mjs", import.meta.url));
const signal = () => new AbortController().signal;

function spacedRoot() {
	// "pi861 lp " ends in a space, so mkdtemp's random suffix keeps a space inside the directory name.
	const root = mkdtempSync(join(tmpdir(), "pi861 lp "));
	const cwd = join(root, "work dir");
	mkdirSync(cwd);
	writeFileSync(join(root, "data file.txt"), "payload with spaces");
	return { root, cwd, data: join(root, "data file.txt") };
}

test("spaced executable, cwd, argv and file paths arrive unquoted on both platforms", async () => {
	const { root, cwd, data } = spacedRoot();
	try {
		const process_ = new LineProcess(
			{ command: process.execPath, args: [fixture, "argument with spaces"], cwd },
		);
		const response = await process_.request({ type: "inspect", path: data }, signal());
		assert.equal(response.cwd, cwd); // real child cwd, not a shell remnant
		assert.deepEqual(response.argv.slice(-2), [fixture, "argument with spaces"]); // one argv entry each: no shell splitting
		assert.equal(response.data, "payload with spaces"); // child read the spaced data path itself
		await process_.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("close resolves only after exit and rejects pending requests on both platforms", async () => {
	const { root, cwd } = spacedRoot();
	try {
		const process_ = new LineProcess({ command: process.execPath, args: [fixture], cwd });
		const events = [];
		process_.onEvent((event) => events.push(event));
		assert.match(JSON.stringify(await process_.request({ type: "ping" }, signal())), /response/);
		const pending = process_.request({ type: "silence" }, signal(), 60_000); // fixture deliberately never answers
		const rejected = assert.rejects(pending, /closed by owner/); // attach before close: no unhandled-rejection window
		await process_.close(); // resolves once the child is fully gone
		await rejected; // pending work is failed, not leaked
		assert.deepEqual(events, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a child that cannot start fails pending requests on both platforms", async () => {
	const { root, cwd } = spacedRoot();
	try {
		const process_ = new LineProcess({ command: join(cwd, "missing tool 861"), args: [], cwd });
		await assert.rejects(process_.request({ type: "silence" }, signal(), 5_000), /could not start|closed/);
		await process_.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// POSIX sends SIGTERM to the child's whole process group (LineProcess spawns detached there).
// Windows kill semantics terminate the direct child only — no process groups exist — so this
// assertion is skipped there rather than approximated.
test(
	"POSIX: close terminates the child's whole process group",
	{
		skip:
			process.platform === "win32"
				? "Windows terminates the direct child only; POSIX process-group SIGTERM has no equivalent"
				: false,
	},
	async () => {
		const { root, cwd } = spacedRoot();
		try {
			const process_ = new LineProcess({ command: process.execPath, args: [groupFixture], cwd });
			const group = await new Promise((resolve) =>
				process_.onEvent((event) => {
					if (event.type === "group") resolve(event);
				}),
			);
			await process_.close();
			const alive = (pid) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			const deadline = Date.now() + 5_000;
			while (alive(group.grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
			assert.equal(alive(group.pid), false, "group leader exited");
			assert.equal(alive(group.grandchild), false, "grandchild died with the group");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
