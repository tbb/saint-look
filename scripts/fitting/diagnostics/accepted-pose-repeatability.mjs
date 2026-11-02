// Diagnostic: repeat the EXACT generation recipe behind the user-selected visual.
// Generation is frozen at 690b2e9; placement/measurements use the fixed wider-pose prototype.
import{readFileSync,writeFileSync,mkdirSync,symlinkSync}from'node:fs';
import{createCipheriv,createDecipheriv,randomBytes}from'node:crypto';
import{createRequire}from'node:module';import{execFileSync}from'node:child_process';import{pathToFileURL}from'node:url';
import{registerGarmentLayout,checkGarmentLayout}from'../../../backend/src/illustration-layout.mjs';
import{measureTopProportions,compareTopProportions}from'../../../backend/src/illustration-proportions.mjs';
import{fidelityRequest,fidelityAnswer}from'../../../backend/src/illustration-fidelity.mjs';
import{exchange}from'../../../backend/src/providers.mjs';
import{inspectPhotoroomAccount}from'../../deploy/photoroom-account.mjs';
const sharp=createRequire(new URL('../../../backend/package.json',import.meta.url))('sharp');
if(process.env.GITHUB_RUN_ATTEMPT!=='1'||process.env.GITHUB_REF!=='refs/heads/codex/garment-quality-trial')throw Error('Invalid context');
const recipe='690b2e9679304d2ed5a99bbaa153018242c235d6',dir=process.env.RUNNER_TEMP+'/frozen-generation-recipe';mkdirSync(dir,{recursive:true});
const archive=execFileSync('git',['archive',recipe,'backend/src','shared'],{maxBuffer:16*1024*1024});execFileSync('tar',['-x','-C',dir],{input:archive});symlinkSync(process.cwd()+'/backend/node_modules',dir+'/backend/node_modules','dir');
const{createIllustrationProvider}=await import(pathToFileURL(dir+'/backend/src/illustration-provider.mjs'));
const{measureTopProportions:sourceMeasurement}=await import(pathToFileURL(dir+'/backend/src/illustration-proportions.mjs'));
const provider=createIllustrationProvider(process.env),signal=new AbortController().signal;
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex'),raw=readFileSync('scripts/fitting/diagnostics/input.enc'),d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));const bundle=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]));
const state={recipe,variants:{},events:[]};mkdirSync('garment-quality-output',{recursive:true});
function save(){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),out=Buffer.concat([c.update(JSON.stringify(state)),c.final()]);writeFileSync('garment-quality-output/result.enc',Buffer.concat([iv,c.getAuthTag(),out]));}
async function call(name,fn){if(state.events.some(e=>e.name===name))throw Error('Duplicate call');const e={name,status:'started'};state.events.push(e);save();try{const v=await fn();e.status='completed';save();return v;}catch(error){e.status='failed-or-unknown';e.code=error.code||error.name;save();throw error;}}
const quota=await inspectPhotoroomAccount(process.env);if(quota.availableImages<8)throw Error('Insufficient quota');
for(const label of ['hoodie-repeat-a','hoodie-repeat-b','celine-unseen']){
 const v=state.variants[label]={},input=label.startsWith('hoodie')?bundle.items.hoodie:{source:readFileSync('scripts/fitting/fixtures/celine-hoodie.jpg').toString('base64')};
 try{
  const source=await sharp(Buffer.from(input.source,'base64')).png().toBuffer();v.source=source.toString('base64');save();
  const prepared=input.prepared?Buffer.from(input.prepared,'base64'):await call(label+':preparation',()=>provider.prepare(source,signal));v.prepared=prepared.toString('base64');save();
  const photos=[{source,prepared,role:'front'}],features=input.features||await call(label+':attributes',()=>provider.attributes(photos,signal));v.features=features;v.sourceMeasurement=await sourceMeasurement(prepared,features);save();
  const generated=await call(label+':generation',()=>provider.generate(photos,features,signal,id=>{v.receipt=id;save();}));v.generated=generated.png.toString('base64');save();
  const cutout=await call(label+':cutout',()=>provider.prepare(generated.png,signal,'segmentation'));v.cutout=cutout.toString('base64');save();
  v.proportions=await compareTopProportions(prepared,cutout,features);
  try{const registered=await registerGarmentLayout(cutout,features,await measureTopProportions(cutout,features));v.registered=registered.toString('base64');v.geometry=await checkGarmentLayout(registered,features);}catch(error){v.geometry={valid:false,error:error.code||error.name};}save();
  const request=await fidelityRequest(source,cutout),answer=await call(label+':fidelity',()=>exchange('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.TYPESAFE_API_KEY}`,'TypeSafe-Danger-Zone-Images':'true'},body:JSON.stringify(request)},signal,120000,128*1024));v.fidelity=fidelityAnswer(JSON.parse(answer),request);save();
  console.log(JSON.stringify({label,geometry:v.geometry,proportions:v.proportions,fidelity:v.fidelity}));
 }catch(error){v.error=error.code||error.name;save();console.log(JSON.stringify({label,error:v.error}));if(v.error==='processing_unknown'&&state.events.at(-1)?.name.endsWith(':generation'))break;}
}
