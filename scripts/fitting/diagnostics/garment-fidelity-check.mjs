// Read-only inspection of durable Gemini receipts. No generation POST.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {exchange} from '../../../backend/src/providers.mjs';
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex'),raw=readFileSync('scripts/fitting/diagnostics/input.enc');
const d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));
const bundle=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]));
const state={variants:{},events:[]};mkdirSync('garment-quality-output',{recursive:true});
function save(){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(JSON.stringify(state)),c.final()]);writeFileSync('garment-quality-output/result.enc',Buffer.concat([iv,c.getAuthTag(),data]));}
for(const [name,receipt]of Object.entries(bundle.receipts)){
 const answer=JSON.parse(await exchange('https://generativelanguage.googleapis.com/v1beta/interactions/'+encodeURIComponent(receipt),{headers:{'x-goog-api-key':process.env.GEMINI_API_KEY}},new AbortController().signal,120000,24*1024*1024));
 const outputs=answer.steps?.flatMap(s=>s.type==='model_output'?s.content||[]:[]).filter(c=>c.type==='image')||[];
 outputs.forEach((value,index)=>{state.variants[name+'-'+index]={generated:value.data};});
 state.events.push({name,status:answer.status,count:outputs.length,usage:answer.usage});save();
 console.log(JSON.stringify(state.events.at(-1)));
}
