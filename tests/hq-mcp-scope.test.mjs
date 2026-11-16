import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'hq-scope-'));
const config = join(dir, 'knowledge.json');
writeFileSync(config, JSON.stringify({sources: [], devices: [{id:'local', label:'Local', url:'http://127.0.0.1:1/mcp', token:'fixture-token'}], grants:{wide:{sources:[],devices:['local']}}}));
Object.assign(process.env, {DB_PATH:join(dir,'test.db'), GROKBOT_KNOWLEDGE_CONFIG:config, COMPOSIO_API_KEY:'test', XAI_API_KEY:'test', ORGO_API_KEY:'test', SESSION_SECRET:'fixture-session'});
const realFetch=globalThis.fetch; globalThis.fetch=(input,init)=>String(input?.url??input).includes('composio')?Promise.resolve(new Response('{}',{status:401,headers:{'content-type':'application/json'}})):realFetch(input,init);
const {db} = await import('../server/src/db.ts');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,0)').run('u','u@test.invalid','Owner');
for(const id of ['wide','limited']) db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,0,0)').run(id,'u',id);
const {policyFor, toolMap} = await import('../server/src/agent/tools.ts');
const {mcpApi} = await import('../server/src/mcp.ts');
const {mcpToken} = await import('../server/src/engine.ts');
const invoke = async (name,args) => {
 const r = await mcpApi.request('/wide',{method:'POST',headers:{authorization:`Bearer ${mcpToken('wide')}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
 return r.json();
};
test('native T3 writes require approval while fixed reads are allowed',()=>{
 assert.equal(policyFor('u','mcp_call',{device:'local',tool:'t3_thread_launch'}).decision,'ask');
 assert.equal(policyFor('u','mcp_call',{device:'local',tool:'t3_environment_read'}).decision,'allow');
 assert.ok(toolMap.has('search_codex_memory'));
});
test('blocked native MCP actions never reach implementation',async()=>{
 db.prepare("INSERT INTO policies(user_id,tool,mode) VALUES ('u','mcp:local:t3_thread_launch','blocked')").run();
 const r = await invoke('mcp_call',{device:'local',tool:'t3_thread_launch',arguments:{scratch:true}});
 assert.match(r.result.content[0].text,/declined/i);
});
test('Hermes HTTP tool requests retain the originating Bot restriction across restart',async()=>{
 db.prepare('UPDATE bots SET knowledge_scope_bot_ids=? WHERE id=?').run(JSON.stringify(['limited']),'wide');
 const r = await invoke('mcp_call',{device:'local',tool:'t3_environment_read',arguments:{}});
 assert.equal(r.result.isError,true);
 assert.match(r.result.content[0].text,/access denied/i);
});
test('owner approval does not override a revoked device grant',async()=>{
 db.prepare('DELETE FROM policies WHERE user_id=?').run('u');
 db.prepare('UPDATE bots SET knowledge_scope_bot_ids=? WHERE id=?').run('[]','wide');
 const pending=invoke('mcp_call',{device:'local',tool:'t3_thread_launch',arguments:{scratch:true}});
 let approval;
 for(let i=0;i<100;i++) {
  approval=db.prepare("SELECT id FROM approvals WHERE bot_id='wide' AND status='pending'").get();
  if(approval) break;
  await new Promise(r=>setTimeout(r,10));
 }
 assert.ok(approval,'native MCP write must create an approval card');
 const policy=JSON.parse(readFileSync(config,'utf8'));
 policy.grants.wide.devices=[];
 writeFileSync(config,JSON.stringify(policy));
 const {resolveApproval}=await import('../server/src/agent/loop.ts');
 resolveApproval('u',approval.id,'allow');
 const result=await pending;
 assert.equal(result.result.isError,true);
 assert.match(result.result.content[0].text,/access denied/i);
});
test('a Bot bearer token cannot authenticate another Bot endpoint',async()=>{
 const r=await mcpApi.request('/limited',{method:'POST',headers:{authorization:`Bearer ${mcpToken('wide')}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_mcp_devices'}})});
 assert.equal(r.status,401);
});
after(()=>{globalThis.fetch=realFetch;db.close();rmSync(dir,{recursive:true,force:true});});
