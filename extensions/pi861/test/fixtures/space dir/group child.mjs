// POSIX-only fixture: spawns a grandchild that shares this process's process group, reports both
// pids, then idles. LineProcess (detached on POSIX) leads that group, so closing it must take the
// grandchild down with the group SIGTERM. Windows has no process groups; the test skips there.
import { spawn } from "node:child_process";

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
grandchild.unref();
process.stdout.write(`${JSON.stringify({ type: "group", pid: process.pid, grandchild: grandchild.pid })}\n`);
setInterval(() => {}, 1000);
