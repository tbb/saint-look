// Compare identical garment candidates before and after placement resampling.
import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{createCipheriv,createDecipheriv,randomBytes}from'node:crypto';
import{exchange}from'../../../backend/src/providers.mjs';import{fidelityRequest,fidelityAnswer}from'../../../backend/src/illustration-fidelity.mjs';
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex'),raw=readFileSync('scripts/fitting/diagnostics/input.enc'),d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));const bundle=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]));
const state={variants:{},events:[]};mkdirSync('garment-quality-output',{recursive:true});
function save(){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),out=Buffer.concat([c.update(JSON.stringify(state)),c.final()]);writeFileSync('garment-quality-output/result.enc',Buffer.concat([iv,c.getAuthTag(),out]));}
for(const input of bundle.resolutionProbes){const v=state.variants[input.name]={},e={name:input.name,status:'started'};state.events.push(e);save();try{
 const request=await fidelityRequest(Buffer.from(input.source,'base64'),Buffer.from(input.candidate,'base64'));
 const answer=await exchange('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.TYPESAFE_API_KEY}`,'TypeSafe-Danger-Zone-Images':'true'},body:JSON.stringify(request)},new AbortController().signal,120000,128*1024);
 v.fidelity=fidelityAnswer(JSON.parse(answer),request);e.status='completed';save();console.log(JSON.stringify({name:input.name,...v.fidelity}));
 }catch(error){v.error=error.code||error.name;e.status='failed-or-unknown';save();console.log(JSON.stringify({name:input.name,error:v.error}));}}
