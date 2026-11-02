// Temporary DEBUG-only render evidence; no external provider requests.
import{readFileSync,writeFileSync}from'node:fs';import{createDecipheriv,createHash}from'node:crypto';
const key=Buffer.from(process.env.GARMENT_QUALITY_TRIAL_KEY,'hex'),raw=readFileSync('scripts/fitting/diagnostics/input.enc');
const d=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));d.setAuthTag(raw.subarray(12,28));
const bundle=JSON.parse(Buffer.concat([d.update(raw.subarray(28)),d.final()]));
const root='client-ios/SaintLook/VisualFixtures/',manifest=JSON.parse(readFileSync(root+'prepared-manifest.json'));
for(const [name,b64]of Object.entries(bundle.nativeAssets)){
 const bytes=Buffer.from(b64,'base64');writeFileSync(root+'fitting-'+name+'.png',bytes);
 const entry=manifest[name];entry.imageSHA256=createHash('sha256').update(bytes).digest('hex');
 Object.assign(entry,bundle.nativeMetadata[name]);
 const representation=JSON.parse(readFileSync(root+entry.representationFilename));representation.sourceSHA256=entry.imageSHA256;
 const text=JSON.stringify(representation);writeFileSync(root+entry.representationFilename,text);entry.representationSHA256=createHash('sha256').update(text).digest('hex');
}
writeFileSync(root+'prepared-manifest.json',JSON.stringify(manifest,null,2));
const file='client-ios/SaintLook/VisualFixtures.swift';
writeFileSync(file,readFileSync(file,'utf8').replace('("trial-tee", "t_shirt", "white")','("trial-tee", "t_shirt", "black")').replace('("trial-hoodie", "hoodie", "beige")','("trial-hoodie", "hoodie", "black")').replace('("trial-longtee", "t_shirt", "beige")','("trial-longtee", "t_shirt", "gray")'));
console.log('Loaded v6 registered DEBUG examples; untouched legacy assets retain their geometry versions; representations remain isolated controlled fixtures.');
