import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStateStore } from "../src/live/store.ts";
import { RemoteWorkerServer,RemoteWorkerClient } from "../src/live/remote-worker.ts";
import { ProjectCoordinator,emptyProject } from "../src/live/coordinator.ts";
import { Workspaces } from "../src/live/workspace.ts";
import { ProjectRunner } from "../src/live/project-runner.ts";
const exec=promisify(execFile);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(predicate,timeout=15000,interval=25){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(interval);}throw new Error("condition not reached in time");}
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
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
test("remote client refuses plaintext non-loopback and embedded URL secrets",()=>{
 assert.throws(()=>new RemoteWorkerClient({url:"http://example.test",token:"a".repeat(32)}));
 assert.throws(()=>new RemoteWorkerClient({url:"https://name:secret@example.test",token:"a".repeat(32)}));
});
test("worker service: executable entry, status announcements and convergent shutdown",{timeout:60000},async()=>{
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
 }finally{child?.kill("SIGKILL");await rm(root,{recursive:true,force:true});}
});
