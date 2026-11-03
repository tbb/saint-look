// Inspect availability; optionally attach only the verified 40.2 build to existing Personal group.
import{writeFileSync}from'node:fs';import{appleToken}from'./testflight-signing.mjs';
if(process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.GITHUB_REF!=='refs/heads/codex/testflight-availability'||process.env.GITHUB_REPOSITORY!=='tbb/saint-look')throw Error('Invalid diagnostic context');
const config={keyId:process.env.ASC_KEY_ID,issuer:process.env.ASC_ISSUER_ID,privateKey:process.env.ASC_PRIVATE_KEY};
const app='6829496575',report={checkedAt:new Date().toISOString(),appId:app,targetVersion:'1.0',targetBuild:'40.2',requests:[],builds:[],groups:[]};
function save(){writeFileSync('testflight-availability.json',JSON.stringify(report,null,2));}
async function get(path){if(!path.startsWith('/v1/'))throw Error('Invalid path');const r=await fetch('https://api.appstoreconnect.apple.com'+path,{method:'GET',headers:{Authorization:'Bearer '+appleToken(config)},redirect:'error',signal:AbortSignal.timeout(30000)});let n=0,chunks=[];for await(const b of r.body){n+=b.length;if(n>2*1024*1024)throw Error('Response too large');chunks.push(b);}let j;try{j=JSON.parse(Buffer.concat(chunks))}catch{throw Error('Invalid JSON')};report.requests.push({path:path.split('?')[0],httpStatus:r.status,errorCodes:j.errors?.map(e=>e.code)});save();if(!r.ok)throw Error('Apple HTTP '+r.status);return j;}
try{
 const a=await get('/v1/apps/'+app+'?fields[apps]=bundleId,name');if(a.data?.attributes?.bundleId!=='com.saintlook.dev')throw Error('Wrong app');
 const b=await get('/v1/builds?'+new URLSearchParams({'filter[app]':app,sort:'-uploadedDate',limit:'20',include:'buildBetaDetail,preReleaseVersion,betaGroups','fields[builds]':'version,uploadedDate,processingState,expired,buildAudienceType,minOsVersion,usesNonExemptEncryption,buildBetaDetail,preReleaseVersion,betaGroups','fields[buildBetaDetails]':'internalBuildState,externalBuildState,autoNotifyEnabled','fields[preReleaseVersions]':'version,platform','fields[betaGroups]':'name,isInternalGroup,hasAccessToAllBuilds'}));
 const included=new Map((b.included||[]).map(x=>[x.type+'/'+x.id,x.attributes]));
 report.builds=b.data.map(x=>({id:x.id,...x.attributes,beta:included.get('buildBetaDetails/'+x.relationships?.buildBetaDetail?.data?.id),preRelease:included.get('preReleaseVersions/'+x.relationships?.preReleaseVersion?.data?.id),groups:(x.relationships?.betaGroups?.data||[]).map(g=>({id:g.id,...included.get('betaGroups/'+g.id)}))}));save();
 const groups=await get('/v1/apps/'+app+'/betaGroups?limit=50&fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds');
 for(const g of groups.data){const row={id:g.id,...g.attributes};report.groups.push(row);const builds=await get('/v1/betaGroups/'+g.id+'/relationships/builds?limit=200');row.buildIds=(builds.data||[]).map(x=>x.id);row.buildListTruncated=Boolean(builds.links?.next);const testers=await get('/v1/betaGroups/'+g.id+'/relationships/betaTesters?limit=200');row.testerCount=(testers.data||[]).length;row.testerListTruncated=Boolean(testers.links?.next);save();}
 const target=report.builds.find(b=>b.version===report.targetBuild);report.targetFound=Boolean(target);report.targetProcessed=target?.processingState==='VALID';report.targetHasGroup=Boolean(target?.groups?.length||report.groups.some(g=>g.buildIds?.includes(target?.id)));report.targetInternalState=target?.beta?.internalBuildState;save();
 if(process.env.ATTACH_BUILD==='true'){
  if(process.env.GITHUB_RUN_ATTEMPT!=='1')throw Error('Mutation cannot be rerun; inspect first');
  const buildId='ef45832a-8890-49cb-937c-84a06efa18f7',groupId='c3fc4461-e4aa-47a1-ae73-8c78286212b1';
  const group=report.groups.find(g=>g.id===groupId);
  if(target?.id!==buildId||target.preRelease?.version!=='1.0'||target.preRelease?.platform!=='IOS'||target.processingState!=='VALID'||target.expired!==false||target.buildAudienceType!=='INTERNAL_ONLY')throw Error('Unexpected target build');
  if(!group||group.name!=='Personal'||group.isInternalGroup!==true||group.hasAccessToAllBuilds!==false||group.testerCount!==1||group.buildListTruncated||group.testerListTruncated||!group.buildIds.includes('20704592-aab8-4741-94cc-39b971053db2'))throw Error('Unexpected existing group');
  if(!group.buildIds.includes(buildId)){
   report.attachment={groupId,buildId,state:'intent-recorded-no-retry'};save();
   const r=await fetch('https://api.appstoreconnect.apple.com/v1/betaGroups/'+groupId+'/relationships/builds',{method:'POST',headers:{Authorization:'Bearer '+appleToken(config),'Content-Type':'application/json'},body:JSON.stringify({data:[{type:'builds',id:buildId}]}),redirect:'error',signal:AbortSignal.timeout(30000)});
   report.attachment.httpStatus=r.status;report.attachment.state=r.status===204?'accepted':'unconfirmed-inspect-before-any-retry';save();
   if(r.status!==204)throw Error('Attachment HTTP '+r.status);
  }else{report.attachment={groupId,buildId,state:'already-attached-no-mutation'};save();}
  const verified=await get('/v1/betaGroups/'+groupId+'/relationships/builds?limit=200');
  group.buildIds=verified.data.map(b=>b.id);report.targetHasGroup=group.buildIds.includes(buildId);
  const beta=await get('/v1/builds/'+buildId+'/buildBetaDetail');report.targetInternalState=beta.data?.attributes?.internalBuildState;
  report.attachment.verified=report.targetHasGroup;save();
 }
 console.log(JSON.stringify(report,null,2));
 if(!report.targetFound||!report.targetProcessed||!report.targetHasGroup)process.exitCode=1;
}catch(e){report.error=e.message;save();console.log(JSON.stringify({error:report.error,requests:report.requests}));process.exitCode=1;}
