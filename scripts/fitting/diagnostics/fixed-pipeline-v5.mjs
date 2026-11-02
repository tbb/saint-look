// Fixed v5 evaluation: the same production provider, registration and correction
// policy for all 12 garments. One corrective attempt only after a known defect.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createIllustrationProvider,illustrationVersions} from '../../../backend/src/illustration-provider.mjs';
import {registerGarmentForFitting,garmentLayout} from '../../../backend/src/illustration-layout.mjs';
import {measureTopProportions,compareTopProportions} from '../../../backend/src/illustration-proportions.mjs';
import {qualityCorrection} from '../../../backend/src/illustration-quality.mjs';
import {ProviderError} from '../../../backend/src/providers.mjs';
const sharp=createRequire(new URL('../../../backend/package.json',import.meta.url))('sharp');
if(process.env.GITHUB_RUN_ATTEMPT!=='1'||process.env.GITHUB_REF!=='refs/heads/codex/garment-quality-trial')throw Error('Invalid diagnostic context');
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex'),raw=readFileSync('scripts/fitting/diagnostics/input.enc'),d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));
const bundle=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]));
const provider=createIllustrationProvider(process.env),signal=new AbortController().signal;
const state={versions:illustrationVersions,sha:process.env.GITHUB_SHA,variants:{},cases:{},events:[]};
mkdirSync('garment-quality-output',{recursive:true});
function save(){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),out=Buffer.concat([c.update(JSON.stringify(state)),c.final()]);writeFileSync('garment-quality-output/result.enc',Buffer.concat([iv,c.getAuthTag(),out]));}
async function call(name,fn){if(state.events.some(e=>e.name===name))throw Error('Duplicate call');const e={name,status:'started'};state.events.push(e);save();try{const v=await fn();e.status='completed';save();return v;}catch(error){e.status='failed-or-unknown';e.code=error.code||error.name;save();throw error;}}
if(process.env.TRIAL_ITEM==='valid-silhouette')writeFileSync('/tmp/valid-silhouette.png',Buffer.from(bundle.validSilhouette,'base64'));
const cases=process.env.TRIAL_ITEM==='valid-silhouette'?['repeat-a','repeat-b'].map(name=>({name,input:bundle.fixedPoseItems[0].input})):process.env.TRIAL_ITEM==='fixed-pose-targets'?bundle.fixedPoseItems:[...['hoodie','tee','trousers'].map(name=>({name,input:bundle.items[name]})),
 ...['polo.jpg','printed-tee.jpg','white-tee.png','celine-hoodie.jpg','jeans.jpg','open-denim-jacket.jpg','ribbed-cardigan.jpg','trenchcoat.jpg','creepers.png'].map(file=>({name:file.split('.')[0],input:{source:readFileSync('scripts/fitting/fixtures/'+file).toString('base64')}}))];
async function evaluate({name,input}) {
 const record=state.cases[name]={acceptedAttempt:null};
 try {
  const source=await sharp(Buffer.from(input.source,'base64')).png().toBuffer();
  const prepared=input.prepared?Buffer.from(input.prepared,'base64'):await call(name+':preparation',()=>provider.prepare(source,signal));
  const photos=[{source:input.generationSource?Buffer.from(input.generationSource,'base64'):source,prepared,role:'front'}];
  const features=input.features||await call(name+':attributes',()=>provider.attributes(photos,signal));record.features=features;
  if(garmentLayout(features).group==='hooded' && features.traits?.sleeves==='long'){
   const unfolded=await call(name+':unfolding',()=>provider.unfold(source,signal));
   record.unfolded=unfolded.toString('base64');photos[0].generationReference=unfolded;save();
  }
  let correction;
  for(let attempt=1;attempt<=2;attempt++) {
   const label=name+'-'+attempt,v=state.variants[label]={source:source.toString('base64'),prepared:prepared.toString('base64'),features,correction};save();
   try {
    const generated=await call(label+':generation',()=>provider.generate(photos,features,signal,id=>{v.receipt=id;save();},null,correction));
    v.generated=generated.png.toString('base64');save();
    const cutout=generated.usableAlpha?generated.png:await call(label+':cutout',()=>provider.prepare(generated.png,signal,'finalization'));
    v.cutout=cutout.toString('base64');save();
    const {png:registered,poses}=await registerGarmentForFitting(cutout,features,await measureTopProportions(cutout,features));
    v.registered=registered.toString('base64');v.geometry={valid:poses.length>0,poses};save();
    v.proportions=await compareTopProportions(prepared,registered,features);save();
    if(v.proportions.measurable&&!v.proportions.valid)throw new ProviderError('illustration_proportions_changed');
    v.fidelity=await call(label+':fidelity',()=>provider.fidelity(source,registered,signal));
    record.acceptedAttempt=attempt;v.accepted=true;save();
    console.log(JSON.stringify({name,attempt,accepted:true,proportions:v.proportions,fidelity:v.fidelity}));return;
   } catch(error) {
    v.error=error.code||error.name;v.defects=error.defects;record.error=v.error;
    if(v.cutout&&!v.geometry) v.geometry={valid:false,error:v.error};
    correction=error instanceof ProviderError&&!error.unknown&&qualityCorrection(error);save();
    console.log(JSON.stringify({name,attempt,error:v.error,defects:v.defects,proportions:v.proportions}));
    if(!correction||attempt===2)return;
   }
  }
 } catch(error){record.error=error.code||error.name;save();console.log(JSON.stringify({name,error:record.error}));}
}
// At most two independent garments concurrently. No retry of a timed-out stage.
let next=0;
await Promise.all([0,1].map(async()=>{while(next<cases.length){const item=cases[next++];await evaluate(item);}}));
state.summary={total:cases.length,first:Object.values(state.cases).filter(c=>c.acceptedAttempt===1).length,
 corrected:Object.values(state.cases).filter(c=>c.acceptedAttempt===2).length};save();console.log(JSON.stringify(state.summary));
