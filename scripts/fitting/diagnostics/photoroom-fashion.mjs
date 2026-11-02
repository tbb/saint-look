// Bounded direct Photoroom fashion probe using the existing production key.
import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{createCipheriv,createDecipheriv,randomBytes}from'node:crypto';import{createRequire}from'node:module';
import{exchange}from'../../../backend/src/providers.mjs';import{createIllustrationProvider}from'../../../backend/src/illustration-provider.mjs';import{registerGarmentLayout,checkGarmentLayout}from'../../../backend/src/illustration-layout.mjs';import{measureTopProportions,compareTopProportions}from'../../../backend/src/illustration-proportions.mjs';
if(process.env.GITHUB_RUN_ATTEMPT!=='1'||process.env.GITHUB_REF!=='refs/heads/codex/garment-quality-trial')throw Error('Invalid context');
const sharp=createRequire(new URL('../../../backend/package.json',import.meta.url))('sharp');
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex'),raw=readFileSync('scripts/fitting/diagnostics/input.enc'),d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));const b=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]));
const state={variants:{},events:[]};mkdirSync('garment-quality-output',{recursive:true});
function save(){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),out=Buffer.concat([c.update(JSON.stringify(state)),c.final()]);writeFileSync('garment-quality-output/result.enc',Buffer.concat([iv,c.getAuthTag(),out]));}
const provider=createIllustrationProvider(process.env),signal=new AbortController().signal;
try{const account=JSON.parse(await exchange('https://image-api.photoroom.com/v2/account',{headers:{'x-api-key':process.env.PHOTOROOM_API_KEY}},signal,30000,64*1024));state.account={plan:account.plan,images:account.images};console.log(JSON.stringify(state.account));save();}catch(e){console.log('account check',e.code);}
for(const name of ['tee','hoodie','trousers'])for(const mode of ['ghostMannequin','flatLay']){
 const input=b.items[name],v=state.variants[name+'-'+mode]={source:input.source,prepared:input.prepared,features:input.features};
 const event={name:name+':'+mode,status:'started'};state.events.push(event);save();
 try{
  const form=new FormData();form.set('imageFile',new Blob([Buffer.from(input.source,'base64')],{type:'image/png'}),'source.png');form.set(mode+'.mode','ai.auto');
  form.set(mode+'.prompt','Exact original garment, front elevation, unfolded sleeves hanging down and 24 degrees outward from vertical. Preserve actual short or long sleeve length, original roomy torso width/length ratio and every printed detail. No sleeves crossing the body, no duplicated sleeves. Hood lowered behind collar. No person or mannequin. For trousers: untwist legs, keep original wide cut, thin irregular stripes and fabric.');
  form.set('export.format','png');form.set('outputSize','1024x1024');
  const bytes=await exchange('https://image-api.photoroom.com/v2/edit',{method:'POST',headers:{'x-api-key':process.env.PHOTOROOM_API_KEY},body:form},signal,120000,12*1024*1024);
  v.generated=(await sharp(bytes).png().toBuffer()).toString('base64');event.status='completed';save();
  const cutout=await sharp(bytes).resize(1024,1024,{fit:'contain',background:'#00000000'}).ensureAlpha().png().toBuffer();v.cutout=cutout.toString('base64');save();
  const registered=await registerGarmentLayout(cutout,input.features,await measureTopProportions(cutout,input.features));v.registered=registered.toString('base64');v.geometry=await checkGarmentLayout(registered,input.features);v.proportions=await compareTopProportions(Buffer.from(input.prepared,'base64'),registered,input.features);save();
  if(v.proportions.measurable&&!v.proportions.valid){v.error='illustration_proportions_changed';save();continue;}
  v.fidelity=await provider.fidelity(Buffer.from(input.source,'base64'),registered,signal);v.accepted=true;save();console.log(JSON.stringify({name,mode,accepted:true}));
 }catch(error){v.error=error.code||error.name;v.defects=error.defects;if(event.status==='started')event.status='failed-or-unknown';save();console.log(JSON.stringify({name,mode,error:v.error,defects:v.defects}));if(['provider_auth_failed','provider_payment_required'].includes(v.error))process.exit(0);}
}
