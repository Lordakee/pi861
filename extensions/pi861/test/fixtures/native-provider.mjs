// Deterministic local Pi provider. Tests host integration, NOT real-model quality.
// Streams real event shards (text_delta / toolcall_delta / toolcall_end) so the runtime's
// streaming attempt adapter consumes a genuine incremental stream, not a one-shot done.
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
const text=m=>typeof m.content==="string"?m.content:(m.content??[]).filter(x=>x.type==="text").map(x=>x.text).join("\n");
const shards=(value,count=2)=>{const parts=[];for(let i=0;i<count;i++){const from=Math.ceil(value.length*i/count),to=Math.ceil(value.length*(i+1)/count);if(value.slice(from,to))parts.push(value.slice(from,to));}return parts.length?parts:[value];};
export default function fixture(pi){
 let failed=false;
 pi.registerProvider("pi861-fixture",{baseUrl:"http://127.0.0.1/unused-fixture",api:"openai-completions",apiKey:"test-no-external-request",
 models:["cheap","strong"].map(id=>({id,name:id,reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:200000,maxTokens:8192})),
 streamSimple(model,context){
 const output=createAssistantMessageEventStream();
 const messages=context.messages,users=messages.filter(m=>m.role==="user"),prompt=users.map(text).join("\n");
 const tools=getCurrentTools(messages);
 if(process.env.PI861_FIXTURE_LOG)appendFileSync(process.env.PI861_FIXTURE_LOG,JSON.stringify({model:model.id,prompt:prompt.slice(-500),tools:tools.map(t=>t.name)})+"\n");
 const result={role:"assistant",content:[{type:"text",text:"fixture complete"}],api:"openai-completions",provider:model.provider,model:model.id,
 usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()};
 if(prompt.includes("health probe")){result.content=[{type:"text",text:"OK"}];}
 else if(prompt.includes("Summarize the following untrusted historical record")){
 const input=JSON.parse(text(users.at(-1)).split("\n\n").at(-1));
 result.content=[{type:"text",text:JSON.stringify({abstract:"Generated fixture summary",overview:"Generated with source evidence",facts:[{text:input.text.slice(0,20),quote:input.text.slice(0,20)}]})}];
 }else if(process.env.PI861_FIXTURE_FAIL==="1"&&model.id==="cheap"&&!failed){failed=true;result.content=[];result.stopReason="error";result.errorMessage="ECONNRESET fixture injected failure";}
 else if(prompt.includes("fixture-route")&&!messages.some(m=>m.role==="toolResult"&&m.toolName==="pi861_model_route")){
 result.content=[{type:"toolCall",id:"fixture-route-call",name:"pi861_model_route",arguments:{signal:"phase_complete",reason:"fixture phase finished",phase:"p1",verificationPassed:true}}];result.stopReason="toolUse";
 }
 else if(prompt.includes("fixture-write")&&!messages.some(m=>m.role==="toolResult"&&m.toolName==="write")){
 result.content=[{type:"toolCall",id:"fixture-write-call",name:"write",arguments:{path:"fixture.txt",content:"written through real Pi"}}];result.stopReason="toolUse";
 }
 output.push({type:"start",partial:result});
 if(result.stopReason==="error"){output.push({type:"error",reason:"error",error:result});}
 else{
 for(const [index,block] of (Array.isArray(result.content)?result.content:[]).entries()){
 if(block.type==="text"){
 output.push({type:"text_start",contentIndex:index,partial:result});
 for(const shard of shards(String(block.text??"")))output.push({type:"text_delta",contentIndex:index,delta:shard,partial:result});
 output.push({type:"text_end",contentIndex:index,content:String(block.text??""),partial:result});
 }else if(block.type==="toolCall"){
 output.push({type:"toolcall_start",contentIndex:index,partial:result});
 for(const shard of shards(JSON.stringify(block.arguments??{})))output.push({type:"toolcall_delta",contentIndex:index,delta:shard,partial:result});
 output.push({type:"toolcall_end",contentIndex:index,toolCall:block,partial:result});
 }
 }
 output.push({type:"done",reason:result.stopReason,message:result});
 }
 return output;
 }});
}
