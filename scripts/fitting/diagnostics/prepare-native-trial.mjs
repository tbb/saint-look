// Temporary DEBUG-only render evidence; no external provider requests.
import{readFileSync,writeFileSync}from'node:fs';import{createDecipheriv,createHash}from'node:crypto';
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex'),raw=readFileSync('scripts/fitting/diagnostics/input.enc');
const d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));
const bundle=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]));
const root='client-ios/SaintLook/VisualFixtures/',manifest=JSON.parse(readFileSync(root+'prepared-manifest.json'));
for(const [name,b64]of Object.entries(bundle.nativeAssets)){
 const bytes=Buffer.from(b64,'base64');writeFileSync(root+'fitting-'+name+'.png',bytes);
 manifest[name].imageSHA256=createHash('sha256').update(bytes).digest('hex');
}
writeFileSync(root+'prepared-manifest.json',JSON.stringify(manifest,null,2));
const file='client-ios/SaintLook/VisualFixtures.swift';
writeFileSync(file,readFileSync(file,'utf8').replace('templateVersion: trial ?', 'templateVersion: trial && !["trial-tee","trial-jeans","trial-hoodie","trial-longtee"].contains(input.0) ?').replace('geometryVersion: trial ?', 'geometryVersion: trial && !["trial-tee","trial-jeans","trial-hoodie","trial-longtee"].contains(input.0) ?').replace('("trial-tee", "t_shirt", "white")','("trial-tee", "t_shirt", "black")').replace('("trial-hoodie", "hoodie", "beige")','("trial-hoodie", "hoodie", "black")'));
console.log('Loaded v5 registered DEBUG examples; untouched legacy assets retain their geometry versions; representations remain isolated controlled fixtures.');
