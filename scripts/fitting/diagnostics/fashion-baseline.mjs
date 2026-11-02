// Diagnostic only: each specialized mode once per source, no retries/publication.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {exchange} from '../../../backend/src/providers.mjs';
import {registerGarmentLayout,checkGarmentLayout} from '../../../backend/src/illustration-layout.mjs';
import {measureTopProportions,compareTopProportions} from '../../../backend/src/illustration-proportions.mjs';
import {fidelityRequest,fidelityAnswer} from '../../../backend/src/illustration-fidelity.mjs';
import {inspectPhotoroomAccount} from '../../deploy/photoroom-account.mjs';
const sharp=createRequire(new URL('../../../backend/package.json',import.meta.url))('sharp');
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex');
const raw=readFileSync('scripts/fitting/diagnostics/input.enc'),d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));
const bundle=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]));
const state={variants:{},events:[]},signal=new AbortController().signal;
mkdirSync('garment-quality-output',{recursive:true});
function save(){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),out=Buffer.concat([c.update(JSON.stringify(state)),c.final()]);writeFileSync('garment-quality-output/result.enc',Buffer.concat([iv,c.getAuthTag(),out]));}
async function call(name,fn){if(state.events.some(e=>e.name===name))throw Error('Duplicate call');const e={name,status:'started'};state.events.push(e);save();try{const v=await fn();e.status='completed';save();return v;}catch(error){e.status='failed-or-unknown';e.code=error.code||error.name;save();throw error;}}
const quota=await inspectPhotoroomAccount(process.env);if(quota.availableImages<24)throw Error('Insufficient diagnostic quota');
for(const name of ['hoodie','tee'])for(const mode of ['ghostMannequin','flatLay']){
 const label=name+'-'+mode,input=bundle.items[name],v=state.variants[label]={};
 try{
  const source=await sharp(Buffer.from(input.source,'base64')).png().toBuffer(),features=input.features;
  const body=new FormData();body.set('imageFile',new Blob([source],{type:'image/png'}),'garment.png');body.set(mode+'.mode','ai.auto');body.set(mode+'.size','SQUARE_HD');
  // Baseline has no extra prompt, so model defaults can be compared fairly.
  const bytes=await call(label+':generation',()=>exchange('https://image-api.photoroom.com/v2/edit',{method:'POST',headers:{'x-api-key':process.env.PHOTOROOM_API_KEY},body},signal,120000,14*1024*1024));
  const generated=await sharp(bytes,{limitInputPixels:16000000}).png().toBuffer();v.generated=generated.toString('base64');save();
  const cutoutBody=new FormData();cutoutBody.set('image_file',new Blob([generated],{type:'image/png'}),'finalization.png');
  for(const[k,value]of Object.entries({channels:'rgba',size:'full',crop:'false',format:'png',despill:'false'}))cutoutBody.set(k,value);
  const cutout=await call(label+':cutout',()=>exchange('https://sdk.photoroom.com/v1/segment',{method:'POST',headers:{'x-api-key':process.env.PHOTOROOM_API_KEY},body:cutoutBody},signal,120000,14*1024*1024));
  v.cutout=cutout.toString('base64');save();
  v.proportions=await compareTopProportions(Buffer.from(input.prepared,'base64'),cutout,features);
  try{const registered=await registerGarmentLayout(cutout,features,await measureTopProportions(cutout,features));v.registered=registered.toString('base64');v.geometry=await checkGarmentLayout(registered,features);}catch(error){v.geometry={valid:false,error:error.code||error.name};}
  save();
  const request=await fidelityRequest(source,cutout);
  const answer=await call(label+':fidelity',()=>exchange('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.TYPESAFE_API_KEY}`,'TypeSafe-Danger-Zone-Images':'true'},body:JSON.stringify(request)},signal,120000,128*1024));
  v.fidelity=fidelityAnswer(JSON.parse(answer),request);save();
  console.log(JSON.stringify({label,geometry:v.geometry,proportions:v.proportions,fidelity:v.fidelity}));
 }catch(error){v.error=error.code||error.name;save();console.log(JSON.stringify({label,error:v.error}));}
}
