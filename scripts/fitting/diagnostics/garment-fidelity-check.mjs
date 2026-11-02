import{readFileSync,writeFileSync,mkdirSync}from'node:fs';
import{createDecipheriv}from'node:crypto';
import{featureRequest,featureAnswer}from'../../../backend/src/illustration-features.mjs';
import{exchange}from'../../../backend/src/providers.mjs';
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex'),raw=readFileSync('scripts/fitting/diagnostics/input.enc');
const d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));
const cases=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()])).qa;
if(!Array.isArray(cases)||cases.length!==3)throw new Error('Expected three fixed comparison cases');
mkdirSync('garment-quality-output',{recursive:true});const results=[];
const save=()=>writeFileSync('garment-quality-output/fidelity.json',JSON.stringify(results,null,2));
const criteria={preserved:'Visibly preserved; stylistic shading or unfolding incidental wrinkles alone is allowed',changed:'A material identity change is visible',uncertain:'Not enough visible evidence to decide'};
for(const item of cases){
 const request=await featureRequest([Buffer.from(item.source,'base64'),Buffer.from(item.candidate,'base64')],['original_reference','generated_candidate']);
 request.questions=Object.fromEntries(Object.entries({
  cut:'Compare torso width relative to length, fitted versus roomy cut, designed hem, sleeve length and leg width. Is the original cut preserved?',
  artwork:'Compare the actual shapes, symbols, colours, text, sizes and placements of printed artwork. A different crest, logo, symbol, invented label or moved print is a material change. Is the artwork preserved?',
  material:'Compare main garment colour, fabric appearance and any stripes/checks, including pattern complexity. Ignore lighting alone. Are colour, material and pattern preserved?',
  construction:'Compare neckline, hood, fastenings, pockets, cuffs, seams and other visible construction. Is the construction preserved?',
 }).map(([name,question])=>[name,{type:'choice',criteria,instructions:'Compare the original_reference image to generated_candidate of the SAME garment. Ignore photo backgrounds and processing marks. Do not assume matching brand or category means matching item. '+question}]));
 const row={name:item.name,status:'started'};results.push(row);save();
 try{
  const raw=await exchange('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.TYPESAFE_API_KEY,'TypeSafe-Danger-Zone-Images':'true'},body:JSON.stringify(request)},new AbortController().signal,120000,12*1024*1024);
  const parsed=featureAnswer(JSON.parse(raw),request);row.evidence=parsed.evidence;row.status='completed';save();console.log(JSON.stringify(row));
 }catch(error){row.status='failed-or-unknown';row.code=error.code||error.name;save();throw new Error('Fidelity diagnostic stopped; no retry');}
}
