import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiRpcSession } from "../src/live/pi-rpc.ts";
const cli=process.env.PI861_TEST_PI_CLI;
/** Optional JSON string array inserted before the CLI entry, e.g. a tsx source-host launch: ["<tsx>/cli.mjs","--tsconfig","<tsconfig>"]. */
function launchPrefix(){const raw=process.env.PI861_TEST_PI_LAUNCH_PREFIX;if(!raw)return[];const parsed=JSON.parse(raw);
if(!Array.isArray(parsed)||parsed.some(part=>typeof part!=="string"))throw new Error("PI861_TEST_PI_LAUNCH_PREFIX must be a JSON array of strings");return parsed;}
/** Windows releases child working-directory handles slightly after process exit; retry a bounded number of times. */
async function removeTree(path){for(let attempt=0;attempt<20;attempt++){try{await rm(path,{recursive:true,force:true});return}catch(error){if(!["EBUSY","ENOTEMPTY","EPERM"].includes(error?.code))throw error;await sleep(250)}}await rm(path,{recursive:true,force:true});}
const timeoutMs=Number(process.env.PI861_TEST_TIMEOUT_MS??60000);
test("real Pi runtime: buffered failover, native file tool, durable memory and semantic maintenance",{skip:!cli,timeout:timeoutMs},async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-live-host-"));let session;
 try{
 const home=join(root,"home"),work=join(root,"project"),state=join(root,"state"),configFile=join(root,"config.json");await mkdir(home);await mkdir(work);
 const config={version:2,projectId:"host-test",stateDirectory:state,role:{id:"developer",skillIds:[],grants:[]},
 models:{targets:[{id:"cheap",revision:"1",provider:"pi861-fixture",model:"cheap",quality:1,costRank:1,contextWindow:200000,capabilities:["tools"],enabled:true},
 {id:"strong",revision:"1",provider:"pi861-fixture",model:"strong",quality:3,costRank:3,contextWindow:200000,capabilities:["tools"],enabled:true}],
 preferred:"cheap",intakeId:"cheap",enableRouting:false,requirements:{minQuality:1,contextTokens:100,capabilities:["tools"],allowedIds:["cheap","strong"]},
 recovery:{failoverEnabled:true,failbackEnabled:false,probeIntervalMs:100,maxProbeIntervalMs:1000,requiredProbeSuccesses:2},maxAttempts:3,requestTimeoutMs:10000,maxRequests:20,maxProbeRequests:2},
 memory:{autoRecall:true,autoCapture:true,autoEnrich:false,modelId:"strong"},budget:{maxRequests:50}};
 await writeFile(configFile,JSON.stringify(config));
 const env={HOME:home,USERPROFILE:home,PI_CODING_AGENT_DIR:join(home,".pi","agent"),PI861_CONFIG:configFile,PI861_FIXTURE_FAIL:"1",PI861_FIXTURE_LOG:join(root,"calls.jsonl"),NO_COLOR:"1"};
 const processSpec={command:process.execPath,args:[...launchPrefix(),cli,"--mode","rpc","--no-extensions","--no-skills","-e",fileURLToPath(new URL("./fixtures/native-provider.mjs",import.meta.url)),"-e",fileURLToPath(new URL("../runtime.ts",import.meta.url))],cwd:work,env};
 session=new PiRpcSession(processSpec,{waitForSettled:true});const signal=AbortSignal.timeout(timeoutMs-5000);
 const commands=await session.command("get_commands",{},signal);for(const name of ["skills","mcp","memory-maintain","model-policy"])assert.ok(commands.commands.some(c=>c.name===name),`Missing ${name}`);
 const run=await session.prompt("fixture-write: write fixture.txt once using the write tool",signal);
 assert.equal(await readFile(join(work,"fixture.txt"),"utf8"),"written through real Pi");assert.equal(run.toolCalls,1);
 const entries=await session.command("get_entries",{},signal);const routing=entries.entries.filter(e=>e.customType==="pi861.model-runtime.v2");assert.ok(routing.some(e=>e.data.active==="strong"&&e.data.preferred==="cheap"));
 await session.command("prompt",{message:"/remember durable-native-host-marker"},signal);
 await session.command("prompt",{message:"/memory-maintain"},signal);
 const saved=JSON.parse(await readFile(join(state,"memory.json"),"utf8"));assert.ok(saved.memory.items.some(x=>x.full==="durable-native-host-marker"));assert.ok(Object.keys(saved.projections).length>0);
 await session.close();session=undefined;
 session=new PiRpcSession({...processSpec,env:{...env,PI861_FIXTURE_FAIL:"0"}},{waitForSettled:true});
 await session.prompt("Find durable-native-host-marker in prior memory",signal);
 const calls=(await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);assert.ok(calls.some(c=>c.model==="strong"));
 const persisted=JSON.parse(await readFile(join(state,"memory.json"),"utf8"));assert.ok(persisted.memory.items.some(x=>x.full==="durable-native-host-marker"));
 }finally{await session?.close();await removeTree(root);}
});
