import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function createClaudeFixture(root: string) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const statePath = join(root, "state.json"),
    calls = join(root, "calls.jsonl"),
    binary = join(bin, "claude");
  const initial = {
    version: "2.1.263",
    mode: "normal",
    errorCode: "rate_limit",
    errorText: "Synthetic error",
    authentication: "subscription",
    model: "claude-synthetic[1m]",
    attachmentId: "selected",
    widgetPackage: "{}",
    /** Whether --help lists --effort, and the levels each resolved model advertises in initialize. */
    effortFlag: true,
    efforts: {
      "claude-synthetic[1m]": ["low", "medium", "high", "xhigh", "max"],
    } as Record<string, string[]>,
    /** Options removed from --help (feature-t30: the Implementer re-checks the help text before every start). */
    helpOmit: [] as string[],
    /** Print-mode text-input behaviour (feature-t30 Implementer): normal, wrongTools, budget (the CLI's own error_max_budget_usd end; the product passes no cap), hang, ignoreTerm, crash, flood. */
    implementer: "normal",
    implementerToolCalls: 1,
    /** Pause between tool-call frames; S-05 budget cases keep the target alive while the port stops it. */
    implementerToolDelayMs: 0,
    /** `flood`: one assistant frame of this many text bytes, then the target hangs (S-05 output limit). */
    implementerFloodBytes: 262144,
    /** Same-session children (`/bin/sleep`) the print target starts right after init; they outlive a stopped target (S-03 reclaim). */
    implementerChildren: 0,
    /** Descendants that escape into their own session (detached `/bin/sleep`) and outlive the target (stop unconfirmed). */
    implementerEscaped: 0,
    /** How long each escaped descendant lives; S-04 cases set a short life to observe the automatic release. */
    implementerEscapedSeconds: 60,
    costUsd: 0.0042,
  };
  writeFileSync(statePath, JSON.stringify(initial));
  writeFileSync(calls, "");
  const update = (value: Partial<typeof initial>) =>
    writeFileSync(
      statePath,
      JSON.stringify({
        ...JSON.parse(readFileSync(statePath, "utf8")),
        ...value,
      }),
    );
  writeFileSync(
    binary,
    `#!${process.execPath}
` +
      String.raw`
const fs = require('node:fs'), path = require('node:path'), rl = require('node:readline');
const root = path.dirname(__dirname), state = JSON.parse(fs.readFileSync(path.join(root,'state.json'),'utf8'));
const args=process.argv.slice(2);
const record=(value)=>fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify(value)+'\n');
record({args});
if(args[0]==='--version'){console.log(state.version+' (Claude Code)');process.exit(0);}
if(args[0]==='--help'){
 const lines=[
  'Usage: claude [options] [command] [prompt]',
  '',
  'Options:',
  '  -p, --print                           Print response and exit (useful for pipes)',
  '  --restricted                          Restricted mode: removes the built-in tools that run commands',
  '  --safe-mode                           Start with all customizations disabled',
  '  --strict-mcp-config                   Only use MCP servers from --mcp-config',
  '  --mcp-config <configs...>             Load MCP servers from JSON files or strings',
  '  --settings <file-or-json>             Path to a settings JSON file or a JSON string',
  '  --disable-slash-commands              Disable all skills',
  '  --no-chrome                           Disable Claude in Chrome integration',
  '  --no-session-persistence              Disable session persistence (only works with --print)',
  '  --session-id <uuid>                   Use a specific session ID for the conversation',
  '  --tools <tools...>                    Specify the list of available tools from the built-in set',
  '  --permission-mode <mode>              Permission mode to use for the session (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")',
  '  --permission-prompts <target>         Who answers permission prompts with --print: "host" or "none"',
  '  --input-format <format>               Input format (only works with --print): "text" (default), or "stream-json"',
  '  --output-format <format>              Output format (only works with --print): "text", "json", or "stream-json"',
  '  --verbose                             Override verbose mode setting from config',
  '  --max-budget-usd <amount>             Maximum dollar amount to spend on API calls (only works with --print)',
  '  --model <model>                       Model for the current session',
  '  --system-prompt <prompt>              System prompt to use for the session',
 ];
 if(state.effortFlag)lines.push('  --effort <level>                      Effort level for the current session (low, medium, high, xhigh, max)');
 const omit=state.helpOmit||[];
 console.log(lines.filter(line=>!omit.some(o=>line.trimStart().startsWith(o)||line.includes(', '+o+' '))).join('\n'));
 process.exit(0);
}
if(args[0]==='auth'){
 if(state.mode==='authMalformed'){console.log('bad');process.exit(1);}
 console.log(JSON.stringify({loggedIn:state.authentication!=='signedOut',authMethod:state.authentication==='subscription'?'claude.ai':state.authentication==='apiKey'?'api_key':'unrecognized',subscriptionType:'max',email:'private@synthetic.invalid',token:'SYNTHETIC_SECRET_NOT_REAL'}));process.exit(state.authentication==='signedOut'?1:0);
}
const cp=require('node:child_process'), crypto=require('node:crypto');
if(args.includes('--effort')){
 const level=args[args.indexOf('--effort')+1], resolved=(args.includes('--model')?args[args.indexOf('--model')+1]:state.model);
 const levels=state.efforts&&Object.hasOwn(state.efforts,resolved)?state.efforts[resolved]:null;
 if(!state.effortFlag){console.error("error: unknown option '--effort'");process.exit(1);}
 if(!levels||!levels.includes(level)){console.error("error: option '--effort <level>' argument '"+level+"' is invalid");process.exit(1);}
}
const emit=(m)=>process.stdout.write(JSON.stringify(m)+'\n');
const flag=(name)=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
if(args.includes('-p')&&flag('--input-format')==='text'){
 // Implementer print session (feature-t30): the whole prompt arrives on stdin, then the frames follow.
 const chunks=[];
 process.stdin.on('data',(c)=>chunks.push(c));
 process.stdin.on('end',()=>{
  const prompt=Buffer.concat(chunks).toString('utf8');
  record({prompt,cwd:process.cwd(),effort:flag('--effort'),env:Object.keys(process.env).sort()});
  const model=flag('--model'), session=flag('--session-id');
  const requested=(flag('--tools')||'').split(',').filter(Boolean);
  const tools=state.implementer==='wrongTools'?['Bash','Read']:requested;
  emit({type:'system',subtype:'init',cwd:process.cwd(),session_id:session,tools,mcp_servers:[],model,permissionMode:flag('--permission-mode'),apiKeySource:'none',claude_code_version:state.version,plugins:[],skills:[]});
  for(let i=0;i<Number(state.implementerChildren||0);i++){
   // Inside the target's session (not detached): the port must reclaim these by identity after the target exits.
   const child=cp.spawn('/bin/sleep',['60'],{stdio:'ignore'});record({child:child.pid,parent:process.pid});
  }
  for(let i=0;i<Number(state.implementerEscaped||0);i++){
   // A descendant that leaves the target's session (own session leader) and outlives the target.
   const grandchild=cp.spawn('/bin/sleep',[String(state.implementerEscapedSeconds||60)],{detached:true,stdio:'ignore'});grandchild.unref();
   record({escaped:grandchild.pid,parent:process.pid});
  }
  if(state.implementer==='hang'){setInterval(()=>{},1000);return;}
  if(state.implementer==='ignoreTerm'){process.on('SIGTERM',()=>{record({ignoredSignal:'SIGTERM',pid:process.pid});});record({ignoringTerm:true,pid:process.pid});setInterval(()=>{},1000);return;}
  if(state.implementer==='crash'){process.exit(1);}
  if(state.implementer==='flood'){
   // One frame larger than the request's output budget, then no exit: the port must stop the target (output-limit).
   emit({type:'assistant',message:{id:'msg_flood',type:'message',role:'assistant',model,content:[{type:'text',text:'x'.repeat(Number(state.implementerFloodBytes||262144))}],stop_reason:'end_turn'},session_id:session});
   setInterval(()=>{},1000);return;
  }
  const count=Number(state.implementerToolCalls||1), delay=Number(state.implementerToolDelayMs||0);
  const pause=()=>new Promise((resolve)=>setTimeout(resolve,delay));
  (async()=>{
   for(let i=0;i<count;i++){
    const file=path.join(process.cwd(),'IMPLEMENTED.md');
    emit({type:'assistant',message:{id:'msg_'+i,type:'message',role:'assistant',model,content:[{type:'tool_use',id:'toolu_'+i,name:'Write',input:{file_path:file,content:'implemented'}}],stop_reason:'tool_use'},session_id:session});
    if(state.implementer!=='wrongTools')fs.writeFileSync(file,'implemented by fixture; prompt bytes '+Buffer.byteLength(prompt)+'\n');
    emit({type:'user',message:{role:'user',content:[{tool_use_id:'toolu_'+i,type:'tool_result',content:'ok'}]},session_id:session});
    if(delay>0)await pause();
   }
   emit({type:'assistant',message:{id:'msg_final',type:'message',role:'assistant',model,content:[{type:'text',text:'SYNTHETIC_IMPLEMENTED'}],stop_reason:'end_turn'},session_id:session});
   const budget=state.implementer==='budget';
   emit({type:'result',subtype:budget?'error_max_budget_usd':'success',is_error:budget,duration_ms:12,num_turns:count+1,result:'SYNTHETIC_IMPLEMENTED',session_id:session,total_cost_usd:state.costUsd,usage:{input_tokens:10,output_tokens:5},modelUsage:{[model]:{inputTokens:10,outputTokens:5,costUSD:state.costUsd}},permission_denials:[]});
   setTimeout(()=>process.exit(budget?1:0),25);
  })();
 });
 return;
}
const input=rl.createInterface({input:process.stdin});
const synthetic=process.env.ANTHROPIC_API_KEY==='SYNTHETIC_ONLY_NOT_REAL';
const session=flag(args.includes('--resume')?'--resume':'--session-id');
const config=JSON.parse(flag('--mcp-config')||'{"mcpServers":{}}');
const widget=flag('--allowedTools')==='mcp__csthink_assistant__submit_widget_candidate';
const tool=widget?'mcp__csthink_assistant__submit_widget_candidate':'mcp__csthink_assistant__read_material';
let child;
async function readMaterial(input){
 const server=config.mcpServers.csthink_assistant;
 if(!server)return {is_error:true,content:'unavailable'};
 if(!child)child=cp.spawn(server.command,server.args,{stdio:['pipe','pipe','ignore']});
 return await new Promise((resolve)=>{
  let b='';const id=crypto.randomUUID();
  const listener=(chunk)=>{b+=chunk;let end;while((end=b.indexOf('\n'))>=0){const line=b.slice(0,end);b=b.slice(end+1);const r=JSON.parse(line);if(r.id===id){child.stdout.off('data',listener);resolve({is_error:r.result.isError===true,content:r.result.content});}}};
  child.stdout.on('data',listener);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:widget?'submit_widget_candidate':'read_material',arguments:input}})+'\n');
 });
}
async function user(m){
 const tools=config.mcpServers.csthink_assistant?[tool]:[];
 emit({type:'system',subtype:'init',model:flag('--model'),permissionMode:'dontAsk',session_id:!synthetic&&state.mode==='wrongSession'?'unowned':session,tools:!synthetic&&state.mode==='unsafeTools'?['Bash']:tools,plugins:[],skills:[]});
 if(process.env.ANTHROPIC_API_KEY==='SYNTHETIC_ONLY_NOT_REAL'){
  const messages=[{role:'user',content:'synthetic fixture'}];
  for(let turn=0;turn<4;turn++){
   const response=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:flag('--model'),tools:tools.map(name=>({name})),messages})});
   const value=await response.json();messages.push({role:'assistant',content:value.content});
   const call=value.content.find(b=>b.type==='tool_use');
   if(!call)break;
   const result=call.name===tool?await readMaterial(call.input):{is_error:true,content:'unavailable'};
   messages.push({role:'user',content:[{type:'tool_result',tool_use_id:call.id,...result}]});
  }
 }else if(state.mode==='tools'||state.mode==='widget'){
  const result=await readMaterial(widget?{package:state.widgetPackage}:{attachmentId:state.attachmentId});record({materialResult:result});
  if(result.is_error){emit({type:'result',session_id:session,subtype:'error_during_execution',is_error:true,errors:['permission denied']});return;}
 }
 if(!synthetic&&state.mode==='apiError'){
  emit({type:'assistant',session_id:session,isApiErrorMessage:true,error:state.errorCode,message:{content:[{type:'text',text:state.errorText}]}});
  emit({type:'result',session_id:session,subtype:'error_during_execution',is_error:true,errors:[]});return;
 }
 const hasImage=Array.isArray(m.message.content)&&m.message.content.some(b=>b.type==='image');
 const answer=!synthetic&&hasImage?'红色': 'SYNTHETIC_RESPONSE';
 emit({type:'stream_event',session_id:session,event:{type:'content_block_delta',delta:{type:'text_delta',text:answer}}});
 if(!synthetic&&state.mode==='refusal'){
  emit({type:'assistant',session_id:session,isApiErrorMessage:true,error:'invalid_request',message:{stop_reason:'refusal',stop_details:{type:'refusal',category:'reasoning_extraction'},content:[{type:'text',text:'SYNTHETIC_PRIVATE_DIAGNOSTIC'}]}});
  emit({type:'result',session_id:session,subtype:'error_during_execution',is_error:true,errors:['SYNTHETIC_PRIVATE_DIAGNOSTIC reasoning_extraction']});return;
 }
 if(!synthetic&&state.mode==='slow')return;
 if(!synthetic&&state.mode==='crash'){process.exit(1);return;}
 emit({type:'result',session_id:session,subtype:'success',is_error:false});
}
input.on('line',(line)=>{
 const m=JSON.parse(line);record(m);
 if(state.mode==='hang')return;
 if(state.mode==='malformed'){process.stdout.write('invalid-json\n');return;}
 if(state.mode==='oversized'){process.stdout.write('x'.repeat(4*1024*1024+1));return;}
 if(m.type==='user'){void user(m).catch(()=>process.exit(1));return;}
 if(m.type!=='control_request')return;
 const effortOf=(resolved)=>state.efforts&&Object.hasOwn(state.efforts,resolved)?{supportsEffort:true,supportedEffortLevels:state.efforts[resolved]}:{};
 const response={models:[{value:'default',resolvedModel:state.model,...effortOf(state.model)},{value:'sonnet',resolvedModel:'claude-other',...effortOf('claude-other')}],account:{apiProvider:'firstParty',tokenSource:state.authentication==='subscription'?'keychain':'none',apiKeySource:state.authentication==='apiKey'?'ANTHROPIC_API_KEY':'none'},session_state:'idle',commands:[]};
 process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response}})+'\n');
});
input.on('close',()=>{child?.stdin.end();setTimeout(()=>process.exit(0),25);});
`,
  );
  chmodSync(binary, 0o755);
  return { root, bin, binary, calls, update };
}
