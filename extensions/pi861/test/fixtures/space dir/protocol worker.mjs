// Cross-platform protocol fixture whose own path contains a space. LineProcess must hand the
// executable, cwd and file paths through verbatim (spawn args array, shell disabled), so a
// successful request/response round trip proves nothing was shell-quoted or split.
import { readFileSync } from "node:fs";

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	while (buffer.includes("\n")) {
		const end = buffer.indexOf("\n");
		const line = buffer.slice(0, end).replace(/\r$/, "");
		buffer = buffer.slice(end + 1);
		if (!line.trim()) continue;
		const request = JSON.parse(line);
		if (!request.id || request.type === "silence") continue; // silence: reserved for pending-close tests
		const payload =
			request.type === "inspect"
				? { cwd: process.cwd(), argv: process.argv, data: readFileSync(request.path, "utf8") }
				: {};
		process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, ...payload })}\n`);
	}
});
