import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { options, errors, recipe } from './contract.mjs';
const path='examples/source-values/contract.mjs';
const explanation=readFileSync(new URL('./contract.mjs',import.meta.url),'utf8').split('\n').find(line=>line.startsWith('// Operator explanation:')).replace('// Operator explanation: ','');
const start=performance.now();
for(let i=0;i<100;i++) options.parse({});
const elapsed=performance.now()-start;
console.log(JSON.stringify([
 {key:'timeout',kind:'default',title:'Default timeout',content:`timeout defaults to ${options.parse({}).timeout}`,spellings:['--timeout'],source:{path,line_start:2,line_end:2}},
 {key:'unsupported',kind:'error',title:'Unsupported schema',content:errors.unsupported,spellings:['unsupported'],source:{path,line_start:3,line_end:3}},
 {key:'options',kind:'file-shape',title:'Options shape',content:JSON.stringify(Object.fromEntries(Object.keys(options.shape).map(key=>[key,options.shape[key].removeDefault()._def.typeName]))),spellings:['options'],source:{path,line_start:2,line_end:2}},
 {key:'stale',kind:'explanation',title:'Stale revision refusal',content:explanation+' '+recipe,spellings:['expected_revision'],source:{path,line_start:4,line_end:5}},
 {key:'parse-ms',kind:'measurement',title:'100 parses',content:`100 parses: ${elapsed} ms`,spellings:['parse-ms'],source:{path:'examples/source-values/publish.mjs',measurement:{command:'node examples/source-values/publish.mjs',parameters:{iterations:100},tool_versions:{node:process.version},result:{elapsed_ms:elapsed}}}},
]));
