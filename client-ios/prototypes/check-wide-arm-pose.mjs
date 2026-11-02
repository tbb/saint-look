// Run from diagnostic worktree: node client-ios/prototypes/check-wide-arm-pose.mjs <run IDs...>
import{readFileSync,writeFileSync}from'node:fs';
import{registerGarmentLayout,checkGarmentLayout}from'../../backend/src/illustration-layout-pose-prototype.mjs';
import{measureTopProportions,compareTopProportions}from'../../backend/src/illustration-proportions.mjs';
for(const id of process.argv.slice(2)){
 const root='/tmp/saint-look-quality-'+id+'/',state=JSON.parse(readFileSync(root+'state.json')),bytes=readFileSync(root+'production-cutout.png'),features=state.features;
 try{const result=await registerGarmentLayout(bytes,features,await measureTopProportions(bytes,features));writeFileSync('/tmp/saint-look-wide-pose-'+id+'.png',result);console.log(JSON.stringify({id,geometry:await checkGarmentLayout(result,features),proportions:await compareTopProportions(readFileSync(root+'prepared.png'),result,features)}));}
 catch(error){console.log(JSON.stringify({id,error:error.code||error.name}));}
}
