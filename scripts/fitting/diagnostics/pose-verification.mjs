// Independent structural check against known bad/good cached candidates.
import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{createCipheriv,createDecipheriv,randomBytes}from'node:crypto';
import{exchange}from'../../../backend/src/providers.mjs';
import{structureRequest,structureAnswer}from'../../../backend/src/illustration-structure.mjs';
if(process.env.GITHUB_RUN_ATTEMPT!=='1'||process.env.GITHUB_REF!=='refs/heads/codex/garment-quality-trial')throw Error('Invalid context');
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex'),raw=readFileSync('scripts/fitting/diagnostics/input.enc'),d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));const b=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]));
const state={variants:{},events:[]};mkdirSync('garment-quality-output',{recursive:true});
function save(){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),out=Buffer.concat([c.update(JSON.stringify(state)),c.final()]);writeFileSync('garment-quality-output/result.enc',Buffer.concat([iv,c.getAuthTag(),out]));}
const schema={type:'object',properties:{sleeve_count:{type:'integer'},folded_sleeves:{type:'boolean'},duplicated_parts:{type:'boolean'},confidence:{type:'number'},evidence:{type:'string'}},required:['sleeve_count','folded_sleeves','duplicated_parts','confidence','evidence']};
for(const input of b.resolutionProbes){const v=state.variants[input.name]={status:'started'},e={name:input.name,status:'started'};state.events.push(e);save();try{
 const request=await structureRequest(Buffer.from(input.candidate,'base64'));
 const answer=JSON.parse(await exchange('https://generativelanguage.googleapis.com/v1beta/interactions',{method:'POST',headers:{'x-goog-api-key':process.env.GEMINI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(request)},new AbortController().signal,120000,256*1024));
 v.receipt=answer.id;save();if(answer.status!=='completed')throw Error('Incomplete verification');
 v.verification=structureAnswer(answer);v.status='completed';e.status='completed';save();console.log(JSON.stringify({name:input.name,...v.verification}));
 }catch(error){v.error=error.code||error.message;v.status='failed-or-unknown';e.status=v.status;save();console.log(JSON.stringify({name:input.name,error:v.error}));}}
