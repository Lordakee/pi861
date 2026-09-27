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
test("MCP stream loss after dispatch marks the operation unknown and blocks equivalent redispatch (AX4)",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pi861-op-mcp-"));try{
 const server=createServer((req,res)=>{let body="";req.on("data",c=>{body+=c;});req.on("end",()=>{
  const input=JSON.parse(body);
  if(input.method==="initialize"){res.setHeader("Mcp-Session-Id","s1");res.setHeader("Content-Type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:input.id,result:{protocolVersion:"2025-11-25",capabilities:{tools:{}}}}));return;}
  if(input.method==="tools/list"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:input.id,result:{tools:[{name:"lookup",inputSchema:{type:"object",properties:{project:{type:"string"}},required:["project"],additionalProperties:false}}]}}));return;}
  // tools/call: claim SSE, keep the stream alive, then end without ever sending the response.
  res.writeHead(200,{"content-type":"text/event-stream"});res.write(": accepted\r\n\r\n");setTimeout(()=>res.end(),50);
 });});
 server.listen(0,"127.0.0.1");await once(server,"listening");
 const client=new McpClient({id:"http",accountId:"test",transport:{kind:"http",url:`http://127.0.0.1:${server.address().port}/mcp`,allowLoopbackHttp:true}});
 const [tool]=await client.tools(new AbortController().signal);
 const journal=new OperationJournal(new FileStateStore(join(dir,"state.json"),{receipts:{}}));
 const dispatch=()=>client.call("lookup",{project:"p"},tool.schemaHash,new AbortController().signal);
 await assert.rejects(journal.run({...intent,resource:"mcp/http/lookup"},dispatch),/stream ended/);
 await assert.rejects(journal.run({...intent,requestId:"two",resource:"mcp/http/lookup"},dispatch),/unresolved/); // replay refused
 const receipts=await journal.list("role");
 assert.equal(receipts.find(r=>r.requestId==="one").state,"unknown"); // never silently "committed"
 server.close();client.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
