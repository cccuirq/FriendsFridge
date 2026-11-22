import type {ActionContext} from 'deepspace/worker'
import type {Env} from '../../worker'
import {DomainError,id,quantity,text} from './domain'
import {inspectOffer,searchTerm,productCandidates,candidateBatch,priceRecipes,type MissingItem,type Offer,type PlannedRecipe} from './shopping-math'

type Context=ActionContext<Env>
interface Job {coverage?:ReturnType<typeof candidateBatch>['coverage'];status:string;kind:'stores'|'quote';provider_job_id?:string;next_poll?:number;allow_poll?:boolean;location?:{lat:number;lon:number;label:string};needs?:MissingItem[];servings?:number;budget?:number;created_at?:string;data?:unknown;message?:string}
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
interface CachedFood {offers:Offer[];reason:string|null;checked_at:string}
const offerKey=(item:MissingItem)=>`offers:v6:${item.name}:${item.unit}`
async function quoteResult(ctx:Context,all:PlannedRecipe[],budget:number,coverage:Job['coverage']) {
  const unique=[...new Map(all.flatMap(r=>r.items).filter(i=>i.missing>0).map(i=>[i.ingredient_id,i])).values()]
  const entries=await Promise.all(unique.map(async item=>[item,await rpc(ctx,'get',offerKey(item)) as CachedFood|null] as const))
  const offers=entries.flatMap(([,cache])=>cache?.offers||[]),checked=new Set(entries.filter(([,cache])=>cache).map(([item])=>item.name))
  const reasons=Object.fromEntries(entries.map(([item,cache])=>[item.name,cache?.reason||(!cache?'not_checked':'no_verified_offer')]))
  const recommendations=priceRecipes(all,offers,budget,checked,reasons)
  return {status:'complete',coverage,checked_at:entries.reduce((time,[,cache])=>cache&&cache.checked_at<time?cache.checked_at:time,new Date().toISOString()),currency:'USD',source:'Amazon US online public listings via Apify',recommendations,summary:{within_budget:recommendations.filter(r=>r.within_budget).length,incomplete:recommendations.filter(r=>r.status==='unpriced').length,over_budget:recommendations.filter(r=>r.status==='priced'&&!r.within_budget).length},scope_note:'Separate single-meal whole-pack purchases. Non-member item prices; tax, shipping and delivery eligibility excluded.'}
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
      if(!await rpc(ctx,'jobCreate',requestId))return pending(requestId)
      try {
        await rpc(ctx,'limit','',undefined,'location')
        let lat:number,lon:number,label:string
        if(typeof input.city==='string') {
          const city=text(input.city,'City',2,100)
          const geo=await ctx.tools.integration<Array<{lat:number;lon:number;name:string;country:string;state?:string}>>('openweathermap/geocoding',{query:city,limit:1})
          if(!geo.success||!geo.data?.length)throw new DomainError(422,'CITY_NOT_FOUND','City not found. Include a country, or use your current location.')
          lat=positiveCoordinate(geo.data[0].lat,90);lon=positiveCoordinate(geo.data[0].lon,180);label=[geo.data[0].name,geo.data[0].state,geo.data[0].country].filter(Boolean).join(', ')
        } else {lat=positiveCoordinate(input.lat,90);lon=positiveCoordinate(input.lon,180);label='Near your approximate location'}
        const location={lat,lon,label},cacheKey=`stores:${lat}:${lon}`
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
      const all=await recipes(ctx,servings),{needs,coverage}=candidateBatch(all,offset)
      const uncached:MissingItem[]=[]
      for(const item of needs)if(!await rpc(ctx,'get',offerKey(item)))uncached.push(item)
      if(!uncached.length||budget===0){const data=await quoteResult(ctx,all,budget,coverage);await rpc(ctx,'jobUpdate',requestId,{kind:'quote',status:'complete',data});return result(data)}
      try {
        await rpc(ctx,'limit','',undefined,'quote')
        const started=await ctx.tools.integration<{jobId:string}>('apify/run-actor',{actorId:'junglee/amazon-crawler',input:{categoryOrProductUrls:[...uncached.flatMap(item=>productCandidates(item).map(url=>({url}))),...uncached.map(item=>({url:`https://www.amazon.com/s?k=${encodeURIComponent(searchTerm(item))}&i=grocery&s=price-asc-rank`}))],maxItemsPerStartUrl:6,maxSearchPagesPerStartUrl:1,maxOffers:0,scrapeSellers:false,scrapeProductDetails:true,language:'en'},maxItems:Math.min(42,uncached.length*6+uncached.flatMap(productCandidates).length),maxTotalChargeUsd:.25,timeout:120})
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
      if(!job.allow_poll||!job.provider_job_id)return pending(jobId)
      if(Date.now()-new Date(job.created_at!).getTime()>180000)throw new DomainError(504,'SHOPPING_TIMEOUT','Lookup timed out. Try again; no prices were assumed.')
      const polled=await ctx.tools.integration<Run>('apify/get-run',{runId:job.provider_job_id})
      if(!polled.success)throw new DomainError(503,'SHOPPING_UNAVAILABLE','Could not check lookup progress. Try again shortly.')
      if(['FAILED','ABORTED','TIMED-OUT'].includes(polled.data.status)){await rpc(ctx,'jobUpdate',jobId,{...job,status:'failed',message:'The listing provider could not complete this search. Try again.'});throw new DomainError(503,'SHOPPING_UNAVAILABLE','The listing provider could not complete this search.')}
      if(polled.data.status!=='SUCCEEDED')return pending(jobId)
      const time=new Date().toISOString(),rows=polled.data.items||[]
      let data:unknown
      if(job.kind==='stores') {
        const stores=rows.slice(0,6).filter(r=>typeof r.title==='string'&&!r.permanentlyClosed).map(r=>({name:String(r.title).slice(0,150),address:String(r.address||'Address not listed').slice(0,250),url:typeof r.url==='string'&&r.url.startsWith('https://www.google.com/maps')?r.url:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(r.title)+' '+String(r.address||''))}`,prices_available:false}))
        data={status:'complete',location:job.location,stores,checked_at:time,source:'Google Maps listings via Apify',note:'Nearby shop listings do not provide in-store prices. Amazon US is a separate online catalogue.'}
        await rpc(ctx,'put',`stores:${job.location!.lat}:${job.location!.lon}`,data)
      } else {
        const current=await recipes(ctx,job.servings!)
        for(const item of job.needs!) {
          const inspected=rows.map(row=>inspectOffer(row,item,time)),offers=inspected.flatMap(row=>row.offer?[row.offer]:[])
          const relevant=inspected.filter(row=>row.reason!=='different_product')
          const reasons=['unknown_pack_size','no_public_price','unavailable','conditional_price','invalid_link']
          const reason=offers.length?null:reasons.find(code=>relevant.some(row=>row.reason===code))||(rows.length?'no_matching_product':'no_results')
          await rpc(ctx,'put',offerKey(item),{offers,reason,checked_at:time})
        }
        data=await quoteResult(ctx,current,job.budget!,job.coverage)
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
