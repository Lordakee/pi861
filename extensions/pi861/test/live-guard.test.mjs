import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp,mkdir,symlink,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardWorkerTool, workerIsolationBoundary } from "../src/live/worker-guard.ts";
test("native worker paths are constrained before dispatch",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pi861-guard-"));try{
 const root=join(dir,"work"),outside=join(dir,"outside");await mkdir(root);await mkdir(outside);await mkdir(join(root,"module"));await symlink(outside,join(root,"link"));
 const guard={root,writeScopes:["module"],allowShell:false};
 guardWorkerTool(guard,"write",{path:"module/new.ts"});assert.throws(()=>guardWorkerTool(guard,"write",{path:"other.ts"}),/reservation/);
 assert.throws(()=>guardWorkerTool(guard,"read",{path:"../outside"}),/escapes/);assert.throws(()=>guardWorkerTool(guard,"read",{path:"link/key"}),/outside/);
 assert.throws(()=>guardWorkerTool(guard,"edit",{path:".git/config"}),/escapes/);assert.throws(()=>guardWorkerTool(guard,"bash",{command:"anything"}),/disabled/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("isolation boundary is declared explicitly and never overstated",()=>{
 const boundary=workerIsolationBoundary();
 assert.equal(boundary.osSandbox,"none");
 assert.ok(boundary.enforced.some(item=>/write scopes/.test(item)));
 assert.ok(boundary.enforced.some(item=>/symlinks/.test(item)));
 assert.ok(boundary.enforced.some(item=>/shell tools/.test(item)));
 assert.ok(boundary.notEnforced.some(item=>/network/i.test(item)));
 assert.ok(boundary.notEnforced.some(item=>/CPU/.test(item)));
 assert.ok(boundary.notEnforced.some(item=>/not sandboxed/.test(item)));
});
