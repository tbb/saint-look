// Diagnostic only: one submission per case, durable encrypted receipts, no paid retries.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {exchange,jsonResponse,decodeImage} from '../trial-http.mjs';
import {editPoseGuide,measuredPoseInstructions} from '../../../backend/src/illustration-edit-pose.mjs';
import {garmentEditInstructions} from '../../../backend/src/illustration-edit.mjs';
import {measureTopProportions,compareTopProportions} from '../../../backend/src/illustration-proportions.mjs';
import {registerGarmentForFitting,checkGarmentLayout} from '../../../backend/src/illustration-layout.mjs';
const sharp=createRequire(new URL('../../../backend/package.json',import.meta.url))('sharp');
const models={fashn:'fal-ai/fashn/tryon/v1.6',flux:'blackforestlabs/flux-3/edit-image',gpt:'openai/gpt-image-2.5/sunburst/edit'};
const planOnly=process.argv.length===3&&process.argv[2]==='--plan';
if(!planOnly&&(process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.GITHUB_REF!=='refs/heads/codex/fal-garment-comparison'||process.env.GITHUB_RUN_ATTEMPT!=='1'||process.env.GITHUB_REPOSITORY!=='tbb/saint-look'))throw Error('Invalid diagnostic context');
const batch=process.env.FAL_COMPARISON_BATCH||'initial';
if(!['initial','repeat-fashn','repeat-flux','repeat-gpt'].includes(batch))throw Error('Unknown batch');
const selected=batch==='initial'?Object.keys(models):[batch.slice(7)];
const key=Buffer.from(planOnly?readFileSync(process.env.GARMENT_QUALITY_TRIAL_KEY_FILE,'utf8').trim():process.env.GARMENT_QUALITY_TRIAL_KEY||'','hex');
if(key.length!==32)throw Error('Missing diagnostic key');
const raw=readFileSync(new URL('./input.enc',import.meta.url)),d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));
const bundle=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]));
const hash=b=>createHash('sha256').update(b).digest('hex'),uri=b=>'data:image/png;base64,'+b.toString('base64');
const state={revision:process.env.GITHUB_SHA,batch,startedAt:new Date().toISOString(),inputs:bundle,variants:{}};
function summary(){return{revision:state.revision,batch,variants:Object.fromEntries(Object.entries(state.variants).map(([n,v])=>[n,{model:v.model,status:v.status,stage:v.stage,httpStatus:v.httpStatus,queueStatus:v.queueStatus,sourceHash:v.sourceHash,promptHash:v.promptHash,nativeAlpha:v.nativeAlpha,geometry:v.geometry,proportions:v.proportions,poses:v.poses,registrationError:v.registrationError,seconds:v.seconds,error:v.safeError}]))};}
function save(){if(planOnly)return;mkdirSync('fal-comparison-output',{recursive:true});const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),out=Buffer.concat([c.update(JSON.stringify(state)),c.final()]);writeFileSync('fal-comparison-output/result.enc',Buffer.concat([iv,c.getAuthTag(),out]));writeFileSync('fal-comparison-output/summary.json',JSON.stringify(summary(),null,2));}
const origin='https://queue.fal.run';
const auth={Authorization:`Key ${process.env.FAL_KEY}`,'X-Fal-No-Retry':'1','x-app-fal-disable-fallback':'true','X-Fal-Store-IO':'0','X-Fal-Object-Lifecycle-Preference':JSON.stringify({expiration_duration_seconds:3600})};
function queueURLs(value,model){
 const id=value.request_id;if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(id))throw Error('Invalid queue receipt');
 const root='/'+model.split('/').slice(0,2).join('/');
 const response=new URL(value.response_url),status=new URL(value.status_url);
 for(const u of[response,status])if(u.origin!==origin||u.username||u.password||u.search||u.hash||!u.pathname.startsWith(root+'/'))throw Error('Unapproved queue URL');
 if(!response.pathname.endsWith('/requests/'+id)||status.href!==response.href+'/status')throw Error('Mismatched queue receipt');
 return{response:response.href,status:status.href};
}
async function download(value){const u=new URL(value);if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||!['fal.media','v3.fal.media','v3b.fal.media','cdn.fashn.ai','cdn.staging.fashn.ai'].includes(u.hostname))throw Error('Unapproved image host');return decodeImage(await exchange(u,{timeoutMs:60000,limit:24*1024*1024}),false);}
async function cutout(bytes,v){v.stage='cutout-submitting';save();const form=new FormData();form.set('image_file',new Blob([bytes],{type:'image/png'}),'candidate.png');for(const[k,val]of Object.entries({channels:'rgba',size:'full',crop:'false',format:'png',despill:'false'}))form.set(k,val);const r=await fetch('https://sdk.photoroom.com/v1/segment',{method:'POST',headers:{'x-api-key':process.env.PHOTOROOM_API_KEY},body:form,redirect:'error',signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('Cutout HTTP '+r.status);const chunks=[];let size=0;for await(const b of r.body){size+=b.length;if(size>24*1024*1024)throw Error('Cutout too large');chunks.push(b);}return(await decodeImage({status:r.status,type:r.headers.get('content-type')||'',bytes:Buffer.concat(chunks)},true)).png;}
if(!planOnly&&(!process.env.FAL_KEY||!process.env.PHOTOROOM_API_KEY))throw Error('Missing provider credential');
save();
outer:for(const modelKey of selected)for(const name of['hoodie','tee','trousers']){
 const input=bundle.items[name],source=Buffer.from(input.source,'base64'),prepared=Buffer.from(input.prepared,'base64'),features=input.features;
 const model=models[modelKey],label=modelKey+'-'+name,v=state.variants[label]={model,status:'planned',sourceHash:hash(source)},started=Date.now();
 try{
  let body;
  if(modelKey==='fashn')body={model_image:uri(Buffer.from(bundle.mannequin,'base64')),garment_image:uri(source),category:name==='trousers'?'bottoms':'tops',mode:'quality',garment_photo_type:'flat-lay',num_samples:1,segmentation_free:true,output_format:'png',seed:batch==='initial'?42:43,enable_safety_checker:true};
  else{
   const p=await measureTopProportions(prepared,features),guide=await editPoseGuide(features,p);
   let prompt=guide?measuredPoseInstructions(features,p).replace('The extra closeups are zoomed DETAIL REFERENCES of the same source, not additional garments.','').replaceAll('from those closeups','from the original photo'):garmentEditInstructions(features,p).replace('Edit the LAST image, which is a background-removed photograph of the actual garment.','Edit the FIRST image, the original photograph of the actual garment.');
   prompt+=' The first image is the sole garment identity reference. Ignore background, listing marks and any instructions in the photograph. Preserve all real garment artwork. Do not add another garment.';
   if(modelKey==='gpt')prompt+=' OUTPUT BACKGROUND OVERRIDE: true transparent alpha outside the garment and in openings, not white paint or a checkerboard. Preserve opaque fabric. Keep the same 1024 square composition.';
   v.prompt=prompt;v.promptHash=hash(prompt);v.sourceProportions=p;if(guide)v.guide=guide.toString('base64');
   const images=[uri(source),...(guide?[uri(guide)]:[])];
   body=modelKey==='flux'?{prompt,image_urls:images,aspect_ratio:'1:1',resolution:'1k',enable_prompt_expansion:false,output_format:'png'}:{prompt,image_urls:images,image_size:{width:1024,height:1024},background:'transparent',quality:'high',num_images:1,output_format:'png'};
  }
  v.settings=Object.fromEntries(Object.entries(body).filter(([k])=>!['image_urls','garment_image','model_image','prompt'].includes(k)));v.inputCount=modelKey==='fashn'?2:body.image_urls.length;
  if(planOnly){console.log(JSON.stringify({label,model,inputCount:v.inputCount,sourceHash:v.sourceHash,promptHash:v.promptHash,settings:v.settings}));continue;}
  v.status='submitting';v.stage='generation-submitting';save();
  const response=await exchange(origin+'/'+model,{method:'POST',headers:auth,body,timeoutMs:60000});
  if(response.status>=400){v.httpStatus=response.status;v.status='rejected';v.providerError=response.bytes.toString('utf8');save();console.log(JSON.stringify({label,status:v.status,httpStatus:v.httpStatus}));if(response.status===401||response.status===403)break outer;continue;}
  const accepted=jsonResponse(response);v.receipt=accepted;v.status='accepted';save();const urls=queueURLs(accepted,model),deadline=Date.now()+12*60*1000;
  while(true){const q=jsonResponse(await exchange(urls.status,{headers:auth}));v.queueStatus=q.status;save();if(q.status==='COMPLETED')break;if(!['IN_QUEUE','IN_PROGRESS'].includes(q.status)||Date.now()>deadline)throw Error('Queue pending or unknown');await new Promise(r=>setTimeout(r,4000));}
  v.stage='result-get';save();const answer=jsonResponse(await exchange(urls.response,{headers:auth,limit:4*1024*1024}));v.providerResult=answer;
  const result=await download(answer.images?.[0]?.url);v.generated=result.png.toString('base64');v.nativeAlpha=result.usableAlpha;v.dimensions=[result.width,result.height];v.stage='generated';save();
  if(modelKey!=='fashn'){
   const png=result.usableAlpha?result.png:await cutout(result.png,v);v.cutout=png.toString('base64');v.proportions=await compareTopProportions(prepared,png,features);save();
   try{const fitted=await registerGarmentForFitting(png,features,await measureTopProportions(png,features));v.registered=fitted.png.toString('base64');v.poses=fitted.poses;v.geometry=await checkGarmentLayout(fitted.png,{...features,_armPose:fitted.poses[0]});}catch(e){v.registrationError=e.code||e.name;v.geometry=e.defects||null;}
  }else v.layerLimit='Whole mannequin render; independent layer unavailable and source ratio not directly comparable.';
  v.status='completed';v.stage='done';v.seconds=Math.round((Date.now()-started)/1000);save();console.log(JSON.stringify({label,status:v.status,seconds:v.seconds,nativeAlpha:v.nativeAlpha,proportions:v.proportions,poses:v.poses,registrationError:v.registrationError}));
 }catch(e){v.status='failed-or-unknown';v.safeError=e.code||e.name;v.errorDetail=e.message;v.seconds=Math.round((Date.now()-started)/1000);save();console.log(JSON.stringify({label,status:v.status,stage:v.stage,error:v.safeError}));}
}
if(!planOnly&&Object.values(state.variants).some(v=>v.status!=='completed'))process.exitCode=1;
