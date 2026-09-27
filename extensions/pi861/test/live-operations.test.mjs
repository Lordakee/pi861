import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationJournal } from "../src/live/operations.ts";
import { FileStateStore } from "../src/live/store.ts";
import { McpClient, McpFailure } from "../src/live/mcp.ts";
import { IncrementBuffer } from "../src/routing.ts";
const intent={requestId:"one",principal:"role",resource:"database/row",fingerprint:"hash",readOnly:false};
test("operation receipt replays committed result, rejects changed intent, survives reopen",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pi861-op-"));try{
 let count=0;const path=join(dir,"state.json"),create=()=>new OperationJournal(new FileStateStore(path,{receipts:{}}));
 assert.deepEqual(await create().run(intent,async()=>{count++;return {id:1};}),{id:1});
 assert.deepEqual(await create().run(intent,async()=>{count++;return {id:2};}),{id:1});assert.equal(count,1);
 await assert.rejects(()=>create().run({...intent,fingerprint:"other"},async()=>{}),/idempotency/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("unknown side effect blocks equivalent fresh call until trusted reconciliation",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pi861-op-"));try{
 const journal=new OperationJournal(new FileStateStore(join(dir,"state.json"),{receipts:{}}));let count=0;
 await assert.rejects(()=>journal.run(intent,async()=>{count++;throw new McpFailure("response lost","unknown");}));
 await assert.rejects(()=>journal.run({...intent,requestId:"two"},async()=>{count++;}),/unresolved/);assert.equal(count,1);
 await journal.resolve("role","one","Queried provider request status and confirmed the operation did not commit");
 await journal.run({...intent,requestId:"two"},async()=>{count++;return {done:true};});assert.equal(count,2);
 assert.equal((await journal.list("other")).length,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("AX4/p3-pre-dispatch-cancel: cancelling between complete arguments and journal admission leaves zero side effects and a safely retryable request",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pi861-ax4p3-"));try{
 const sideEffects=[];
 const server=createServer((req,res)=>{let body="";req.on("data",c=>{body+=c;});req.on("end",()=>{
  const input=JSON.parse(body);
  if(input.method==="initialize"){res.setHeader("Mcp-Session-Id","s1");res.setHeader("Content-Type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:input.id,result:{protocolVersion:"2025-11-25",capabilities:{tools:{}}}}));return;}
  if(input.method==="tools/list"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:input.id,result:{tools:[{name:"lookup",inputSchema:{type:"object",properties:{project:{type:"string"}},required:["project"],additionalProperties:false}}]}}));return;}
  if(input.method==="tools/call")sideEffects.push(input.params.arguments); // the observable side-effect boundary
  res.setHeader("Content-Type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:input.id,result:{content:[{type:"text",text:"ok"}]}}));
 });});
 server.listen(0,"127.0.0.1");await once(server,"listening");
 const client=new McpClient({id:"http",accountId:"test",transport:{kind:"http",url:`http://127.0.0.1:${server.address().port}/mcp`,allowLoopbackHttp:true}});
 const journal=new OperationJournal(new FileStateStore(join(dir,"state.json"),{receipts:{}}));
 try{
  const [tool]=await client.tools(new AbortController().signal);
  const buffer=new IncrementBuffer();
  const attempt={generation:1,configId:"strong",configRevision:"1"};
  buffer.toolArgs(attempt,"call-1",'{"project":"p"}');
  const decision=buffer.endToolArgs(attempt,"call-1");
  assert.equal(decision.dispatchable,true); // arguments fully received and parsed
  const controller=new AbortController();
  controller.abort(new Error("user cancelled at the dispatch boundary"));
  assert.throws(()=>controller.signal.throwIfAborted(),/user cancelled at the dispatch boundary/); // the host fence refuses to admit the operation
  assert.equal(sideEffects.length,0); // nothing was ever dispatched
  assert.deepEqual(await journal.list("role"),[]); // nothing journaled: no receipt exists to block a retry
  const fresh=new AbortController().signal;
  await journal.run(intent,()=>client.call("lookup",decision.args,tool.schemaHash,fresh));
  assert.equal(sideEffects.length,1); // the same request re-runs exactly once, not twice
 }finally{client.close();server.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("AX4/p4-dispatch-unconfirmed: stream loss after a committed side effect journals unknown, blocks equivalent redispatch and never repeats the effect",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pi861-op-mcp-"));try{
 const sideEffects=[];
 const server=createServer((req,res)=>{let body="";req.on("data",c=>{body+=c;});req.on("end",()=>{
  const input=JSON.parse(body);
  if(input.method==="initialize"){res.setHeader("Mcp-Session-Id","s1");res.setHeader("Content-Type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:input.id,result:{protocolVersion:"2025-11-25",capabilities:{tools:{}}}}));return;}
  if(input.method==="tools/list"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:input.id,result:{tools:[{name:"lookup",inputSchema:{type:"object",properties:{project:{type:"string"}},required:["project"],additionalProperties:false}}]}}));return;}
  if(input.method==="tools/call")sideEffects.push(input.params.arguments); // the server commits its effect first...
  // ...then claims SSE and ends the stream without ever sending the response.
  res.writeHead(200,{"content-type":"text/event-stream"});res.write(": accepted\r\n\r\n");setTimeout(()=>res.end(),50);
 });});
 server.listen(0,"127.0.0.1");await once(server,"listening");
 const client=new McpClient({id:"http",accountId:"test",transport:{kind:"http",url:`http://127.0.0.1:${server.address().port}/mcp`,allowLoopbackHttp:true}});
 const [tool]=await client.tools(new AbortController().signal);
 const journal=new OperationJournal(new FileStateStore(join(dir,"state.json"),{receipts:{}}));
 const dispatch=()=>client.call("lookup",{project:"p"},tool.schemaHash,new AbortController().signal);
 try{
  await assert.rejects(journal.run({...intent,resource:"mcp/http/lookup"},dispatch),/stream ended/);
  await assert.rejects(journal.run({...intent,requestId:"two",resource:"mcp/http/lookup"},dispatch),/unresolved/); // replay refused
  await assert.rejects(journal.run({...intent,resource:"mcp/http/lookup"},dispatch),/unknown outcome/); // same-request replay also refused
  const receipts=await journal.list("role");
  assert.equal(receipts.find(r=>r.requestId==="one").state,"unknown"); // never silently "committed"
  assert.equal(sideEffects.length,1); // the effect happened at most once despite three attempts
 }finally{server.close();client.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
