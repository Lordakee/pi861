import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStateStore } from "../src/live/store.ts";
import { digest } from "../src/memory.ts";
import { RemoteWorkerServer,RemoteWorkerClient } from "../src/live/remote-worker.ts";
import { ProjectCoordinator,emptyProject } from "../src/live/coordinator.ts";
import { Workspaces } from "../src/live/workspace.ts";
import { ProjectRunner } from "../src/live/project-runner.ts";
const exec=promisify(execFile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(predicate,timeout=15000,interval=25){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(interval);}throw new Error("condition not reached in time");}
// Bounds awaits that have no internal deadline (runner settlement, child exit) so a stalled goal fails loudly instead of hanging.
function within(promise,ms,note){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`timeout: ${note}`)),ms);}),]).finally(()=>clearTimeout(timer));}
test("HTTP worker: distinct repository, commit bundle transfer, local revalidation and integration",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-remote-"));let server;
 try{
 const source=join(root,"source"),remote=join(root,"node");await mkdir(source);await exec("git",["init",source]);await writeFile(join(source,"README"),"fixture");await exec("git",["add","README"],{cwd:source});await exec("git",["-c","user.name=Test","-c","user.email=test@localhost","commit","-m","base"],{cwd:source});await exec("git",["clone",source,remote]);
 const ws=new Workspaces(source,join(root,"controller-trees"));const remoteWs=new Workspaces(remote,join(root,"remote-trees"));const base=await ws.head();
 const check={id:"verify",command:process.execPath,args:["-e","if(!require('fs').existsSync('a.txt'))process.exit(1)"]};
 const identity={id:"node-1",capabilities:[],roleIds:["dev"],modelIds:["fixture"]};const token="local-test-only-"+"x".repeat(32);
 server=new RemoteWorkerServer(new FileStateStore(join(root,"remote-state.json"),{jobs:[]}),{identity,token,workspaces:remoteWs,maxConcurrent:1,checks:[check],
 process:workspace=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:workspace.path})});
 const url=await server.listen();assert.equal((await fetch(url+"/jobs/unknown")).status,401);
 const coord=new ProjectCoordinator(new FileStateStore(join(root,"project.json"),emptyProject("p")),{maxConcurrent:1,maxAttempts:2});
 await coord.create("test remote transfer",base,[{task:{id:"A",title:"A",dependsOn:[],writeScopes:["a.txt"],capabilities:[],acceptance:["a.txt exists"]},execution:{instructions:"create fixture A",modelId:"fixture",roleId:"dev",checkIds:["verify"]}}]);
 const integration=await ws.create("integrate",1,base);
 const client=new RemoteWorkerClient({url,token,allowLoopbackHttp:true,pollMs:10});
 await new ProjectRunner({coordinator:coord,workspaces:ws,checks:[check],integration,workers:[{identity,remote:client}]}).start();
 assert.equal((await coord.state()).status,"review");assert.equal(await readFile(join(integration.path,"a.txt"),"utf8"),"A");assert.equal(await ws.head(),base);
 // A second goal reusing taskId A must get a distinct remote job identity (goal/run scoping).
 await coord.control("accept");
 const merged=(await exec("git",["rev-parse","HEAD"],{cwd:integration.path})).stdout.trim();
 await coord.create("goal two reuses taskId",merged,[{task:{id:"A",title:"A",dependsOn:[],writeScopes:["a.txt"],capabilities:[],acceptance:["a.txt exists"]},execution:{instructions:"create fixture A",modelId:"fixture",roleId:"dev",checkIds:["verify"]}}]);
 await new ProjectRunner({coordinator:coord,workspaces:ws,checks:[check],integration,workers:[{identity,remote:client}]}).start();
 assert.equal((await coord.state()).status,"review");
 const jobs=JSON.parse(await readFile(join(root,"remote-state.json"),"utf8"));assert.equal(jobs.jobs.length,2);assert.equal(jobs.jobs[0].state,"done");assert.equal(jobs.jobs[1].state,"done");
 assert.notEqual(jobs.jobs[0].id,jobs.jobs[1].id,"goal identity separates remote requests");
 }finally{await server?.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("dual worker services: parallel isolated checkouts, node-loss takeover and no double dispatch",{timeout:60000,skip:process.platform==="win32"&&"POSIX process-group takeover semantics; Windows validated at the line-process layer, service deploy validated on Linux CI"},async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-dual-"));const children=[];
 const stateFile=async index=>JSON.parse(await readFile(join(root,`state-${index}.json`),"utf8"));
 try{
 // Two fully independent checkouts of the same source repository, one service process each.
 const source=join(root,"source");await mkdir(source);await exec("git",["init",source]);await writeFile(join(source,"README"),"fixture");await exec("git",["add","README"],{cwd:source});await exec("git",["-c","user.name=T","-c","user.email=t@l","commit","-m","base"],{cwd:source});
 await exec("git",["clone",source,join(root,"node-1")]);await exec("git",["clone",source,join(root,"node-2")]);
 const token="dual-test-"+"z".repeat(32);
 const trace=join(root,"trace");
 const checks=["A","B","K","D"].map(id=>({id:`verify${id}`,command:process.execPath,args:["-e",`if(!require('fs').existsSync('${id.toLowerCase()}.txt'))process.exit(1)`]}));
 const launch=async(index,kDelayMs)=>{
  await writeFile(join(root,`service-${index}.json`),JSON.stringify({
   repository:join(root,`node-${index}`),worktreeRoot:join(root,`trees-${index}`),statePath:join(root,`state-${index}.json`),tokenEnv:"PI861_SERVICE_TOKEN",
   heartbeatMs:1000,port:0,
   identity:{id:`svc-${index}`,capabilities:[],roleIds:["dev"],modelIds:["fixture"]},maxConcurrent:1,checks,
   worker:{command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker-late.mjs",import.meta.url))],env:{TRACE:trace,PI861_FIXTURE_K_DELAY_MS:String(kDelayMs)}},
  }));
  const announcements=[];let stderr="";
  const child=spawn(process.execPath,["--experimental-strip-types",fileURLToPath(new URL("../src/live/worker-service.ts",import.meta.url)),"--config",join(root,`service-${index}.json`)],{env:{...process.env,PI861_SERVICE_TOKEN:token},stdio:["ignore","pipe","pipe"]});
  children.push(child);
  child.stdout.on("data",chunk=>{for(const line of `${chunk}`.split("\n"))if(line.trim())announcements.push(JSON.parse(line));});
  child.stderr.on("data",chunk=>{stderr+=chunk;});
  await waitFor(()=>announcements.some(item=>item.event==="listening"));
  return {child,announcements,url:announcements.find(item=>item.event==="listening").url,stderr:()=>stderr};
 };
 const starts=async name=>{try{return (await readFile(trace,"utf8")).split("\n").filter(line=>line===`${name}:start`).length}catch{return 0}};
 const first=await launch(1,8000),second=await launch(2,5);
 assert.notEqual(first.url,second.url,"independent service ports");
 await waitFor(()=>first.announcements.some(item=>item.event==="heartbeat")&&second.announcements.some(item=>item.event==="heartbeat"));
 assert.equal(first.announcements[0].identity.id,"svc-1");assert.equal(second.announcements[0].identity.id,"svc-2"); // both listening and announcing

 const ws=new Workspaces(source,join(root,"controller-trees"));const base=await ws.head();
 const coord=new ProjectCoordinator(new FileStateStore(join(root,"project.json"),emptyProject("p")),{maxConcurrent:2,maxAttempts:2});
 const client=index=>new RemoteWorkerClient({url:index===1?first.url:second.url,token,allowLoopbackHttp:true,pollMs:25});
 const member=index=>({identity:{id:`svc-${index}`,capabilities:[],roleIds:["dev"],modelIds:["fixture"]},remote:client(index)});
 const integration=await ws.create("integration",1,base);
 const spec=(id,checkIds)=>({task:{id,title:id,dependsOn:[],writeScopes:[`${id.toLowerCase()}.txt`],capabilities:[],acceptance:[`${id.toLowerCase()}.txt exists`]},execution:{instructions:`implement ${id}`,modelId:"fixture",roleId:"dev",checkIds}});

 // Phase 1: two parallelizable tasks, disjoint write scopes -> one claim per node, both isolated workspaces verified.
 await coord.create("dual parallel goal",base,[spec("A",["verifyA"]),spec("B",["verifyB"])]);
 await within(new ProjectRunner({coordinator:coord,workspaces:ws,checks,integration,idlePollMs:100,workers:[member(1),member(2)]}).start(),30000,"parallel goal did not settle");
 assert.equal((await coord.state()).status,"review");
 assert.equal(await readFile(join(integration.path,"a.txt"),"utf8"),"A");assert.equal(await readFile(join(integration.path,"b.txt"),"utf8"),"B");
 assert.equal(await ws.head(),base,"controller main must remain unchanged");
 const split1=await stateFile(1),split2=await stateFile(2);
 assert.deepEqual([split1.jobs[0].result.text,split2.jobs[0].result.text].sort(),["Implemented fixture A","Implemented fixture B"],"each node claimed exactly one task");
 assert.equal(split1.jobs.length,1);assert.equal(split2.jobs.length,1);assert.notEqual(split1.jobs[0].id,split2.jobs[0].id);
 for(const job of [split1.jobs[0],split2.jobs[0]])assert.ok(job.result.evidence.some(item=>/^check:verify[AB]:passed/.test(item)),"isolated workspace passed its own checks");
 assert.equal(await starts("A"),1);assert.equal(await starts("B"),1);

 // Phase 2: hold one job in flight on svc-1, SIGTERM it, and reconcile through the surviving node.
 await coord.control("accept");
 const merged=(await exec("git",["rev-parse","HEAD"],{cwd:integration.path})).stdout.trim();
 await coord.create("takeover goal",merged,[spec("K",["verifyK"])]);
 const takeover=new ProjectRunner({coordinator:coord,workspaces:ws,checks,integration,idlePollMs:100,workers:[member(1),member(2)]});
 takeover.start().catch(()=>{}); // drained and bounded through takeover.pause() below
 await waitFor(async()=>(await stateFile(1)).jobs.some(job=>job.state==="running")&&await starts("K")>=1);
 assert.equal((await coord.state()).board.tasks.find(task=>task.id==="K").lease.workerId,"svc-1","first node holds the in-flight task");
 first.child.kill("SIGTERM");
 assert.equal(await within(new Promise(resolve=>first.child.once("exit",resolve)),15000,"killed service did not exit"),0,`killed service must exit cleanly: ${first.stderr()}`);
 assert.ok(first.announcements.some(item=>item.event==="stopping"));
 const killed=(await stateFile(1)).jobs.find(job=>job.state==="unknown");
 assert.ok(killed,"aborted in-flight job lands in unknown, never blindly replayed");
 assert.equal((await stateFile(1)).jobs.filter(job=>job.state==="done").length,1,"completed receipts survive the crash");
 await waitFor(async()=>(await coord.state()).board.tasks.find(task=>task.id==="K")?.status==="blocked");
 assert.match((await coord.state()).board.tasks.find(task=>task.id==="K").reason,/inspect preserved workspace/); // controller demands reconciliation
 await within(takeover.pause(),15000,"takeover runner did not pause");

 // Duplicate commands must be guarded, never applied twice: no double dispatch.
 const failover=new ProjectRunner({coordinator:coord,workspaces:ws,checks,integration,idlePollMs:100,workers:[member(2)]});
 await failover.resume(); // surviving node keeps serving the reconciled goal
 await failover.resume(); // wire-rev-F003: duplicate resume on an active goal is an idempotent no-op, never a second dispatch loop
 await coord.unblock("K");
 await assert.rejects(coord.unblock("K"),/Only a blocked task can be requeued/);
 await within(failover.start(),30000,"reconciled goal did not settle");
 assert.equal((await coord.state()).status,"review");
 const settled2=(await coord.state()).board.tasks.find(task=>task.id==="K");
 assert.equal(settled2.attempts,2,"exactly one reconciliation redispatch");
 assert.equal(await readFile(join(integration.path,"k.txt"),"utf8"),"K");
 assert.equal(await starts("K"),2,"one killed attempt plus exactly one redispatched execution");
 const recovered=(await stateFile(2)).jobs.filter(job=>job.result?.text==="Implemented fixture K");
 assert.equal(recovered.length,1);assert.equal(recovered[0].state,"done");
 assert.notEqual(recovered[0].id,killed.id,"new lease identity, never a replay of the killed job");

 // Phase 3: duplicated dispatch of one request (lost-ack replay) executes the work exactly once.
 await coord.control("accept");
 const dup={task:{id:"D",title:"D",dependsOn:[],writeScopes:["d.txt"],capabilities:[],acceptance:["d.txt exists"],status:"queued",attempts:1,artifacts:[],lease:{taskId:"D",workerId:"svc-2",token:"dual-dispatch-probe",attempt:1}},
  execution:{instructions:"implement D",roleId:"dev",modelId:"fixture",checkIds:["verifyD"]},baseCommit:base,
  baseBundle:{data:"",sha256:createHash("sha256").update("").digest("hex")}};
 const dupId=digest({identity:null,lease:dup.task.lease,execution:dup.execution,baseCommit:dup.baseCommit});
 const dispatch=()=>client(2).run(structuredClone(dup),new AbortController().signal);
 const [one,two]=await within(Promise.all([dispatch(),dispatch()]),30000,"duplicated dispatch did not settle");
 assert.equal(one.commit,two.commit,"receipt replay returns the same candidate");
 assert.equal((await stateFile(2)).jobs.filter(job=>job.id===dupId).length,1,"requestId idempotency: one job per duplicated request");
 assert.equal(await starts("D"),1,"duplicate dispatch executes exactly once");

 second.child.kill("SIGTERM");
 assert.equal(await within(new Promise(resolve=>second.child.once("exit",resolve)),15000,"surviving service did not exit"),0,`surviving service must exit cleanly: ${second.stderr()}`);
 assert.ok(second.announcements.some(item=>item.event==="stopping"));
 }finally{for(const child of children)child.kill("SIGKILL");await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
test("remote client refuses plaintext non-loopback and embedded URL secrets",()=>{
 assert.throws(()=>new RemoteWorkerClient({url:"http://example.test",token:"a".repeat(32)}));
 assert.throws(()=>new RemoteWorkerClient({url:"https://name:secret@example.test",token:"a".repeat(32)}));
});
test("worker service: executable entry, status announcements and convergent shutdown",{timeout:60000,skip:process.platform==="win32"&&"POSIX signal shutdown contract; core service logic covered cross-platform by coordinator/scheduler tests"},async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-service-"));let child;
 try{
 const source=join(root,"repo");await mkdir(source);await exec("git",["init",source]);await writeFile(join(source,"README"),"fixture");await exec("git",["add","README"],{cwd:source});await exec("git",["-c","user.name=T","-c","user.email=t@l","commit","-m","base"],{cwd:source});
 const token="service-test-"+"y".repeat(32);
 const check={id:"verify",command:process.execPath,args:["-e","if(!require('fs').existsSync('a.txt'))process.exit(1)"]};
 await writeFile(join(root,"service.json"),JSON.stringify({
  repository:source,worktreeRoot:join(root,"trees"),statePath:join(root,"state.json"),tokenEnv:"PI861_SERVICE_TOKEN",
  heartbeatMs:1000,port:0,
  identity:{id:"svc-1",capabilities:[],roleIds:["dev"],modelIds:["fixture"]},maxConcurrent:1,checks:[check],
  worker:{command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))]},
 }));
 const announcements=[];let stderr="";
 child=spawn(process.execPath,["--experimental-strip-types",fileURLToPath(new URL("../src/live/worker-service.ts",import.meta.url)),"--config",join(root,"service.json")],{env:{...process.env,PI861_SERVICE_TOKEN:token},stdio:["ignore","pipe","pipe"]});
 child.stdout.on("data",chunk=>{for(const line of `${chunk}`.split("\n")){if(line.trim())announcements.push(JSON.parse(line));}});
 child.stderr.on("data",chunk=>{stderr+=chunk;});
 await waitFor(()=>announcements.some(item=>item.event==="listening"));
 const url=announcements.find(item=>item.event==="listening").url;
 assert.equal(announcements[0].identity.id,"svc-1");assert.equal(announcements[0].capacity.maxConcurrent,1); // announced capacity
 const status=await (await fetch(`${url}/status`,{headers:{Authorization:`Bearer ${token}`}})).json();
 assert.equal(status.identity.id,"svc-1");assert.equal(status.capacity.maxConcurrent,1);assert.equal(status.jobs.done ?? 0,0);assert.ok(typeof status.uptimeMs==="number");
 const ws=new Workspaces(source,join(root,"controller-trees"));const base=await ws.head();
 const coord=new ProjectCoordinator(new FileStateStore(join(root,"project.json"),emptyProject("p")),{maxConcurrent:1,maxAttempts:2});
 await coord.create("through service",base,[{task:{id:"A",title:"A",dependsOn:[],writeScopes:["a.txt"],capabilities:[],acceptance:["a.txt exists"]},execution:{instructions:"a",modelId:"fixture",roleId:"dev",checkIds:["verify"]}}]);
 const integration=await ws.create("integrate",1,base);
 await new ProjectRunner({coordinator:coord,workspaces:ws,checks:[check],integration,idlePollMs:100,workers:[{identity:{id:"svc-1",capabilities:[],roleIds:["dev"],modelIds:["fixture"]},remote:new RemoteWorkerClient({url,token,allowLoopbackHttp:true,pollMs:25})}]}).start();
 assert.equal(await readFile(join(integration.path,"a.txt"),"utf8"),"A");
 await waitFor(()=>announcements.some(item=>item.event==="heartbeat")); // heartbeat/lease announcements are visible
 child.kill("SIGTERM");
 const code=await new Promise(resolve=>child.once("exit",resolve));
 assert.equal(code,0,`service must exit cleanly: ${stderr}`);
 assert.ok(announcements.some(item=>item.event==="stopping"));
 }finally{child?.kill("SIGKILL");await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
