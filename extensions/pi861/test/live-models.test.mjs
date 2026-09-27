import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AuxiliaryModelService, ModelRuntime, RequestBudget, resolveModelPolicy, UsageLedger } from "../src/live/model-runtime.ts";
import { routeClassifier } from "../src/live/compilers.ts";
import { HealthService, ModelFailure } from "../src/routing.ts";
const targets = [
 {id:"cheap",revision:"1",provider:"test",model:"cheap",quality:1,costRank:1,contextWindow:10000,capabilities:["tools"],enabled:true,account:"acct-a",endpoint:"edge-1",billing:{inputPerMillionTokens:1,outputPerMillionTokens:2},dataEgress:"open"},
 {id:"strong",revision:"1",provider:"test",model:"strong",quality:3,costRank:3,contextWindow:10000,capabilities:["tools"],enabled:true,account:"acct-b",endpoint:"edge-2",billing:{inputPerMillionTokens:3,outputPerMillionTokens:6},dataEgress:"open"},
];
function policy(patch={}) {return {targets,preferred:"cheap",requirements:{minQuality:1,contextTokens:100,capabilities:["tools"],allowedIds:["cheap","strong"]},recovery:{failoverEnabled:true,failbackEnabled:true,probeIntervalMs:20,maxProbeIntervalMs:100,requiredProbeSuccesses:2},maxAttempts:3,requestTimeoutMs:500,maxRequests:20,maxProbeRequests:5,...patch};}
const signal=()=>new AbortController().signal;
function memstore(initial){const state=structuredClone(initial);let tail=Promise.resolve();return {state,store:{read:async()=>structuredClone(state),update(fn){const result=tail.then(()=>fn(state));tail=result.catch(()=>{});return result;}}};}
const usage=(input,output,cacheRead=0)=>({inputTokens:input,outputTokens:output,cacheReadTokens:cacheRead,cacheWriteTokens:0,cost:null});

test("fixed route classifies once then escalates on a concrete gap",async()=>{
 let classifications=0; const seen=[];
 const runtime=new ModelRuntime(policy(),async m=>{seen.push(m.id);return m.id;},async()=>true,{classify:async()=>{classifications++;return {mode:"fixed",targetId:"cheap",minQuality:1,reason:"stable"};}});
 try {runtime.setTask("stable task");await runtime.call({},signal());await runtime.call({},signal());assert.equal(classifications,1);
 runtime.report("capability_gap",{reason:"needs vision"});await runtime.call({},signal());assert.deepEqual(seen,["cheap","cheap","strong"]);assert.equal(runtime.state.preferred,"strong");}
 finally{runtime.close();}
});
test("failover holds the original goal and auto failback waits for next inference",async()=>{
 let broken=true; const seen=[];
 const runtime=new ModelRuntime(policy(),async m=>{seen.push(m.id);if(m.id==="cheap"&&broken)throw new ModelFailure("transient");return m.id;},async()=>true);
 try {assert.equal(await runtime.call({},signal()),"strong");assert.equal(runtime.state.preferred,"cheap");broken=false;
 await runtime.checkRecovery(Date.now()+500);await runtime.checkRecovery(Date.now()+1000);assert.equal(runtime.state.active,"strong");
 assert.equal(await runtime.call({},signal()),"cheap");assert.deepEqual(seen,["cheap","strong","cheap"]);}
 finally{runtime.close();}
});
test("disabled failover never calls backup",async()=>{
 const p=policy();p.recovery.failoverEnabled=false;let calls=0;
 const runtime=new ModelRuntime(p,async()=>{calls++;throw new ModelFailure("transient");},async()=>true);
 try{await assert.rejects(runtime.call({},signal()));assert.equal(calls,1);}finally{runtime.close();}
});
test("disabled failback issues no probes",async()=>{
 const p=policy();p.recovery.failbackEnabled=false;let probes=0;
 const runtime=new ModelRuntime(p,async m=>{if(m.id==="cheap")throw new ModelFailure("transient");return m.id;},async()=>{probes++;return true;});
 try{await runtime.call({},signal());await runtime.checkRecovery(Date.now()+1000);await sleep(25);assert.equal(probes,0);}finally{runtime.close();}
});
test("cancellation never starts backup",async()=>{
 const p=policy({requestTimeoutMs:30});const ac=new AbortController();let calls=0;
 const runtime=new ModelRuntime(p,async()=>{calls++;await sleep(100);return "late";},async()=>new Promise(()=>{}));
 const running=runtime.call({},ac.signal);setTimeout(()=>ac.abort(),5);
 try{await assert.rejects(running);assert.equal(calls,1);}finally{runtime.close();}
});
test("global request allowance is atomic and idempotent",async()=>{
 const state={limit:2,used:0,intents:{}};let tail=Promise.resolve();
 const store={read:async()=>structuredClone(state),update(fn){const result=tail.then(()=>fn(state));tail=result.catch(()=>{});return result;}};
 const a=new RequestBudget(store),b=new RequestBudget(store);
 await Promise.all([a.reserve("same"),b.reserve("same")]);assert.equal(state.used,1);await a.reserve("second");await assert.rejects(b.reserve("third"));assert.equal(state.used,2);
});
test("backup state and request accounting survive a runtime replacement",async()=>{
 const p=policy();p.recovery.failbackEnabled=false;
 const first=new ModelRuntime(p,async m=>{if(m.id==="cheap")throw new ModelFailure("transient");return m.id;},async()=>true);
 first.setTask("persistent task");await first.call({},signal());const checkpoint=first.checkpoint;first.close();
 const second=new ModelRuntime(p,async m=>m.id,async()=>true);
 try{second.restore(checkpoint);second.setTask("persistent task");assert.equal(second.state.active,"strong");assert.equal(second.state.requests,2);assert.equal(await second.call({},signal()),"strong");assert.equal(second.state.requests,3);}finally{second.close();}
});
test("route reports carry reason and evidence into later classifications and checkpoints",async()=>{
 const seen=[];const decisions=[()=>({mode:"dynamic",targetId:"cheap",minQuality:1,reason:"routing"}),()=>({mode:"fixed",targetId:"cheap",minQuality:1,reason:"restored"})];
 let calls=0;
 const make=()=>new ModelRuntime(policy(),async m=>m.id,async()=>true,{classify:async(_task,_candidates,_signal,evidence)=>{calls++;seen.push(structuredClone(evidence??[]));return decisions[Math.min(calls-1,decisions.length-1)]();}});
 const runtime=make();
 try{
  runtime.setTask("task text");await runtime.call({},signal());
  assert.deepEqual(seen[0],[]);
  runtime.report("scope_changed",{reason:"goal grew a reporting step",phase:"gather"});
  await runtime.call({},signal());
  assert.equal(seen[1].at(-1).reason,"goal grew a reporting step");
  assert.equal(seen[1].at(-1).signal,"scope_changed");
  assert.equal(seen[1].at(-1).phase,"gather");
  const checkpoint=runtime.checkpoint;runtime.close();
  const restored=make();
  try{restored.restore(checkpoint);restored.setTask("task text");
   restored.report("scope_changed",{reason:"after restore"});
   await restored.call({},signal());
   assert.equal(seen.at(-1).length,2);
   assert.equal(seen.at(-1).at(-1).reason,"after restore");
  }finally{restored.close();}
 }finally{runtime.close();}
});
test("repeated no-progress evidence escalates",async()=>{
 const seen=[];
 const runtime=new ModelRuntime(policy(),async m=>{seen.push(m.id);return m.id;},async()=>true);
 try{runtime.setTask("stuck task");await runtime.call({},signal());
 runtime.report("no_progress",{reason:"same output twice"});await runtime.call({},signal());
 assert.equal(runtime.state.preferred,"cheap");
 runtime.report("no_progress",{reason:"still identical"});await runtime.call({},signal());
 assert.deepEqual(seen,["cheap","cheap","strong"]);}finally{runtime.close();}
});
test("downgrade requires a completed phase with verified quality",async()=>{
 const decisions=[{mode:"fixed",targetId:"cheap",minQuality:1,reason:"start"},{mode:"fixed",targetId:"cheap",minQuality:1,reason:"after downgrade"}];
 let calls=0;const seen=[];
 const runtime=new ModelRuntime(policy(),async m=>{seen.push(m.id);return m.id;},async()=>true,{classify:async()=>decisions[Math.min(calls++,decisions.length-1)]});
 try{runtime.setTask("downgrade task");await runtime.call({},signal());
 runtime.report("verification_failed",{reason:"first failure"});runtime.report("verification_failed",{reason:"second failure"});
 await runtime.call({},signal());
 assert.equal(runtime.state.preferred,"strong");assert.deepEqual(seen,["cheap","strong"]);
 runtime.report("phase_complete",{reason:"phase done",phase:"p1"});
 await runtime.call({},signal());
 assert.equal(runtime.state.preferred,"strong");assert.deepEqual(seen,["cheap","strong","strong"]);
 runtime.report("phase_complete",{reason:"checks passed",phase:"p1",verificationPassed:true});
 await runtime.call({},signal());
 assert.equal(runtime.state.preferred,"cheap");assert.deepEqual(seen,["cheap","strong","strong","cheap"]);
 assert.equal(calls,2);}finally{runtime.close();}
});
test("attempts, failures and probes are metered; unknown usage stays unknown",async()=>{
 const budgetStore=memstore({limit:10,used:0,intents:{}});
 const ledgerStore=memstore({kinds:{},targets:{}});
 let broken=true;
 const runtime=new ModelRuntime(policy(),async m=>{if(m.id==="cheap"&&broken)throw new ModelFailure("transient");return m.id;},async()=>true,undefined,()=>{},{
  budget:new RequestBudget(budgetStore.store),ledger:new UsageLedger(ledgerStore.store),usageOf:()=>usage(10,5,2)});
 try{runtime.setTask("metered task");assert.equal(await runtime.call({},signal()),"strong");
  await runtime.checkRecovery(Date.now()+500);await runtime.checkRecovery(Date.now()+1000);}finally{runtime.close();}
 assert.equal(budgetStore.state.used,2);
 const ledger=new UsageLedger(ledgerStore.store);
 const breakdown=await ledger.breakdown();
 assert.equal(breakdown["kind:main"].requests,2);
 assert.equal(breakdown["kind:main"].unknownReports,1);
 assert.equal(breakdown["kind:main"].inputTokens,"unknown");
 assert.equal(breakdown["target:strong"].inputTokens,10);
 assert.equal(breakdown["target:strong"].cost,66/1_000_000);
 assert.equal(breakdown["kind:probe"].requests,2);
 assert.equal(breakdown["kind:probe"].cost,"unknown");
 const summary=await ledger.summary();
 assert.equal(summary.requests,4);
 assert.equal(summary.inputTokens,"unknown");
});
test("auxiliary calls share recovery, budget and metering",async()=>{
 const budgetStore=memstore({limit:10,used:0,intents:{}});
 const ledgerStore=memstore({kinds:{},targets:{}});
 const aux=new AuxiliaryModelService({targets,preferred:"cheap",requirements:policy().requirements,
  recovery:{failoverEnabled:true,failbackEnabled:true,probeIntervalMs:20,maxProbeIntervalMs:100,requiredProbeSuccesses:2},maxAttempts:3,requestTimeoutMs:500},
  async(target,prompt,_signal,hooks)=>{hooks.progress();if(target.id==="cheap")throw new ModelFailure("transient");return {text:`done:${prompt}`,usage:usage(3,4)};},
  {budget:new RequestBudget(budgetStore.store),ledger:new UsageLedger(ledgerStore.store)});
 assert.equal(await aux.generate("intake","classify this",signal()),"done:classify this");
 assert.equal(aux.state.active,"strong");
 assert.equal(budgetStore.state.used,2);
 const breakdown=await new UsageLedger(ledgerStore.store).breakdown();
 assert.equal(breakdown["kind:auxiliary:intake"].requests,2);
 assert.equal(breakdown["kind:auxiliary:intake"].unknownReports,1);
 assert.equal(breakdown["kind:auxiliary:intake"].inputTokens,"unknown");
 assert.equal(breakdown["target:strong"].inputTokens,3);
 assert.equal(breakdown["target:strong"].cost,33/1_000_000);
 assert.equal(breakdown["target:cheap"].inputTokens,"unknown");
});
test("auxiliary calls stop when the global budget is exhausted",async()=>{
 const budgetStore=memstore({limit:1,used:0,intents:{}});
 const aux=new AuxiliaryModelService({targets,preferred:"cheap",requirements:policy().requirements,
  recovery:{failoverEnabled:true,failbackEnabled:false,probeIntervalMs:20,maxProbeIntervalMs:100,requiredProbeSuccesses:2},maxAttempts:3,requestTimeoutMs:500},
  async()=>{throw new ModelFailure("transient");},
  {budget:new RequestBudget(budgetStore.store)});
 await assert.rejects(aux.generate("intake","prompt",signal()),/Model request failed/);
 assert.equal(budgetStore.state.used,1);
});
test("external planner sessions are reserved and metered with unknown usage",async()=>{
 const budgetStore=memstore({limit:10,used:0,intents:{}});
 const ledgerStore=memstore({kinds:{},targets:{}});
 const aux=new AuxiliaryModelService({targets,preferred:"cheap",requirements:policy().requirements,
  recovery:{failoverEnabled:true,failbackEnabled:false,probeIntervalMs:20,maxProbeIntervalMs:100,requiredProbeSuccesses:2},maxAttempts:3,requestTimeoutMs:500},
  async()=>({text:"",usage:usage(0,0)}),
  {budget:new RequestBudget(budgetStore.store),ledger:new UsageLedger(ledgerStore.store)});
 await aux.meterExternal("planner","goal-1","strong");
 assert.equal(budgetStore.state.used,1);
 const breakdown=await new UsageLedger(ledgerStore.store).breakdown();
 assert.equal(breakdown["kind:auxiliary:planner"].requests,1);
 assert.equal(breakdown["kind:auxiliary:planner"].inputTokens,"unknown");
 assert.equal(breakdown["kind:auxiliary:planner"].cost,"unknown");
});
test("local budget exhaustion neither fails over nor pollutes shared health (m1rev-F004)",async()=>{
 const shared=new HealthService();const seen=[];
 const runtime=new ModelRuntime(policy({maxRequests:1}),async m=>{seen.push(m.id);return m.id;},async()=>true,undefined,()=>{},{health:shared});
 try{assert.equal(await runtime.call({},signal()),"cheap");
  await assert.rejects(runtime.call({},signal()),/budget_exhausted/);
  assert.deepEqual(seen,["cheap"]);
  assert.deepEqual(runtime.checkpoint.recovery.health,[]);
  assert.equal(shared.entry(targets[0]),undefined);
  assert.equal(shared.entry(targets[1]),undefined);}finally{runtime.close();}
});
test("auxiliary reservations do not replay across instances (m1rev-F003)",async()=>{
 const budgetStore=memstore({limit:10,used:0,intents:{}});
 const make=()=>new AuxiliaryModelService({targets,preferred:"cheap",requirements:policy().requirements,
  recovery:{failoverEnabled:true,failbackEnabled:false,probeIntervalMs:20,maxProbeIntervalMs:100,requiredProbeSuccesses:2},maxAttempts:3,requestTimeoutMs:500},
  async()=>({text:"ok",usage:usage(1,1)}),{budget:new RequestBudget(budgetStore.store)});
 await make().generate("intake","same prompt",signal());
 await make().generate("intake","same prompt",signal());
 assert.equal(budgetStore.state.used,2);
});
test("main reservations do not collide across instances (wire-rev-F001)",async()=>{
 const budgetStore=memstore({limit:10,used:0,intents:{}});
 // Two ModelRuntime instances (host process and worker process) share one durable budget store
 // and both restart their attempt generation at 1: identical main intents must not silently skip.
 const make=()=>new ModelRuntime(policy(),async m=>m.id,async()=>true,undefined,()=>{},{budget:new RequestBudget(budgetStore.store)});
 const first=make(),second=make();
 try{first.setTask("same task");second.setTask("same task");
  await first.call({},signal());await second.call({},signal());}finally{first.close();second.close();}
 assert.equal(budgetStore.state.used,2);
 assert.equal(Object.keys(budgetStore.state.intents).length,2);
});
test("route classifier prompt carries routing evidence (wire-rev-F002)",async()=>{
 const prompts=[];
 const classifier=routeClassifier(async prompt=>{prompts.push(prompt);return JSON.stringify({mode:"fixed",targetId:"cheap",minQuality:1,reason:"stable"});});
 const decision=await classifier.classify("task text",targets,signal(),[
  {signal:"phase_complete",reason:"checks passed",phase:"p1",verificationPassed:true,at:123},
  {signal:"no_progress",reason:"identical output",phase:undefined,verificationPassed:undefined,at:456},
 ]);
 assert.deepEqual(decision,{mode:"fixed",targetId:"cheap",minQuality:1,reason:"stable"});
 const prompt=prompts[0];
 assert.match(prompt,/phase_complete/);
 assert.match(prompt,/checks passed/);
 assert.match(prompt,/"phase":"p1"/);
 assert.match(prompt,/"verificationPassed":true/);
 assert.match(prompt,/no_progress/);
 assert.match(prompt,/identical output/);
});
test("policy layers narrow the inherited policy",()=>{
 const base=policy();
 const agent=resolveModelPolicy(base,{allowedIds:["strong"],preferred:"strong",recovery:{failbackEnabled:false}});
 assert.deepEqual(agent.requirements.allowedIds,["strong"]);
 assert.equal(agent.recovery.failoverEnabled,true);
 assert.equal(agent.recovery.failbackEnabled,false);
 const sub=resolveModelPolicy(base,{allowedIds:["strong"],preferred:"strong"},{minQuality:3});
 assert.equal(sub.requirements.minQuality,3);
 assert.equal(sub.preferred,"strong");
 const bounded=resolveModelPolicy(base,{dataBoundary:"open"});
 assert.equal(bounded.requirements.dataBoundary,"open");
 assert.throws(()=>resolveModelPolicy(bounded,{dataBoundary:"eu"}));
 assert.throws(()=>resolveModelPolicy(base,{allowedIds:["cheap","strong","ghost"]}));
 assert.throws(()=>resolveModelPolicy(base,{minQuality:0}));
 assert.throws(()=>resolveModelPolicy(base,{capabilities:[]}));
 assert.throws(()=>resolveModelPolicy(base,{maxRequests:base.maxRequests+1}));
 assert.throws(()=>resolveModelPolicy(base,{preferred:"ghost"}));
 const strict={...base,recovery:{...base.recovery,failoverEnabled:false}};
 assert.throws(()=>resolveModelPolicy(strict,{recovery:{failoverEnabled:true}}));
 const narrowed=resolveModelPolicy(base,{targets:[targets[0]]});
 assert.equal(narrowed.targets.length,1);
 assert.throws(()=>resolveModelPolicy(base,{targets:[{...targets[1],costRank:0}]}));
});
