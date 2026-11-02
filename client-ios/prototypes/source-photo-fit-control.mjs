// THROWAWAY: determine which original cutouts fit without generative redraw.
// Run: GARMENT_QUALITY_TRIAL_KEY=<hex> node client-ios/prototypes/source-photo-fit-control.mjs <output-directory>
// Input is the existing encrypted diagnostic bundle; never writes production state.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createDecipheriv} from 'node:crypto';
import {createRequire} from 'node:module';
import {registerGarmentLayout,checkGarmentLayout} from '../../backend/src/illustration-layout.mjs';
import {measureTopProportions,compareTopProportions} from '../../backend/src/illustration-proportions.mjs';
const sharp=createRequire(new URL('../../backend/package.json',import.meta.url))('sharp');
const out=process.argv[2];if(!out)throw Error('Output directory required');mkdirSync(out,{recursive:true});
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex');
const raw=readFileSync(new URL('../../scripts/fitting/diagnostics/input.enc',import.meta.url));
const d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));
const bundle=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()])),report=[];
for(const name of ['tee','hoodie','trousers']){
 const input=bundle.items[name],source=await sharp(Buffer.from(input.prepared,'base64')).resize(1024,1024,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
 writeFileSync(out+'/'+name+'-source.png',source);
 try{const result=await registerGarmentLayout(source,input.features,await measureTopProportions(source,input.features));writeFileSync(out+'/'+name+'-registered.png',result);report.push({name,geometry:await checkGarmentLayout(result,input.features),proportions:await compareTopProportions(source,result,input.features)});}
 catch(error){report.push({name,error:error.code||error.name});}
}
writeFileSync(out+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
