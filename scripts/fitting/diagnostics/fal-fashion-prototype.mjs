// THROWAWAY: FASHN on our fixed mannequin, plus one alternate image editor control.
// Each case is submitted ONCE. Receipts are saved before polling; no paid retries.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {exchange,jsonResponse,receipt,decodeImage} from '../trial-http.mjs';
import {editPoseGuide,measuredPoseInstructions} from '../../../backend/src/illustration-edit-pose.mjs';
import {measureTopProportions} from '../../../backend/src/illustration-proportions.mjs';
const sharp=createRequire(new URL('../../../backend/package.json',import.meta.url))('sharp');
if(process.env.GITHUB_REF!=='refs/heads/codex/garment-quality-trial'||process.env.GITHUB_RUN_ATTEMPT!=='1'||process.env.TRIAL_ITEM!=='fal-fashion')throw Error('Invalid diagnostic context');
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex');
const raw=readFileSync('scripts/fitting/diagnostics/input.enc'),d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));
const bundle=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]));
const state={variants:{},events:[]};mkdirSync('garment-quality-output',{recursive:true});
function save(){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),out=Buffer.concat([c.update(JSON.stringify(state)),c.final()]);writeFileSync('garment-quality-output/result.enc',Buffer.concat([iv,c.getAuthTag(),out]));}
const auth={Authorization:`Key ${process.env.FAL_KEY}`},origin='https://queue.fal.run';
const uri=b=>'data:image/png;base64,'+b.toString('base64');
// Same frozen 13 degree pose as the local prototype; never fit pose per garment.
const proto=readFileSync('client-ios/prototypes/arm-pose-prototype.mjs','utf8');
const paths=Object.fromEntries(['left','right','body','head'].map(k=>[k,proto.match(new RegExp("const "+k+"='([^']+)'") )[1]]));
const mannequin=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="864" height="1296" viewBox="0 0 373 560"><rect width="373" height="560" fill="white"/><g fill="#c7c2bd"><path d="${paths.body}"/><path d="${paths.head}"/><path d="${paths.left}" transform="rotate(13 135 147)"/><path d="${paths.right}" transform="rotate(-13 225 148)"/><circle cx="135" cy="151" r="10"/><circle cx="225" cy="151" r="10"/></g></svg>`)).png().toBuffer();
state.mannequin=mannequin.toString('base64');save();
for(const [name,model] of [['hoodie','fal-ai/fashn/tryon/v1.6'],['tee','fal-ai/fashn/tryon/v1.6'],['hoodie','openai/gpt-image-2/edit']]){
 const label=name+'-'+(model.startsWith('fal-ai')?'fashn':'gpt-image'),v=state.variants[label]={model},input=bundle.items[name];
 try{
  const source=await sharp(Buffer.from(input.source,'base64')).png().toBuffer();
  let body;
  if(model.startsWith('fal-ai'))body={model_image:uri(mannequin),garment_image:uri(source),category:'tops',mode:'quality',garment_photo_type:'flat-lay',num_samples:1,output_format:'png',enable_safety_checker:true};
  else{const p=await measureTopProportions(Buffer.from(input.prepared,'base64'),input.features),guide=await editPoseGuide(input.features,p);body={image_urls:[uri(source),uri(guide)],prompt:measuredPoseInstructions(input.features,p).replace('The extra closeups are zoomed DETAIL REFERENCES of the same source, not additional garments.','').replace('from those closeups','from the original photo'),quality:'high',image_size:'square_hd',num_images:1,output_format:'png',background:'opaque',enable_safety_checker:true};}
  v.status='submitting';save();
  const submit=await exchange(origin+'/'+model,{method:'POST',headers:auth,body,timeoutMs:30000});
  if(submit.status>=400){let detail;try{detail=JSON.parse(submit.bytes).detail;}catch{}v.httpStatus=submit.status;v.failure=typeof detail==='string'&&/TOP_UP|Exhausted balance|locked/.test(detail)?'account_balance_unavailable':'submission_rejected';v.status='rejected';save();console.log(JSON.stringify({label,status:v.status,httpStatus:v.httpStatus,failure:v.failure}));if(submit.status===401||submit.status===403)break;continue;}
  const accepted=jsonResponse(submit);v.receipt=accepted;save();
  const app=model.split('/').slice(0,2).join('/'),id=receipt(accepted,app,origin),base=origin+'/'+app+'/requests/'+id;
  v.status='accepted';save();const deadline=Date.now()+240000;
  while(true){const q=jsonResponse(await exchange(base+'/status',{headers:auth}));v.queueStatus=q.status;save();if(q.status==='COMPLETED')break;if(!['IN_QUEUE','IN_PROGRESS'].includes(q.status)||Date.now()>deadline)throw Error('Queue pending or unknown');await new Promise(r=>setTimeout(r,3000));}
  const result=jsonResponse(await exchange(base,{headers:auth}));
  const url=new URL(result.images?.[0]?.url);
  if(url.protocol!=='https:'||url.port||url.username||url.password||!['fal.media','v3.fal.media','v3b.fal.media','cdn.fashn.ai','cdn.staging.fashn.ai'].includes(url.hostname))throw Error('Unapproved output host');
  const decoded=await decodeImage(await exchange(url,{limit:16*1024*1024,timeoutMs:30000}),false);
  v.generated=decoded.png.toString('base64');v.status='completed';save();console.log(JSON.stringify({label,status:v.status,width:decoded.width,height:decoded.height}));
 }catch(error){v.status='failed-or-unknown';v.error=error.message;save();console.log(JSON.stringify({label,status:v.status,error:v.error}));}
}
