import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Fixed local worker: the input is only one of four registered candidate IDs, never a URL, credential, model or source path.
const worker = String.raw`
import fs from 'node:fs';
import { registerHooks } from 'node:module';
const [moduleUrl, candidate] = process.argv.slice(1);
const candidates = { '90-4096':[90000,4096], '90-8192':[90000,8192], '120-4096':[120000,4096], '120-8192':[120000,8192] };
if (!Object.hasOwn(candidates,candidate)) process.exit(2);
if(moduleUrl.endsWith('.ts')) {
 const {default:ts}=await import('typescript');
 registerHooks({resolve(s,c,n){if(s.startsWith('.')&&s.endsWith('.js')&&c.parentURL?.startsWith('file:')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(fs.existsSync(u))return{url:u.href,shortCircuit:true};}return n(s,c);},load(u,c,n){if(u.startsWith('file:')&&u.endsWith('.ts')&&!u.includes('/node_modules/'))return{format:'module',source:ts.transpileModule(fs.readFileSync(new URL(u),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText,shortCircuit:true};return n(u,c);}});
}
const { collectReadonlyRelayResponse, inspectReadonlyRelayExecutionBudgetFixture } = await import(moduleUrl);
const {getReadonlyRelayExecutionBudget}=await import(new URL('./readonly-relay-budget-policy'+(moduleUrl.endsWith('.ts')?'.ts':'.js'),moduleUrl));
const budget=getReadonlyRelayExecutionBudget({enabled:false,policyVersion:'readonly-relay-codex-v3',codexPath:'/synthetic/codex',codexSha256:'a'.repeat(64),model:'gpt-6.1-sol',authMode:'chatgpt',timeoutMs:125000,maxResponseBytes:16384});
const credential={accessToken:'SYNTHETIC_EXECUTION_BUDGET_TOKEN',accountId:'SYNTHETIC_EXECUTION_BUDGET_ACCOUNT'};
const baseline=process.memoryUsage(); let peakHeap=baseline.heapUsed,peakExternal=baseline.external;
const sample=()=>{const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakExternal=Math.max(peakExternal,m.external);};
const started=performance.now(), cpu=process.cpuUsage();
const event='data: '+JSON.stringify({type:'synthetic.capacity.delta',text:'한글🙂',inert:'x'.repeat(96)})+'\n\n';
const body=Buffer.from(event.repeat(6144)); const [workTimeoutMs,frames]=candidates[candidate];
let framingPassed=true,framingFailure=null;
try {inspectReadonlyRelayExecutionBudgetFixture(body,credential,frames);}catch(error){framingPassed=false;framingFailure=error.code;}
let selectedCollectorPassed=false;
if(candidate==='120-8192'){
 let offset=0;const stream=new ReadableStream({pull(controller){if(offset===body.length){controller.close();return;}const end=Math.min(body.length,offset+7168);controller.enqueue(body.subarray(offset,end));offset=end;sample();}});
 const value=await collectReadonlyRelayResponse(new Response(stream),new AbortController().signal,credential,{executionBudget:budget,observeDiagnostic:sample});
 selectedCollectorPassed=value.body.equals(body);
}
sample();const cpuUsed=process.cpuUsage(cpu),elapsedMs=performance.now()-started;
const peakRssBytes=process.resourceUsage().maxRSS*1024;
const metrics={elapsedMs,cpuMs:(cpuUsed.user+cpuUsed.system)/1000,baselineRssBytes:baseline.rss,peakRssBytes,rssDeltaBytes:Math.max(0,peakRssBytes-baseline.rss),sampledHeapDeltaBytes:Math.max(0,peakHeap-baseline.heapUsed),sampledExternalDeltaBytes:Math.max(0,peakExternal-baseline.external)};
console.log(JSON.stringify({candidate,workTimeoutMs,frames,registeredFixture:{frames:6144,logicalEofMs:110000,bodyBytes:body.length,chunkBytes:7168},logicalSchedulePassed:110000<=workTimeoutMs,framingPassed,framingFailure,selectedCollectorPassed,metrics,resourcePassed:elapsedMs<=5000&&metrics.cpuMs<=4000&&metrics.rssDeltaBytes<=96*1024*1024}));
`;
interface Row { candidate: string; workTimeoutMs: number; frames: number; logicalSchedulePassed: boolean; framingPassed: boolean;
  framingFailure: string | null; selectedCollectorPassed: boolean; resourcePassed: boolean; metrics: { elapsedMs: number; cpuMs: number; rssDeltaBytes: number } }
const runCandidate = (candidate: string): Promise<Row> => new Promise((resolve, reject) => {
  const moduleUrl = new URL('../src/policy/readonly-relay-protocol' + (import.meta.url.endsWith('.ts') ? '.ts' : '.js'), import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', worker, moduleUrl, candidate], { cwd: process.cwd(), env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = []; let bytes = 0, error = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16384) child.kill('SIGKILL'); else chunks.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { if (error.length < 16384) error += String(chunk); });
  child.once('error', failure => { clearTimeout(timer); reject(failure); });
  child.once('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Fixed offline capacity worker failed: ' + error));
    else { try { resolve(JSON.parse(Buffer.concat(chunks).toString()) as Row); } catch (failure) { reject(failure); } } });
});

test('execution budget fresh-worker matrix selects the smallest fixed candidate satisfying logical schedule, actual framing and local resource gates', { timeout: 60000 }, async () => {
  const rows: Row[] = [];
  for (const candidate of ['90-4096', '90-8192', '120-4096', '120-8192']) rows.push(await runCandidate(candidate));
  const selected = rows.filter(row => row.logicalSchedulePassed && row.framingPassed && row.resourcePassed);
  assert.deepEqual(selected.map(row => row.candidate), ['120-8192']); assert.equal(selected[0]!.selectedCollectorPassed, true);
  assert.deepEqual(rows.filter(row => row.frames === 4096).map(row => row.framingFailure), ['READONLY_RELAY_FRAME_LIMIT', 'READONLY_RELAY_FRAME_LIMIT']);
  assert.equal(rows.every(row => row.resourcePassed), true);
  console.log(JSON.stringify({ kind: 'readonly-relay-execution-budget-capacity-v1', source: fileURLToPath(import.meta.url),
    selection: '120-8192', basis: 'registered logical EOF110000ms/6144frames; exact schedule feasibility plus shared real framing validator; not a prediction of provider completion time',
    measurement: 'fresh Node per candidate; module loading excluded from elapsed/CPU/baseline; fixture creation included; no forced GC; OS maxRSS includes startup, delta subtracts post-import RSS; heap/external sampled, not exact peaks',
    gates: { elapsedMs: 5000, cpuMs: 4000, rssDeltaBytes: 96 * 1024 * 1024 }, rows }));
});
