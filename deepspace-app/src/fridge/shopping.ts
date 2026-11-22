import type {ActionContext} from 'deepspace/worker'
import type {Env} from '../../worker'
import {DomainError,id,quantity,text} from './domain'
import {normalizeOffer,priceRecipes,candidateBatch,nearbyStores,type MissingItem,type Offer,type PlannedRecipe} from './shopping-math'

type Context=ActionContext<Env>
interface Job {status:string;kind:'stores'|'quote';provider_job_id?:string;next_poll?:number;allow_poll?:boolean;location?:{lat:number;lon:number;label:string};needs?:MissingItem[];servings?:number;budget?:number;created_at?:string;data?:unknown;message?:string;coverage?:ReturnType<typeof candidateBatch>['coverage']}
interface Run {status:string;items?:Record<string,unknown>[];statusMessage?:string}
async function rpc(ctx:Context,op:string,key:string,value?:unknown,kind?:string) {
  const stub=ctx.env.FRIDGE_ROOMS.get(ctx.env.FRIDGE_ROOMS.idFromName(`app:${ctx.env.DEEPSPACE_APP_ID}`))
  const response=await stub.fetch(new Request('https://internal/api/_market/rpc',{method:'POST',headers:{'Content-Type':'application/json','x-fridge-subject':ctx.userId},body:JSON.stringify({op,key,value,kind})}))
  const result=await response.json() as {data:unknown;error?:{code:string;message:string}}
  if(!response.ok) throw new DomainError(response.status,result.error?.code||'SHOPPING_UNAVAILABLE',result.error?.message||'Shopping lookup unavailable.')
  return result.data
}
async function recipes(ctx:Context,servings:number):Promise<PlannedRecipe[]> {
  const stub=ctx.env.FRIDGE_ROOMS.get(ctx.env.FRIDGE_ROOMS.idFromName(`app:${ctx.env.DEEPSPACE_APP_ID}`))
  const response=await stub.fetch(new Request(`https://internal/api/recipes?servings=${servings}`,{headers:{'x-fridge-subject':ctx.userId}}))
  if(!response.ok) throw new DomainError(response.status,'PROFILE_REQUIRED','Open your fridge and create a profile first.')
  return ((await response.json()) as {data:{recipes:PlannedRecipe[]}}).data.recipes
}
async function cachedOffers(ctx:Context,items:MissingItem[]) {
  const keys=[...new Set(items.filter(i=>i.missing>0).map(i=>`offers:${i.name}:${i.unit}`))]
  const cache=await rpc(ctx,'getMany','',keys) as Record<string,Offer[]|null>
  return {cache,offers:Object.values(cache).flatMap(rows=>rows||[]),checked:new Set(items.filter(i=>Array.isArray(cache[`offers:${i.name}:${i.unit}`])).map(i=>i.name))}
}
async function quotation(ctx:Context,all:PlannedRecipe[],budget:number,coverage:Job['coverage']) {
  const {offers,checked}=await cachedOffers(ctx,all.flatMap(r=>r.items))
  return {status:'complete',coverage,checked_at:offers.reduce((oldest,o)=>o.checked_at<oldest?o.checked_at:oldest,new Date().toISOString()),currency:'USD',source:'Amazon US online public listings via Apify',recommendations:priceRecipes(all,offers,budget,checked),scope_note:'Each meal is a separate whole-pack purchase. Public non-member item prices; tax, shipping and delivery eligibility excluded.'}
}
function result(data:unknown,status=200){return Response.json({data},{status,headers:{'Cache-Control':'no-store'}})}
const pending=(job_id:string)=>result({status:'pending',job_id,message:'Checking public listings. This can take up to two minutes.'},202)
const positiveCoordinate=(value:unknown,limit:number)=>{if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>limit)throw new DomainError(400,'INVALID_LOCATION','Choose a valid location.');return Math.round(value*100)/100}

export async function handleShopping(ctx:Context,path:string,method:string):Promise<Response> {
  try {
    const input=ctx.params
    if(path==='/api/recipes/shopping/stores'&&method==='POST') {
      const requestId=id(input.request_id)
      if(typeof input.city==='string')text(input.city,'City',2,100)
      else {positiveCoordinate(input.lat,90);positiveCoordinate(input.lon,180)}
      if(!await rpc(ctx,'jobCreate',requestId,{fingerprint:JSON.stringify(['stores',typeof input.city==='string'?input.city.trim().toLowerCase():[positiveCoordinate(input.lat,90),positiveCoordinate(input.lon,180)]])}))return pending(requestId)
      try {
        await rpc(ctx,'limit','',undefined,'location')
        let lat:number,lon:number,label:string
        if(typeof input.city==='string') {
          const city=text(input.city,'City',2,100)
          const geo=await ctx.tools.integration<Array<{lat:number;lon:number;name:string;country:string;state?:string}>>('openweathermap/geocoding',{query:city,limit:1})
          if(!geo.success||!geo.data?.length)throw new DomainError(422,'CITY_NOT_FOUND','City not found. Include a country, or use your current location.')
          lat=positiveCoordinate(geo.data[0].lat,90);lon=positiveCoordinate(geo.data[0].lon,180);label=[geo.data[0].name,geo.data[0].state,geo.data[0].country].filter(Boolean).join(', ')
        } else {lat=positiveCoordinate(input.lat,90);lon=positiveCoordinate(input.lon,180);label='Near your approximate location'}
        const location={lat,lon,label},cacheKey=`stores:v2:${lat}:${lon}`
        const cached=await rpc(ctx,'get',cacheKey)
        if(cached){await rpc(ctx,'jobUpdate',requestId,{kind:'stores',status:'complete',data:cached});return result({...cached as object,cached:true,status:'complete'})}
        const started=await ctx.tools.integration<{jobId:string}>('apify/run-actor',{actorId:'compass/crawler-google-places',input:{searchStringsArray:['grocery store'],customGeolocation:{type:'Point',coordinates:[lon,lat]},maxCrawledPlacesPerSearch:6,language:'en',skipClosedPlaces:true,maxReviews:0,maxImages:0,scrapePlaceDetailPage:false},maxItems:6,maxTotalChargeUsd:.5,timeout:120})
        if(!started.success) throw new DomainError(503,'STORES_UNAVAILABLE','Nearby shops are temporarily unavailable. You can still choose Amazon US online prices.')
        await rpc(ctx,'jobUpdate',requestId,{kind:'stores',status:'pending',provider_job_id:started.data.jobId,location,created_at:new Date().toISOString(),next_poll:Date.now()+3000})
        return pending(requestId)
      } catch(error) {await rpc(ctx,'jobUpdate',requestId,{status:'failed',message:error instanceof Error?error.message:'Store lookup failed.'});throw error}
    }
    if(path==='/api/recipes/shopping/quote'&&method==='POST') {
      const requestId=id(input.request_id),budget=quantity(input.budget_cents),servings=quantity(input.servings,1),offset=quantity(input.offset??0)
      if(budget>100000||servings>20||offset>10000||input.store!=='amazon-us')throw new DomainError(400,'INVALID_INPUT','Choose Amazon US, a budget up to $1,000, and 1-20 servings.')
      if(!await rpc(ctx,'jobCreate',requestId,{fingerprint:JSON.stringify(['quote',budget,servings,offset,input.store])}))return pending(requestId)
      try {
        const all=await recipes(ctx,servings),{needs,coverage}=candidateBatch(all,offset)
        const {cache}=await cachedOffers(ctx,needs),uncached=needs.filter(i=>!Array.isArray(cache[`offers:${i.name}:${i.unit}`]))
        if(!uncached.length||budget===0) {
          const data=await quotation(ctx,all,budget,coverage)
          await rpc(ctx,'jobUpdate',requestId,{kind:'quote',status:'complete',data})
          return result(data)
        }
        await rpc(ctx,'limit','',undefined,'quote')
        const started=await ctx.tools.integration<{jobId:string}>('apify/run-actor',{actorId:'junglee/amazon-crawler',input:{categoryOrProductUrls:uncached.map(item=>({url:`https://www.amazon.com/s?k=${encodeURIComponent(item.name==='flour'?'all purpose flour grocery':`${item.name} grocery`)}&i=grocery`})),maxItemsPerStartUrl:3,maxSearchPagesPerStartUrl:1,maxOffers:0,scrapeSellers:false,scrapeProductDetails:true,language:'en'},maxItems:uncached.length*3,maxTotalChargeUsd:.12,timeout:120})
        if(!started.success)throw new DomainError(503,'PRICES_UNAVAILABLE','Public prices are temporarily unavailable. No estimated prices have been substituted.')
        await rpc(ctx,'jobUpdate',requestId,{kind:'quote',status:'pending',provider_job_id:started.data.jobId,needs:uncached,servings,budget,coverage,created_at:new Date().toISOString(),next_poll:Date.now()+3000})
        return pending(requestId)
      } catch(error) {await rpc(ctx,'jobUpdate',requestId,{status:'failed',message:error instanceof Error?error.message:'Price lookup failed.'});throw error}
    }
    const match=/^\/api\/recipes\/shopping\/jobs\/([a-f0-9-]{36})$/.exec(path)
    if(match&&method==='GET') {
      const jobId=id(match[1]),job=await rpc(ctx,'jobGet',jobId) as Job
      if(job.status==='complete')return result(job.data)
      if(job.status==='failed')throw new DomainError(503,'LOOKUP_FAILED',job.message||'Lookup failed. Please try again.')
      if(Date.now()-new Date(job.created_at!).getTime()>180000){await rpc(ctx,'jobUpdate',jobId,{...job,status:'failed',message:'Lookup timed out. Start a new search; no prices were assumed.'});throw new DomainError(504,'SHOPPING_TIMEOUT','Lookup timed out. Start a new search; no prices were assumed.')}
      if(!job.allow_poll||!job.provider_job_id)return pending(jobId)
      const polled=await ctx.tools.integration<Run>('apify/get-run',{runId:job.provider_job_id})
      if(!polled.success)throw new DomainError(503,'SHOPPING_UNAVAILABLE','Could not check lookup progress. Try again shortly.')
      if(['FAILED','ABORTED','TIMED-OUT'].includes(polled.data.status)){await rpc(ctx,'jobUpdate',jobId,{...job,status:'failed',message:'The listing provider could not complete this search. Try again.'});throw new DomainError(503,'LOOKUP_FAILED','The listing provider could not complete this search.')}
      if(polled.data.status!=='SUCCEEDED')return pending(jobId)
      const time=new Date().toISOString(),rows=polled.data.items||[]
      let data:unknown
      if(job.kind==='stores') {
        const stores=nearbyStores(rows,job.location!)
        data={status:'complete',location:job.location,stores,checked_at:time,source:'Google Maps listings via Apify',note:'Nearby shop listings do not provide in-store prices. Amazon US is a separate online catalogue.'}
        await rpc(ctx,'put',`stores:v2:${job.location!.lat}:${job.location!.lon}`,data)
      } else {
        const current=await recipes(ctx,job.servings!)
        for(const item of job.needs!) {
          const found=rows.flatMap(row=>{const offer=normalizeOffer(row,item,time);return offer?[offer]:[]})
          await rpc(ctx,'put',`offers:${item.name}:${item.unit}`,found)
        }
        data=await quotation(ctx,current,job.budget!,job.coverage)
      }
      await rpc(ctx,'jobUpdate',jobId,{...job,status:'complete',data})
      return result(data)
    }
    throw new DomainError(404,'NOT_FOUND','Shopping endpoint not found.')
  } catch(error) {
    if(error instanceof DomainError)return Response.json({error:{code:error.code,message:error.message}},{status:error.status})
    console.error('Shopping lookup failed',error instanceof Error?error.name:'Unknown')
    return Response.json({error:{code:'SHOPPING_UNAVAILABLE',message:'Shopping is temporarily unavailable. Your inventory has not changed.'}},{status:503})
  }
}
