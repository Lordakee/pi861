import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStateStore } from "../src/live/store.ts";
import { ProjectCoordinator,emptyProject,RollingPlanner,projectGoalCommand } from "../src/live/coordinator.ts";
import { ProjectRunner } from "../src/live/project-runner.ts";
import { Workspaces } from "../src/live/workspace.ts";
const exec=promisify(execFile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(predicate,timeout=10000,interval=15){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(interval);}throw new Error("condition not reached in time");}
const pass=()=>({id:"verify",command:process.execPath,args:["-e","if(!require('fs').existsSync('README'))process.exit(1)"]});
const worker=()=>({identity:{id:"w0",capabilities:[],roleIds:["dev"],modelIds:["test"]},process:ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:ws.path})});
const spec=id=>({task:{id,title:id,dependsOn:id==="C"?["A"]:[],writeScopes:[`${id.toLowerCase()}.txt`],capabilities:[],acceptance:["Candidate check succeeds"]},execution:{instructions:`implement ${id}`,roleId:"dev",modelId:"test",checkIds:["verify"]}});
async function repo(){const root=await mkdtemp(join(tmpdir(),"pi861-project-"));const path=join(root,"repo");await mkdir(path);await exec("git",["init",path]);await writeFile(join(path,"README"),"fixture\n");await exec("git",["add","README"],{cwd:path});await exec("git",["-c","user.name=Test","-c","user.email=test@localhost","commit","-m","base"],{cwd:path});return {root,path};}
test("actual child processes refill before unrelated slow job, then verify and integrate",async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("fixture goal",base,[spec("A"),spec("B"),spec("C")]);
 const trace=join(root,"trace");const events=[];const integration=await workspace.create("integration",1,base);
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[{id:"verify",command:process.execPath,args:["-e","if(!require('fs').existsSync('README'))process.exit(1)"]}],
 workers:[0,1].map(id=>({identity:{id:`w${id}`,capabilities:[],roleIds:["dev"],modelIds:["test"]},process:ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:ws.path,env:{TRACE:trace}})})),onProgress:e=>events.push(`${e.taskId}:${e.state}`)});
 await runner.start();
 assert.equal((await coordinator.state()).status,"review");assert.ok(events.indexOf("C:running")<events.indexOf("B:done"),events.join(","));
 assert.equal(await readFile(join(integration.path,"c.txt"),"utf8"),"C");assert.equal(await workspace.head(),base,"main must remain unchanged");
 await coordinator.control("accept");assert.equal((await coordinator.state()).status,"completed");
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("task ownership, role/model matching and versioned append are enforced",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-coordinator-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("goal","a".repeat(40),[spec("A")]);
 assert.equal(await coordinator.claim({id:"bad",capabilities:[],roleIds:["reader"],modelIds:["test"]},"bad"),null);
 const worker={id:"good",capabilities:[],roleIds:["dev"],modelIds:["test"]};const claim=await coordinator.claim(worker,"claim");
 assert.deepEqual(await coordinator.claim(worker,"claim"),claim);await assert.rejects(coordinator.submit("bad",claim.task.lease,["x"],"s"));
 await assert.rejects(coordinator.append([spec("B")],0));await coordinator.submit("good",claim.task.lease,["x"],"s");
 assert.equal((await coordinator.state()).board.tasks[0].status,"review");
 await coordinator.verify(claim.task.lease,{accepted:true,evidence:["verified"]},"v");assert.equal((await coordinator.state()).status,"review");
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("scope check rejects out of module changes",async()=>{const {root,path}=await repo();try{
 const service=new Workspaces(path,join(root,"trees"));const ws=await service.create("scopes",1,await service.head());await writeFile(join(ws.path,"outside.txt"),"x");await assert.rejects(service.changed(ws,["module"]),/unreserved/);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}});
test("AX1 second half: an idle runner is woken by rolling appends without recreation",{timeout:30000},async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("rolling goal",base,[spec("A")],{planOpen:true});
 const integration=await workspace.create("integration",1,base);
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[pass()],workers:[worker(),{...worker(),identity:{...worker().identity,id:"w1"}}],idlePollMs:100});
 const settled=runner.start();
 await waitFor(async()=>(await coordinator.state()).board.tasks.every(task=>task.status==="done"));
 assert.equal((await coordinator.state()).status,"active","open plan must keep the runner alive");
 await coordinator.append([spec("B")],(await coordinator.state()).board.version);
 await waitFor(async()=>(await coordinator.state()).board.tasks.some(task=>task.id==="B"&&task.status==="done"));
 await coordinator.seal((await coordinator.state()).board.version);
 await settled;
 assert.equal((await coordinator.state()).status,"review");
 assert.equal(await readFile(join(integration.path,"b.txt"),"utf8"),"B");
 await coordinator.control("accept");
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("integration lease defers merging behind a live holder",{timeout:30000},async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:1,maxAttempts:2});
 await coordinator.create("leased goal",base,[spec("A")]);
 const integration=await workspace.create("integration",1,base);
 const rogue=await coordinator.acquireIntegration("rogue:process",integration.path,{ttlMs:60_000});
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[pass()],workers:[worker()],idlePollMs:100,integrationLeaseMs:5_000});
 const settled=runner.start();
 await waitFor(async()=>(await coordinator.state()).board.tasks[0].status==="review");
 assert.equal((await exec("git",["rev-parse","HEAD"],{cwd:integration.path})).stdout.trim(),base,"no merge before the lease is released");
 await coordinator.releaseIntegration("rogue:process",rogue.generation);
 await settled;
 assert.equal((await coordinator.state()).status,"review");
 assert.equal(await readFile(join(integration.path,"a.txt"),"utf8"),"A");
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("verify rejects stale integration generations; takeover requires converged git",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-lease-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("p")),{maxConcurrent:1,maxAttempts:2});
 await coordinator.create("goal","a".repeat(40),[spec("A")]);
 const identity={id:"w",capabilities:[],roleIds:["dev"],modelIds:["test"]};
 const claim=await coordinator.claim(identity,"c1");
 await coordinator.submit("w",claim.task.lease,["x"],"s1");
 const first=await coordinator.acquireIntegration("integrator:a","/tmp/ws",{ttlMs:60_000});
 await assert.rejects(coordinator.acquireIntegration("integrator:b","/tmp/ws",{ttlMs:60_000}),/held/);
 await assert.rejects(coordinator.verify(claim.task.lease,{accepted:true,evidence:["e"]},"v1","b".repeat(40),first.generation+5),/Stale integration generation/);
 await coordinator.verify(claim.task.lease,{accepted:true,evidence:["e"]},"v2","b".repeat(40),first.generation);
 await coordinator.releaseIntegration("integrator:a",first.generation);
 const expiring=await coordinator.acquireIntegration("integrator:c","/tmp/ws",{ttlMs:1});
 await sleep(20);
 await assert.rejects(coordinator.acquireIntegration("integrator:d","/tmp/ws",{probe:()=>"/repo/.git/worktrees/x/index.lock"}),/converged/);
 const takeover=await coordinator.acquireIntegration("integrator:d","/tmp/ws",{probe:()=>undefined});
 assert.equal(takeover.generation,expiring.generation+1);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("git lock probe detects real worktree locks",async()=>{const {root,path}=await repo();try{
 const service=new Workspaces(path,join(root,"trees"));const ws=await service.create("locks",1,await service.head());
 assert.equal(service.gitLocks(ws).length,0);
 const gitdir=(await readFile(join(ws.path,".git"),"utf8")).replace("gitdir:","").trim();
 await writeFile(join(gitdir,"index.lock"),"");
 assert.deepEqual(service.gitLocks(ws),[join(gitdir,"index.lock")]);
 await mkdir(join(gitdir,"refs","heads","feature"),{recursive:true}); // m4rev-F007: refs/**/*.lock
 await writeFile(join(gitdir,"refs","heads","feature","topic.lock"),"");
 await writeFile(join(gitdir,"MERGE_HEAD"),""); // an unconcluded merge still owns the tree
 assert.deepEqual(service.gitLocks(ws).sort(),[join(gitdir,"MERGE_HEAD"),join(gitdir,"index.lock"),join(gitdir,"refs","heads","feature","topic.lock")].sort());
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}});
test("failed integration leaves a tracked, resolvable repair entry",{timeout:30000},async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const strict={id:"strict",command:process.execPath,args:["-e","if(require('fs').existsSync('a.txt'))process.exit(1)"]};
 const withCheck=(id,check)=>({task:{id,title:id,dependsOn:[],writeScopes:[`${id.toLowerCase()}.txt`],capabilities:[],acceptance:["ok"]},execution:{instructions:`implement ${id}`,roleId:"dev",modelId:"test",checkIds:[check]}});
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("conflicting acceptance",base,[withCheck("A","verify"),withCheck("B","strict")]);
 const integration=await workspace.create("integration",1,base);
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[pass(),strict],workers:[worker(),{...worker(),identity:{...worker().identity,id:"w1"}}],idlePollMs:100});
 const settled=runner.start();
 await waitFor(async()=>(await coordinator.openIntegrationFailures()).length>0);
 const state=await coordinator.state();
 const entry=state.integrationFailures[0];
 assert.equal(entry.taskId,"B");assert.equal(entry.status,"open");assert.ok(/^[a-f0-9]{40,64}$/.test(entry.commit));assert.equal(entry.workspacePath,integration.path);
 assert.equal(state.board.tasks.find(task=>task.id==="B").status,"blocked");
 await coordinator.resolveIntegrationFailure(entry.id);
 assert.equal((await coordinator.openIntegrationFailures()).length,0);
 await coordinator.unblock("B");
 await waitFor(async()=>{const s=await coordinator.state();return s.board.tasks.find(task=>task.id==="B").attempts>=2;}); // wakeup re-dispatched the repair
 await runner.pause();await settled;
 assert.equal((await coordinator.state()).board.tasks.find(task=>task.id==="B").attempts,2);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("pause interrupts, unblock+resume re-dispatches, cancel settles the runner",{timeout:40000},async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("pause goal",base,[spec("A"),spec("B")]);
 const integration=await workspace.create("integration",1,base);
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[pass()],workers:[worker(),{...worker(),identity:{...worker().identity,id:"w1"}}],idlePollMs:100});
 const settled=runner.start();
 await waitFor(async()=>{const s=await coordinator.state();return s.board.tasks.some(task=>task.id==="B"&&task.status==="running");});
 await runner.pause();
 assert.equal((await coordinator.state()).status,"paused");
 await settled;
 const paused=await coordinator.state();
 assert.equal(paused.board.tasks.find(task=>task.id==="B").status,"blocked","in-flight work is never silently replayed");
 for(const task of paused.board.tasks) if(task.status==="blocked") await coordinator.unblock(task.id);
 await runner.resume();
 await waitFor(async()=>(await coordinator.state()).status==="review");
 await coordinator.control("accept");
 await coordinator.create("second goal",base,[spec("B")]); // reuses the slow taskId under a new goal identity
 const cancelRunner=new ProjectRunner({coordinator,workspaces:workspace,integration:await workspace.create("integration-2",1,base),checks:[pass()],workers:[worker()],idlePollMs:100});
 const cancelled=cancelRunner.start();
 await waitFor(async()=>{const s=await coordinator.state();return s.board.tasks.some(task=>task.status==="running");});
 await coordinator.control("cancel");
 await cancelled;
 assert.equal((await coordinator.state()).status,"cancelled");
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("goal identity separates workspaces when a later goal reuses taskIds",{timeout:30000},async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:1,maxAttempts:2});
 await coordinator.create("first goal",base,[spec("A")]);
 const first=await workspace.create("integration-1",1,base);
 await new ProjectRunner({coordinator,workspaces:workspace,integration:first,checks:[pass()],workers:[worker()]}).start();
 await coordinator.control("accept");
 await coordinator.create("second goal",base,[spec("A")]); // same taskId, new goal
 const second=await workspace.create("integration-2",1,base);
 await new ProjectRunner({coordinator,workspaces:workspace,integration:second,checks:[pass()],workers:[worker()]}).start();
 assert.equal((await coordinator.state()).status,"review");
 assert.equal(await readFile(join(second.path,"a.txt"),"utf8"),"A");
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("rolling planner refills below the watermark, retries conflicts and seals",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-rolling-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("p")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("rolling","a".repeat(40),[spec("A")],{planOpen:true});
 const calls=[];
 const planner=new RollingPlanner(coordinator,{lowWatermark:3,signal:new AbortController().signal,plan:async(state)=>{
  calls.push(state.board.version);
  if(calls.length===1){await coordinator.append([spec("X")],state.board.version);return {tasks:[spec("C")]};} // concurrent append: the tick's own append must conflict and retry
  return {tasks:[spec("D")]};
 }});
 assert.equal(await planner.tick(),1);
 assert.deepEqual((await coordinator.state()).board.tasks.map(task=>task.id).sort(),["A","D","X"]);
 assert.equal((await coordinator.state()).planOpen,true);
 const sealer=new RollingPlanner(coordinator,{lowWatermark:10,signal:new AbortController().signal,plan:async()=>({tasks:[],seal:true})});
 assert.equal(await sealer.tick(),0);
 assert.equal((await coordinator.state()).planOpen,false);
 await coordinator.withdraw(["A"],(await coordinator.state()).board.version);
 assert.deepEqual((await coordinator.state()).board.tasks.map(task=>task.id).sort(),["D","X"]);
 await assert.rejects(coordinator.append([
  {task:{id:"P",title:"P",dependsOn:["Q"],writeScopes:["p.txt"],capabilities:[],acceptance:["ok"]},execution:{instructions:"p",roleId:"dev",modelId:"test",checkIds:["verify"]}},
  {task:{id:"Q",title:"Q",dependsOn:["P"],writeScopes:["q.txt"],capabilities:[],acceptance:["ok"]},execution:{instructions:"q",roleId:"dev",modelId:"test",checkIds:["verify"]}}],
  (await coordinator.state()).board.version),/cycle/); // incremental cycle check
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("an integration failure is contained: later tasks integrate and a repaired task reintegrates",{timeout:30000},async()=>{ // m4rev-F001
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:1,maxAttempts:2});
 const integration=await workspace.create("integration",1,base);
 // Fails only for merged a.txt checked in the integration workspace while the repair marker is absent.
 const strict={id:"strict",command:process.execPath,args:["-e",`if(require('fs').existsSync('a.txt')&&!require('fs').existsSync('fixed')&&process.env.PI861_WORKSPACE===${JSON.stringify(integration.path)})process.exit(1)`]};
 const withCheck=(id,checkIds)=>({task:{id,title:id,dependsOn:[],writeScopes:[`${id.toLowerCase()}.txt`],capabilities:[],acceptance:["ok"]},execution:{instructions:`implement ${id}`,roleId:"dev",modelId:"test",checkIds}});
 await coordinator.create("contained failure",base,[withCheck("A",["verify","strict"]),withCheck("B",["verify"])]);
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[pass(),strict],workers:[worker()],idlePollMs:100});
 const settled=runner.start();
 await waitFor(async()=>{const s=await coordinator.state();return s.board.tasks.find(t=>t.id==="A").status==="blocked"&&s.board.tasks.find(t=>t.id==="B").status==="done";});
 const entry=(await coordinator.openIntegrationFailures())[0];
 assert.equal(entry.taskId,"A"); // B must still integrate after A's failed merge
 await writeFile(join(integration.path,"fixed"),"operator repair\n"); // reconcile the merge scene
 await coordinator.resolveIntegrationFailure(entry.id);
 await coordinator.unblock("A"); // attempt budget (1 of 2) permits exactly one redispatch
 await waitFor(async()=>(await coordinator.state()).board.tasks.find(t=>t.id==="A").status==="done");
 await waitFor(async()=>(await coordinator.state()).status==="review");
 await settled;
 assert.equal(await readFile(join(integration.path,"a.txt"),"utf8"),"A");
 assert.equal(await readFile(join(integration.path,"b.txt"),"utf8"),"B");
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("rolling planner withdraws and appends within one tick",async()=>{ // m4rev-F002
 const root=await mkdtemp(join(tmpdir(),"pi861-rolling-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("p")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("rolling","a".repeat(40),[spec("A"),spec("B")],{planOpen:true});
 const planner=new RollingPlanner(coordinator,{lowWatermark:3,signal:new AbortController().signal,plan:async()=>({tasks:[spec("C")],withdraw:["B"]})});
 assert.equal(await planner.tick(),1);
 const state=await coordinator.state();
 assert.deepEqual(state.board.tasks.map(task=>task.id).sort(),["A","C"]);
 assert.ok(state.execution["C"]);assert.equal(state.execution["B"],undefined); // withdrawn execution contracts go too
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("idle polls claim nothing and journal no receipts",async()=>{ // m4rev-F003
 const root=await mkdtemp(join(tmpdir(),"pi861-idle-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("p")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("goal","a".repeat(40),[spec("A"),spec("C")]); // queued work exists, none claimable below
 const before=Object.keys((await coordinator.state()).receipts).length;
 const bystander={id:"w",capabilities:[],roleIds:["unrelated"],modelIds:["test"]};
 for(let i=0;i<5;i++)assert.equal(await coordinator.claim(bystander,`idle-${i}`),null);
 assert.equal(Object.keys((await coordinator.state()).receipts).length,before);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("resume during a pause drain restarts the dispatch loop",{timeout:40000},async()=>{ // m4rev-F004
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("pause drain goal",base,[spec("A"),spec("B")]);
 const integration=await workspace.create("integration",1,base);
 const events=[];
 const slow=ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker-slow-exit.mjs",import.meta.url))],cwd:ws.path});
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[pass()],
  workers:[0,1].map(id=>({identity:{id:`w${id}`,capabilities:[],roleIds:["dev"],modelIds:["test"]},process:slow})),
  idlePollMs:100,onProgress:e=>events.push(`${e.taskId}:${e.state}`)});
 const settled=runner.start();
 await waitFor(async()=>{const s=await coordinator.state();return s.board.tasks.some(task=>task.id==="B"&&task.status==="running");});
 const pausing=runner.pause();
 await waitFor(()=>events.some(entry=>entry.endsWith(":blocked"))); // draining: abort delivered, session close still pending
 await runner.resume(); // must wait out the drain, then restart dispatch itself
 await pausing;
 for(const task of (await coordinator.state()).board.tasks) if(task.status==="blocked") await coordinator.unblock(task.id);
 await waitFor(async()=>(await coordinator.state()).status==="review");
 await settled;
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("team persists across goals and accounting covers the whole task tree",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-team-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("p")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.joinTeam({id:"local-0",capabilities:[],roleIds:["dev"],modelIds:["test"],capacity:2});
 await coordinator.joinTeam({id:"node-1",capabilities:[],roleIds:["dev"],modelIds:["test"],capacity:1,remote:true});
 await coordinator.create("goal","a".repeat(40),[spec("A"),spec("B")]);
 const local={id:"local-0",capabilities:[],roleIds:["dev"],modelIds:["test"]},remote={id:"node-1",capabilities:[],roleIds:["dev"],modelIds:["test"]};
 const c1=await coordinator.claim(local,"r1"),c2=await coordinator.claim(remote,"r2");
 assert.ok(c1.goalId,"claims carry the goal identity");
 let accounting=await coordinator.accounting();
 assert.equal(accounting.executing,1);assert.equal(accounting.remote,1);assert.equal(accounting.reviewing,0);assert.equal(accounting.waiting,0);
 await coordinator.submit("local-0",c1.task.lease,["x"],"s1");
 accounting=await coordinator.accounting();
 assert.equal(accounting.reviewing,1);
 await coordinator.acquireIntegration("i:1","/tmp/ws",{ttlMs:60_000});
 assert.equal((await coordinator.accounting()).integration,1);
 await coordinator.control("cancel");
 await coordinator.create("next goal","a".repeat(40),[spec("A")]);
 assert.equal((await coordinator.state()).team.members.length,2,"team survives goal rotation");
 assert.ok((await coordinator.explain()).reasons.some(reason=>reason.kind==="no-work"));
 const capped=new ProjectCoordinator(new FileStateStore(join(root,"capped.json"),emptyProject("p")),{maxConcurrent:1,maxAttempts:1},1);
 await capped.create("capped","a".repeat(40),[spec("A")]);
 assert.ok((await capped.explain()).reasons.some(reason=>reason.kind==="plan-budget"));
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("project goal verbs cover edit, budget, explain and status",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-verbs-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("p")),{maxConcurrent:1,maxAttempts:2});
 await coordinator.create("goal","a".repeat(40),[spec("A")]);
 await assert.rejects(projectGoalCommand(coordinator,undefined,[],"edit new objective"),/Pause/);
 await coordinator.control("pause");
 assert.match(await projectGoalCommand(coordinator,undefined,[],"edit revised objective"),/revised/);
 assert.equal((await coordinator.state()).objective,"revised objective");
 await projectGoalCommand(coordinator,undefined,[],"budget 5");
 await assert.rejects(projectGoalCommand(coordinator,undefined,[],"budget 0"),/Invalid/);
 const explained=JSON.parse(await projectGoalCommand(coordinator,undefined,[],"explain"));
 assert.ok(explained.reasons.some(reason=>reason.kind==="paused"));
 assert.match(await projectGoalCommand(coordinator,undefined,[],"status"),/revised objective/);
 await assert.rejects(projectGoalCommand(coordinator,undefined,[],"bogus"),/Unknown \/goal verb/);
 await projectGoalCommand(coordinator,undefined,[],"resume");
 assert.equal((await coordinator.state()).status,"active");
 }finally{await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
