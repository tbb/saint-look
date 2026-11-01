// Manual diagnostic only: encrypted user inputs/results, no automatic paid retry.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const sharp=createRequire(new URL('../../../backend/package.json',import.meta.url))('sharp');
import {createIllustrationProvider} from '../../../backend/src/illustration-provider.mjs';
import {createIllustrationProvider as baselineProvider} from '../../../backend/src/trial-baseline-provider.mjs';
import {exchange} from '../../../backend/src/providers.mjs';
import {generationInstructions,generationPoseGuide,projectGenerationCanvas} from '../../../backend/src/illustration-generation-frame.mjs';
import {checkGarmentLayout,registerGarmentLayout} from '../../../backend/src/illustration-layout.mjs';
import {inspectPhotoroomAccount} from '../../deploy/photoroom-account.mjs';

const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex');
if(key.length!==32)throw new Error('Missing diagnostic encryption key');
const raw=readFileSync('scripts/fitting/diagnostics/input.enc');
const decipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));
decipher.setAuthTag(raw.subarray(12,28));
const input=JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]));
const state={sourceHash:null,events:[],variants:{}};
mkdirSync('garment-quality-output',{recursive:true});
function save(){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 const data=Buffer.concat([cipher.update(JSON.stringify(state)),cipher.final()]);
 writeFileSync('garment-quality-output/result.enc',Buffer.concat([iv,cipher.getAuthTag(),data]));
 writeFileSync('garment-quality-output/summary.json',JSON.stringify({sourceHash:state.sourceHash,events:state.events},null,2));
}
async function call(stage,fn){
 if(state.events.some(e=>e.stage===stage))throw new Error('Duplicate paid stage');
 const record={stage,status:'started'};state.events.push(record);save();
 try{const value=await fn();record.status='completed';save();return value;}
 catch(error){record.status='failed-or-unknown';record.code=error.code||error.name;save();throw error;}
}
const png=await sharp(Buffer.from(input.source,'base64')).png().toBuffer();
state.sourceHash=createHash('sha256').update(png).digest('hex');
state.original=png.toString('base64');save();
const provider=createIllustrationProvider(process.env),baseline=baselineProvider(process.env);
try{
 const quota=await inspectPhotoroomAccount(process.env);console.log(JSON.stringify(quota));
 if(quota.availableImages<3)throw new Error('Need three production cutouts for paired diagnostic');
 const prepared=await call('source-cutout',()=>provider.prepare(png,new AbortController().signal));
 state.prepared=prepared.toString('base64');save();
 const photos=[{source:png,prepared,role:'front'}];
 const features=await call('attributes',()=>provider.attributes(photos,new AbortController().signal));
 state.features=features;save();console.log(JSON.stringify({stage:'features',type:features.type,traits:features.traits}));
 for(const variant of ['baseline','pose-frame']){
  let generated;
  if(variant==='baseline')generated=(await call(variant+'-generation',()=>baseline.generate(photos,features,new AbortController().signal,id=>{state.baselineReceipt=id;save();}))).png;
  else{
   const payload={model:'gemini-3-pro-image',store:true,generation_config:{max_output_tokens:2048},
    input:[{type:'image',mime_type:'image/png',data:png.toString('base64')},
      {type:'image',mime_type:'image/png',data:prepared.toString('base64')},
      {type:'image',mime_type:'image/png',data:(await generationPoseGuide(features)).toString('base64')},
      {type:'text',text:generationInstructions(features)}],
    response_format:{type:'image',mime_type:'image/jpeg',aspect_ratio:'1:1',image_size:'1K'}};
   const result=await call(variant+'-generation',async()=>JSON.parse(await exchange('https://generativelanguage.googleapis.com/v1beta/interactions',
    {method:'POST',headers:{'x-goog-api-key':process.env.GEMINI_API_KEY,'Content-Type':'application/json'},body:JSON.stringify(payload)},new AbortController().signal,120000,14*1024*1024)));
   state.candidateReceipt=result.id;save();
   if(result.model!=='gemini-3-pro-image'||result.status!=='completed')throw new Error('Generation incomplete; no retry');
   const image=result.steps?.flatMap(s=>s.type==='model_output'?s.content||[]:[]).find(c=>c.type==='image')?.data;
   if(!image)throw new Error('No image returned; no retry');
   generated=await sharp(Buffer.from(image,'base64')).png().toBuffer();
  }
  state.variants[variant]={generated:generated.toString('base64')};save();
  const cutout=await call(variant+'-cutout',()=>provider.prepare(generated,new AbortController().signal));
  state.variants[variant].cutout=cutout.toString('base64');save();
  const placed=variant==='pose-frame'?await projectGenerationCanvas(cutout,features):cutout;
  state.variants[variant].placed=placed.toString('base64');
  state.variants[variant].geometry=await checkGarmentLayout(placed,features);
  try{state.variants[variant].registered=(await registerGarmentLayout(placed,features)).toString('base64');}
  catch(error){state.variants[variant].registrationError=error.code||error.name;}
  save();console.log(JSON.stringify({variant,geometry:state.variants[variant].geometry,registrationError:state.variants[variant].registrationError}));
 }
}catch(error){console.error('Diagnostic stopped; encrypted evidence saved. '+(error.code||error.name));process.exitCode=1;}
