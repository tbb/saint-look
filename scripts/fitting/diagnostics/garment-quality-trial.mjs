// Temporary release qualification: the actual provider, one attempt per stage.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const sharp=createRequire(new URL('../../../backend/package.json',import.meta.url))('sharp');
import {exchange} from '../../../backend/src/providers.mjs';
import {createIllustrationProvider} from '../../../backend/src/illustration-provider.mjs';
import {compareTopProportions,measureTopProportions} from '../../../backend/src/illustration-proportions.mjs';
import {checkGarmentLayout} from '../../../backend/src/illustration-layout.mjs';
import {inspectPhotoroomAccount} from '../../deploy/photoroom-account.mjs';
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex');
if(key.length!==32)throw new Error('Missing diagnostic key');
const raw=readFileSync('scripts/fitting/diagnostics/input.enc');
const decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));
const bundle=JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]));
const input=bundle.items[process.env.TRIAL_ITEM]||(process.env.TRIAL_ITEM==='polo'?{source:readFileSync('scripts/fitting/fixtures/polo.jpg').toString('base64')}:null);
if(!input)throw new Error('Unknown item');
const state={sourceHash:null,events:[],variants:{production:{}}};
mkdirSync('garment-quality-output',{recursive:true});
function save(){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const data=Buffer.concat([cipher.update(JSON.stringify(state)),cipher.final()]);
 writeFileSync('garment-quality-output/result.enc',Buffer.concat([iv,cipher.getAuthTag(),data]));
 writeFileSync('garment-quality-output/summary.json',JSON.stringify({sourceHash:state.sourceHash,events:state.events,checks:state.checks},null,2));
}
async function call(stage,fn){
 if(state.events.some(e=>e.stage===stage))throw new Error('Duplicate stage');
 const record={stage,status:'started'};state.events.push(record);save();
 try{const value=await fn();record.status='completed';save();return value;}
 catch(error){record.status='failed-or-unknown';record.code=error.code||error.name;save();throw error;}
}
try{
 const quota=await inspectPhotoroomAccount(process.env);console.log(JSON.stringify(quota));
 if(quota.availableImages<2)throw new Error('Insufficient production cutouts');
 const networkFetch=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  const response=await networkFetch(url,options);
  if(String(url).endsWith('/v1beta/interactions')&&response.ok){
   const answer=await response.clone().json();
   state.generationMetadata={status:answer.status,usage:answer.usage,steps:answer.steps?.map(step=>({type:step.type,content:step.content?.map(c=>({type:c.type})),summary:step.summary?.map(c=>({type:c.type}))}))};save();
  }
  if(!response.ok)console.log(JSON.stringify({provider:new URL(url).hostname,status:response.status}));
  if(String(url).endsWith('/v1/segment') && options?.body?.get?.('image_file')?.name==='finalization.png' && response.ok){
   state.variants.production.cutout=Buffer.from(await response.clone().arrayBuffer()).toString('base64');save();
  }
  return response;
 };
 const provider=createIllustrationProvider(process.env),signal=new AbortController().signal;
 const source=await sharp(Buffer.from(input.source,'base64')).png().toBuffer();
 state.sourceHash=createHash('sha256').update(source).digest('hex');state.original=source.toString('base64');save();
 const prepared=input.prepared?Buffer.from(input.prepared,'base64'):await call('preparation',()=>provider.prepare(source,signal));
 state.prepared=prepared.toString('base64');save();
 const photos=[{source,prepared,role:'front'}];
 const features=input.features||await call('attributes',()=>provider.attributes(photos,signal));
 state.features=features;state.proportions=await measureTopProportions(prepared,features);save();
 if(input.receipt){
  const answer=JSON.parse(await exchange('https://generativelanguage.googleapis.com/v1beta/interactions/'+encodeURIComponent(input.receipt),{headers:{'x-goog-api-key':process.env.GEMINI_API_KEY}},signal,120000,14*1024*1024));
  state.recovery=answer;save();console.log(JSON.stringify({status:answer.status,model:answer.model,idMatches:answer.id===input.receipt,error:answer.error?.code,steps:answer.steps?.map(s=>({type:s.type,content:s.content?.map(c=>({type:c.type,hasData:!!c.data}))}))}));
 }
 const generated=input.correctionReceipt?await call('pose-correction',async()=>{
  const payload={model:'gemini-3-pro-image',store:true,previous_interaction_id:input.correctionReceipt,
   input:'The last result still has folded sleeves over the stomach. Correct ONLY that pose: straighten BOTH existing sleeves downward and outward, with both cuffs completely outside the body silhouette and visible air gaps. Replace the old folded sleeves, do not add extra arms. Keep exactly two sleeves, the same broad torso, the same gold cross and worn ink texture, and the skull on its original sleeve. Lower the hood behind the neckline. Preserve all other design details. One garment only, white background.',
   generation_config:{max_output_tokens:2048},response_format:{type:'image',mime_type:'image/jpeg',aspect_ratio:'1:1',image_size:'1K'}};
  const answer=JSON.parse(await exchange('https://generativelanguage.googleapis.com/v1beta/interactions',{method:'POST',headers:{'x-goog-api-key':process.env.GEMINI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(payload)},signal,120000,14*1024*1024));
  state.receipt=answer.id;save();if(answer.status!=='completed')throw new Error('Correction incomplete');
  const images=answer.steps?.flatMap(s=>s.type==='model_output'?s.content||[]:[]).filter(c=>c.type==='image'&&c.data);
  if(images?.length!==1)throw new Error('Ambiguous correction output');
  return {png:await sharp(Buffer.from(images[0].data,'base64')).png().toBuffer()};
 }):await call(input.receipt?'recovery':'generation',()=>provider.generate(photos,features,signal,id=>{state.receipt=id;save();},input.receipt));
 state.variants.production.generated=generated.png.toString('base64');save();
 const result=await call('finalization',()=>provider.prepare(generated.png,signal,'finalization',features));
 state.variants.production.registered=result.toString('base64');save();
 state.checks={geometry:await checkGarmentLayout(result,features),proportions:await compareTopProportions(prepared,result,features)};save();
 if(state.checks.proportions.measurable&&!state.checks.proportions.valid)throw Object.assign(new Error(),{code:'illustration_proportions_changed'});
 state.checks.fidelity=await call('fidelity',()=>provider.fidelity(source,result,signal));save();
 console.log(JSON.stringify({checks:state.checks}));
}catch(error){state.error=error.code||error.name;save();console.error('Qualification stopped: '+state.error);process.exitCode=1;}
