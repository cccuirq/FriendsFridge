/** All inventory amounts are integer hundredths; money is integer cents. */
export interface MissingItem {ingredient_id:string;name:string;unit:string;missing:number}
export interface Offer {name:string;title:string;url:string;price_cents:number;package_quantity:number;unit:string;checked_at:string;package_label?:string}
export interface PlannedRecipe {_id:string;title:string;missing_count:number;items:MissingItem[]}

export {packageQuantity,normalizeOffer,inspectOffer,searchTerm,productCandidates} from './offer-parser'

export function priceRecipes(recipes:PlannedRecipe[],offers:Offer[],budget:number,checkedNames?:Set<string>,diagnostics?:Record<string,string>) {
  return recipes.map(recipe=>{
    const lines=recipe.items.filter(i=>i.missing>0).map(item=>{
      const options=offers.filter(o=>o.name===item.name&&o.unit===item.unit).map(offer=>{const packs=Math.ceil(item.missing/offer.package_quantity);return {...offer,packs,total_cents:packs*offer.price_cents,missing:item.missing,leftover:packs*offer.package_quantity-item.missing}}).sort((a,b)=>a.total_cents-b.total_cents)
      return {ingredient_id:item.ingredient_id,name:item.name,unit:item.unit,missing:item.missing,offer:options[0]||null,reason:options.length?null:diagnostics?.[item.name]||(checkedNames&&!checkedNames.has(item.name)?'not_checked':'no_verified_offer')}
    })
    const complete=lines.every(l=>l.offer),total_cents=complete?lines.reduce((n,l)=>n+l.offer!.total_cents,0):null
    return {recipe_id:recipe._id,title:recipe.title,lines,known_total_cents:lines.reduce((sum,line)=>sum+(line.offer?.total_cents||0),0),total_cents,within_budget:complete&&total_cents!<=budget,remaining_cents:complete?budget-total_cents!:null,status:complete?'priced':'unpriced'}
  }).sort((a,b)=>Number(b.within_budget)-Number(a.within_budget)||(a.total_cents??Infinity)-(b.total_cents??Infinity))
}

export function candidateBatch(recipes:PlannedRecipe[],offset:number) {
  const candidates=recipes.filter(r=>r.missing_count>0),needs:MissingItem[]=[],checked_recipe_ids:string[]=[]
  let cursor=offset
  for(;cursor<candidates.length&&checked_recipe_ids.length<4;cursor++) {
    const recipe=candidates[cursor],fresh=recipe.items.filter(i=>i.missing>0&&!needs.some(n=>n.ingredient_id===i.ingredient_id))
    if(recipe.items.filter(i=>i.missing>0).length>6)continue
    if(needs.length+fresh.length>6)break
    needs.push(...fresh);checked_recipe_ids.push(recipe._id)
  }
  return {needs,coverage:{checked_recipe_ids,ingredient_count:needs.length,total_candidates:candidates.length,offset,next_offset:cursor<candidates.length?cursor:null,recipe_limit:4,ingredient_limit:6}}
}

export function nearbyStores(rows:Record<string,unknown>[],location:{lat:number;lon:number}) {
  const rad=(n:number)=>n*Math.PI/180
  return rows.flatMap(row=>{
    const name=typeof row.title==='string'?row.title:'',categories=JSON.stringify([row.categoryName,row.categories]).toLowerCase()
    if(!name||row.permanentlyClosed||row.temporarilyClosed||/\b(?:wic|charit(?:y|ies)|food bank|food pantry|donation|gas station|pet food)\b/i.test(name+' '+categories))return []
    const point=row.location as {lat?:number;lng?:number}|undefined
    if(!point||typeof point.lat!=='number'||typeof point.lng!=='number'||!Number.isFinite(point.lat)||!Number.isFinite(point.lng))return []
    const a=Math.sin(rad(point.lat-location.lat)/2)**2+Math.cos(rad(location.lat))*Math.cos(rad(point.lat))*Math.sin(rad(point.lng-location.lon)/2)**2
    const distance_km=Math.round(6371*2*Math.asin(Math.min(1,Math.sqrt(a)))*10)/10
    if(distance_km>15)return []
    return [{name:name.slice(0,150),address:String(row.address||'Address not listed').slice(0,250),url:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name+' '+String(row.address||''))}`,distance_km,prices_available:false}]
  }).sort((a,b)=>a.distance_km-b.distance_km).slice(0,6)
}
