import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function createCodexFixture(root: string) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const statePath = join(bin, "fixture.json");
  const calls = join(bin, "calls.jsonl");
  const binary = join(bin, "codex");
  const state = {
    version: "0.153.4",
    authentication: "chatgpt",
    model: "synthetic-model",
    models: [] as string[],
    runtimeTools: [
      "clock__curr_time",
      "read_selected_material",
      "skills__list",
      "skills__read",
    ] as string[],
    mode: "normal",
    runtimeStyle: "code",
    attachmentId: "selected-material",
    widgetPackage: "{}",
    instructionsPath: "",
    inlineInstructions: "",
    /** Per-model reasoning effort advertised by model/list, and the user's configured default. */
    efforts: {
      "synthetic-model": {
        default: "medium",
        levels: ["low", "medium", "high", "xhigh"],
      },
    } as Record<string, { default: string; levels: string[] }>,
    configuredEffort: null as string | null,
    /** When set, thread/start and thread/resume report this level instead of echoing the request. */
    effortReadback: null as string | null,
    /** Reviewer turn behaviour (feature-t30): normal, scopeExtra, network, twice, fileChange, hang, noApproval, toolCall, commentary, twoFinal. */
    reviewer: "normal",
    /** When set, the restricted config read-back reports this permission profile filesystem instead of the requested one. */
    reviewerFilesystemExtra: null as string | null,
    /** thread/start environment read-back: local (follows the request), empty, null or foreign (refusal paths). */
    reviewerEnvironments: "local" as "local" | "empty" | "null" | "foreign",
    reviewerNetwork: false,
    reviewerMcpEnabled: false,
    /**
     * Skill instructions in the contract requests, as Codex 0.159 sends them: unless-disabled lists the
     * skills under HOME/.agents/skills unless skills.include_instructions=false was passed; always
     * ignores that setting (a Codex whose read-back and behaviour disagree); none never lists them.
     */
    skillInstructions: "unless-disabled" as
      "unless-disabled" | "always" | "none",
  };
  const update = (patch: Partial<typeof state>) => {
    Object.assign(state, patch);
    writeFileSync(statePath, JSON.stringify(state));
  };
  update({});
  writeFileSync(
    binary,
    String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
fs.appendFileSync(path.join(__dirname, 'invocations.jsonl'), JSON.stringify(process.argv.slice(2))+'\n');
if (process.argv.includes('--version')) { console.log('codex-cli ' + state.version); process.exit(0); }
// Every -c override is parsed back (TOML inline tables as codexToml encodes them) so the config read-back
// repeats exactly what the product asked for; the chat and the Reviewer policies share this path.
function parseToml(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '"') { let j = i + 1; while (j < text.length) { if (text[j] === '\\') j += 2; else if (text[j] === '"') break; else j++; } const out = JSON.parse(text.slice(i, j + 1)); i = j + 1; return out; }
    if (c === '[') { i++; const arr = []; ws(); if (text[i] === ']') { i++; return arr; } for (;;) { arr.push(value()); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === ']') { i++; return arr; } throw new Error('toml array'); } }
    if (c === '{') { i++; const obj = {}; ws(); if (text[i] === '}') { i++; return obj; } for (;;) { ws(); const key = value(); ws(); if (text[i] !== '=') throw new Error('toml table'); i++; obj[key] = value(); ws(); if (text[i] === ',') { i++; continue; } if (text[i] === '}') { i++; return obj; } throw new Error('toml table end'); } }
    const m = /^(true|false|-?\d+(?:\.\d+)?)/.exec(text.slice(i)); if (!m) throw new Error('toml scalar'); i += m[0].length; return m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1]);
  };
  const out = value(); ws(); if (i !== text.length) throw new Error('toml trailing'); return out;
}
const overrides = {};
for (let k = 0; k < process.argv.length; k++) if (process.argv[k] === '-c') { const eq = process.argv[k + 1].indexOf('='); let parsed; try { parsed = parseToml(process.argv[k + 1].slice(eq + 1)); } catch { parsed = process.argv[k + 1].slice(eq + 1); } overrides[process.argv[k + 1].slice(0, eq)] = parsed; }
const policy = typeof overrides.default_permissions === 'string';
const profileName = policy ? overrides.default_permissions : null;
function config() {
  const value = {model:state.model,model_provider:'openai',api_key:'SYNTHETIC_SECRET_NOT_REAL',developer_instructions:fixtureProvider?'':state.inlineInstructions,...(state.configuredEffort?{model_reasoning_effort:state.configuredEffort}:{})};
  if (!policy) return value;
  const requested = overrides['permissions.' + profileName] || {};
  const fs = { ...(requested.filesystem || {}), glob_scan_max_depth:null };
  if (state.reviewerFilesystemExtra) fs[state.reviewerFilesystemExtra] = 'read';
  const mcp = { ...(overrides.mcp_servers || {}) };
  if (state.reviewerMcpEnabled) mcp.synthetic_mcp = { enabled: true };
  return { ...value, ...(overrides['skills.include_instructions'] === undefined ? {} : {skills:{include_instructions:overrides['skills.include_instructions']}}), features: { ...(overrides.features || {}), ...(state.mode === 'conflict' ? {shell_tool:true} : {}) }, mcp_servers:mcp, permissions:{[profileName]:{filesystem:fs,network:{enabled: state.reviewerNetwork ? true : (requested.network || {}).enabled}}}, agents:overrides.agents,default_permissions:profileName,web_search:overrides.web_search,approval_policy:overrides.approval_policy,notify:overrides.notify,project_doc_max_bytes:overrides.project_doc_max_bytes };
}
const readback = (params) => state.effortReadback ?? (params && params.config && typeof params.config.model_reasoning_effort === 'string' ? params.config.model_reasoning_effort : null);
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const fixtureProvider = process.argv.find(arg=>arg.startsWith('model_providers.csthink_contract='));
let contractCall;
const contractInput=[];
async function contractNext(output) {
  if (output) contractInput.push(state.runtimeStyle==='functions'?{type:'function_call_output',call_id:contractCall,output:typeof output==='string'?output:JSON.stringify(output)}:{type:'custom_tool_call_output',call_id:contractCall,output:[{type:'input_text',text:JSON.stringify(output)}]});
  const match=fixtureProvider.match(/"base_url"="([^" ]+)"/);
  if(!match||!match[1].startsWith('http://127.0.0.1:'))throw new Error('nonlocal fixture endpoint');
  const modelArg=process.argv.find(arg=>arg.startsWith('model='));
  const skillsDir=path.join(process.env.HOME||'/nonexistent','.agents','skills');
  const listsSkills=state.skillInstructions==='always'||(state.skillInstructions==='unless-disabled'&&overrides['skills.include_instructions']!==false);
  const skillList=listsSkills&&fs.existsSync(skillsDir)?fs.readdirSync(skillsDir):[];
  const instructions=skillList.length?[{type:'message',role:'developer',content:[{type:'input_text',text:'<skills_instructions>'+skillList.map(name=>'- '+name+': (file: '+name+'/SKILL.md)').join('\n')+'</skills_instructions>'}]}]:[];
  const skillTools=['list','read'].filter(name=>state.runtimeTools.includes('skills__'+name)).map(name=>({type:'function',name}));
  const response=await fetch(match[1]+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:JSON.parse(modelArg.slice(6)),input:[...instructions,...contractInput],...(state.runtimeStyle==='functions'?{tools:[...(skillTools.length?[{type:'namespace',name:'skills',tools:skillTools}]:[]),...state.runtimeTools.filter(t=>!t.startsWith('skills__')&&t!=='clock__curr_time').map(name=>({type:'function',name})),{type:'function',name:'request_user_input'}]}:{})})});
  const events=(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
  const item=events.find(e=>e.type==='response.output_item.done')?.item;
  if(!item)throw new Error('missing fixture response');
  if(item.type==='message'){delta('synthetic-complete');completed('completed');return;}
  contractCall=item.call_id;
  if(item.type==='function_call'){
    if(item.namespace==='skills'&&item.name==='list'&&state.runtimeTools.includes('skills__list'))await contractNext({skills:[],warnings:[],next_cursor:null});
    else if(item.namespace==='skills'&&item.name==='read'&&state.runtimeTools.includes('skills__read'))await contractNext('skill package is not available');
    else if(item.name==='read_selected_material')materialCall('contract-request',{arguments:{attachmentId:'contract-material'}});
    else await contractNext('unsupported tool call');
    return;
  }
  if(item.input.includes('Object.keys(tools)'))await contractNext({tools:state.runtimeTools??['clock__curr_time','read_selected_material','skills__list','skills__read'],fetch:'undefined',process:'undefined',require:'undefined'});
  else if(item.input.includes('skills__list'))await contractNext(state.runtimeTools.includes('skills__list')?{orchestrator:{skills:[],warnings:[],next_cursor:null},executor:{skills:[],warnings:[],next_cursor:null}}:'Script error: TypeError: tools.skills__list is not a function');
  else if(item.input.includes('bypassDenied'))await contractNext({bypassDenied:true});
  else if(item.input.includes('import('))await contractNext({nodeImportDenied:true});
  else materialCall('contract-request',{arguments:{attachmentId:'contract-material'}});
}
let answer='';
const delta = text => {answer+=text;send({method:'item/agentMessage/delta',params:{threadId:'thread-fixture',turnId:'turn-fixture',itemId:'answer-fixture',delta:text}});};
const completed = status => {fs.writeFileSync(path.join(process.cwd(),'history.json'),JSON.stringify({id:'turn-fixture',status,items:[{type:'agentMessage',id:'answer-fixture',text:answer}]}));if(reviewerThread&&status==='completed')send({method:'item/completed',params:{threadId:'thread-fixture',turnId:'turn-fixture',item:{type:'agentMessage',id:'answer-fixture',text:answer}}});send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status}}});};
const materialCall = (id='material-request',override={}) => send({id,method:'item/tool/call',params:{threadId:'thread-fixture',turnId:'turn-fixture',callId:id,tool:'read_selected_material',arguments:{attachmentId:state.attachmentId},...override}});
// Reviewer turn (feature-t30): one native permission request for the material directory named in the turn input,
// a sandboxed read after the grant, one agent message, then turn/completed; the state file selects the misbehaviour.
let reviewerThread = false;
// The thread's environment read-back as Codex 0.155.1 reports it: an explicit list is echoed (an empty one
// closes environment access), an omitted field selects the local environment for the thread cwd; the
// reviewerEnvironments state forces the empty, null or foreign-directory shapes for the refusal paths.
function environmentsOf(params) {
  const forced = state.reviewerEnvironments || 'local';
  if (forced === 'empty') return [];
  if (forced === 'null') return null;
  if (forced === 'foreign') return [{environmentId:'local', cwd:'/nonexistent/elsewhere', runtimeWorkspaceRoots:['/nonexistent/elsewhere']}];
  if (Array.isArray(params.environments)) return params.environments;
  return [{environmentId:'local', cwd:params.cwd, runtimeWorkspaceRoots:[params.cwd]}];
}
let approvalSeq = 0;
const approvalWaiters = new Map();
function requestApproval(entries, network) {
  const id = 'approval-' + (++approvalSeq);
  send({id, method:'item/permissions/requestApproval', params:{threadId:'thread-fixture',turnId:'turn-fixture',itemId:'perm-'+approvalSeq,cwd:process.cwd(),startedAtMs:Date.now(),permissions:{fileSystem:{read:entries.filter(e=>e.access==='read').map(e=>e.path.path),write:null,entries},network},reason:'read the materials'}});
  return new Promise(resolve => approvalWaiters.set(id, resolve));
}
function materialsDirOf(params) {
  const text = (params.input || []).map(i => i.text || '').join('\n');
  const match = /材料目录：(.+)/.exec(text);
  return match ? match[1] : null;
}
async function reviewerTurn(params) {
  const dir = materialsDirOf(params);
  const entry = (p) => ({access:'read',path:{type:'path',path:p}});
  fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ reviewerTurn: true, materials: dir, input: params.input }) + '\n');
  if (state.reviewer === 'toolCall') { send({id:'tool-1',method:'item/tool/call',params:{threadId:'thread-fixture',turnId:'turn-fixture',callId:'tool-1',tool:'read_selected_material',arguments:{}}}); return; }
  if (state.reviewer === 'fileChange') { send({method:'item/completed',params:{threadId:'thread-fixture',turnId:'turn-fixture',item:{type:'fileChange',id:'change-1',status:'completed'}}}); return; }
  if (state.reviewer === 'noApproval') { delta('REVIEW without reading'); completed('completed'); return; }
  const entries = state.reviewer === 'scopeExtra' ? [entry(dir), entry('/etc')] : [entry(dir)];
  const granted = await requestApproval(entries, state.reviewer === 'network' ? {enabled:true} : null);
  const ok = !!(granted && granted.permissions && granted.permissions.fileSystem && Array.isArray(granted.permissions.fileSystem.entries) && granted.permissions.fileSystem.entries.length);
  fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ approvalResponse: granted, granted: ok }) + '\n');
  if (!ok) return; // rejected: the host interrupts the turn
  if (state.reviewer === 'twice') { const second = await requestApproval([entry(dir)], null); fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ secondApproval: second }) + '\n'); return; }
  send({method:'item/started',params:{threadId:'thread-fixture',turnId:'turn-fixture',item:{type:'commandExecution',id:'cmd-1',status:'inProgress',command:'cat materials'}}});
  const names = dir && fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const bytes = names.map(n => fs.statSync(path.join(dir, n)).size);
  send({method:'item/completed',params:{threadId:'thread-fixture',turnId:'turn-fixture',item:{type:'commandExecution',id:'cmd-1',status:'completed',command:'cat materials',exitCode:0}}});
  if (state.reviewer === 'hang') { delta('REVIEW pending'); return; }
  // Phased messages as Codex 0.155.1 emits them: interim commentary before the terminal final_answer
  // (mode commentary), or two final answers (mode twoFinal), each completed as its own agentMessage item.
  const phased = (id, phase, text) => { send({method:'item/started',params:{threadId:'thread-fixture',turnId:'turn-fixture',item:{type:'agentMessage',id,text:'',phase}}}); send({method:'item/completed',params:{threadId:'thread-fixture',turnId:'turn-fixture',item:{type:'agentMessage',id,text,phase}}}); };
  if (state.reviewer === 'commentary' || state.reviewer === 'twoFinal') {
    phased('msg-1', 'commentary', 'Reading the materials.');
    phased('msg-2', 'commentary', 'Reviewing.');
    phased('msg-3', 'final_answer', 'REVIEW final: ' + names.join(','));
    if (state.reviewer === 'twoFinal') phased('msg-4', 'final_answer', 'REVIEW again');
    send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',status:'completed'}}});
    return;
  }
  delta('REVIEW: ' + names.join(',') + ' bytes ' + bytes.join(','));
  completed('completed');
}
rl.on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ method: m.method, params: m.params, id: m.id, error: m.error, result: m.result }) + '\n');
  if (!m.method) {
    if(typeof m.id==='string'&&approvalWaiters.has(m.id)){const resolve=approvalWaiters.get(m.id);approvalWaiters.delete(m.id);resolve(m.error?null:m.result);return;}
    if(m.id==='contract-request'&&m.result){void contractNext({contractMaterialRead:true});return;}
    if (['material-request','widget-request'].includes(m.id) && m.result) { delta('fixture-read-completed'); completed('completed'); }
    return;
  }
  if (m.method === 'initialized') return;
  if (state.mode === 'hang') return;
  if (state.mode === 'malformed') return process.stdout.write('invalid-json\n');
  if (state.mode === 'oversized') return process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1));
  if (state.mode === 'exit') return process.exit(1);
  let result;
  if (m.method === 'initialize') {
    if (state.mode === 'request') send({ id: 'host-request', method: 'command/exec', params: { command: 'never execute' } });
    result = { userAgent: 'synthetic-client', futureField: 123 };
  } else if (m.method === 'config/read') result = { config: config(), origins: {}, layers: [{ name: { type: 'user', file: '/synthetic/config.toml' }, config: { token: 'SYNTHETIC_SECRET_NOT_REAL' }}] };
  else if (m.method === 'account/read') result = { account: state.authentication === 'signedOut' ? null : { type: state.authentication, email: 'private@synthetic.invalid', token: 'SYNTHETIC_SECRET_NOT_REAL' }, requiresOpenaiAuth: true };
  else if (m.method === 'thread/resume') {const historyPath=path.join(process.cwd(),'history.json');const previous=fs.existsSync(historyPath)?JSON.parse(fs.readFileSync(historyPath,'utf8')):null;if(previous&&state.mode==='resume_unknown')previous.status='inProgress';result={thread:{id:'thread-fixture',turns:previous?[previous]:[]},model:m.params.model,modelProvider:m.params.modelProvider,approvalPolicy:'never',activePermissionProfile:{id:'csthink_assistant'},instructionSources:fixtureProvider?[]:(state.instructionsPath?[state.instructionsPath]:[]),reasoningEffort:readback(m.params)};}
  else if (m.method === 'thread/start') { reviewerThread = m.params.approvalPolicy && typeof m.params.approvalPolicy === 'object'; result = {thread:{id:'thread-fixture',environments:environmentsOf(m.params)},model:m.params.model,modelProvider:m.params.modelProvider,approvalPolicy:m.params.approvalPolicy ?? 'never',activePermissionProfile:{id:m.params.permissions ?? 'csthink_assistant'},instructionSources:fixtureProvider?[]:(state.instructionsPath?[state.instructionsPath]:[]),reasoningEffort:readback(m.params)}; }
  else if (m.method === 'turn/interrupt') { result={}; completed('interrupted'); }
  else if (m.method === 'turn/start') {
    result={turn:{id:'turn-fixture',status:'inProgress'}};
    setTimeout(() => {
      send({method:'turn/started',params:{threadId:'thread-fixture',turn:{id:'turn-fixture'}}});
      if(fixtureProvider){void contractNext();return;}
      if(reviewerThread){reviewerTurn(m.params);return;}
      if (state.mode==='turn_hang') { delta('partial-before-stop'); return; }
      if (state.mode==='turn_tool') { materialCall(); return; }
      if (state.mode==='turn_widget') { materialCall('widget-request',{tool:'submit_widget_candidate',arguments:{package:state.widgetPackage}}); return; }
      if (state.mode==='turn_spoof') { materialCall('spoof-request',{threadId:'other-thread'}); return; }
      if (state.mode==='turn_namespace') { materialCall('namespace-request',{namespace:'unregistered'}); return; }
      if (state.mode==='turn_extra') { materialCall('extra-request',{arguments:{attachmentId:'selected-material',path:'/forbidden'}}); return; }
      if (state.mode==='turn_duplicate') { materialCall(); setTimeout(()=>materialCall('second-request',{callId:'material-request'}),20); return; }
      delta(m.params.input.some(i=>i.type==='image')?'红色':'partial-answer');
      completed(state.mode==='turn_partial_fail'?'failed':'completed');
    },20);
  }
  else if (m.method === 'model/list') result = { data: [...new Set([state.model,...state.models])].map(model=>({model,isDefault:model===state.model,hidden:false,...(state.efforts&&Object.hasOwn(state.efforts,model)?{defaultReasoningEffort:state.efforts[model].default,supportedReasoningEfforts:state.efforts[model].levels.map(reasoningEffort=>({reasoningEffort,description:'synthetic '+reasoningEffort}))}:{})})), nextCursor: null };
  else return send({ id: m.id, error: { code: -32601, message: 'SYNTHETIC_SECRET_NOT_REAL' }});
  send({ id: m.id, result });
});
rl.on('close', () => process.exit(0));
`,
  );
  chmodSync(binary, 0o755);
  return { bin, binary, calls, update };
}
