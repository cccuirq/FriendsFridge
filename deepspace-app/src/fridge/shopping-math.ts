/** All inventory amounts are integer hundredths; money is integer cents. */
export interface MissingItem {ingredient_id:string;name:string;unit:string;missing:number}
export interface Offer {name:string;title:string;url:string;price_cents:number;package_quantity:number;unit:string;checked_at:string}
export interface PlannedRecipe {_id:string;title:string;missing_count:number;items:MissingItem[]}

export function packageQuantity(title:string,unit:string):number|null {
  const t=title.toLowerCase().replace(/,/g,'')
  const packs=[...t.matchAll(/(?:pack of|packs? of)\s*(\d+)/g)]
  if(packs.length>1) return null
  const count=packs.length?Number(packs[0][1]):1
  if(count<1||count>100) return null
  let value:number|undefined
  if(unit==='piece') {
    const match=t.match(/\b(\d+)\s*(?:count|ct|eggs|pieces?|pcs)\b/)
    if(match) value=Number(match[1])
    else if(/\bdozen\b/.test(t)) value=12
  } else {
    const matches=[...t.matchAll(/\b(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|fluid ounces?|gallons?|gal|quarts?|qt|liters?|litres?|ml|kg|grams?|g|pounds?|lbs?|ounces?|oz)\b/g)]
    const conversions:Record<string,number|undefined>=unit==='g'?{'g':1,'gram':1,'grams':1,'kg':1000,'lb':453.59237,'lbs':453.59237,'pound':453.59237,'pounds':453.59237,'oz':28.349523125,'ounce':28.349523125,'ounces':28.349523125}:{'ml':1,'liter':1000,'liters':1000,'litre':1000,'litres':1000,'gal':3785.411784,'gallon':3785.411784,'gallons':3785.411784,'qt':946.352946,'quart':946.352946,'quarts':946.352946,'floz':29.5735295625,'fluidounce':29.5735295625,'fluidounces':29.5735295625}
    const candidates=matches.map(m=>Number(m[1])*(conversions[m[2].replace(/[.\s]/g,'')]??NaN)).filter(n=>Number.isFinite(n)&&n>0)
    if(!candidates.length) return null
    // Accept equivalent printed dual units, but never inconsistent totals.
    const smallest=Math.min(...candidates),largest=Math.max(...candidates)
    if(largest/smallest>1.02) return null
    value=smallest
  }
  const quantity=Math.floor((value||0)*count*100)
  return Number.isSafeInteger(quantity)&&quantity>0?quantity:null
}

export function normalizeOffer(raw:Record<string,unknown>,item:MissingItem,checked_at:string):Offer|null {
  const title=typeof raw.title==='string'?raw.title:''
  const details=`${title} ${JSON.stringify(raw.inStockText||'')} ${JSON.stringify(raw.priceRange||'')}`.toLowerCase()
  if(raw.inStock!==true||/prime.only|members?.only|subscribe|subscription|coupon|used|refurbished|out of stock/.test(details)) return null
  const terms=item.name.toLowerCase().split(/[\s-]+/)
  if(!terms.every(term=>new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:s)?\\b`,'i').test(title))) return null
  if(/\b(?:toy|artificial|scent|candle|powdered|extract|flavo(?:r|u)red|replacement)\b/i.test(title)&&!item.name.includes('powder')&&!item.name.includes('extract')) return null
  if(item.name==='flour'&&(!/all.purpose/i.test(title)||/gluten.free|self.rising|whole.wheat|almond|coconut|cassava|chickpea|rice flour|substitute|measure for measure/i.test(title))) return null
  if(item.name==='milk'&&/almond|oat|coconut|soy|powder|condensed|evaporated/i.test(title)) return null
  const price=raw.price as {value?:unknown;currency?:unknown}|undefined
  const url=typeof raw.url==='string'?raw.url:''
  if(!/^https:\/\/(?:www\.)?amazon\.com\/dp\/[A-Z0-9]{10}(?:[/?]|$)/.test(url)||price?.currency!=='$'||typeof price.value!=='number'||price.value<=0||price.value>1000) return null
  const package_quantity=packageQuantity(title,item.unit)
  return package_quantity?{name:item.name,title,url,price_cents:Math.round(price.value*100),package_quantity,unit:item.unit,checked_at}:null
}

export function priceRecipes(recipes:PlannedRecipe[],offers:Offer[],budget:number,checkedNames?:Set<string>) {
  return recipes.map(recipe=>{
    const lines=recipe.items.filter(i=>i.missing>0).map(item=>{
      const options=offers.filter(o=>o.name===item.name&&o.unit===item.unit).map(offer=>{const packs=Math.ceil(item.missing/offer.package_quantity);return {...offer,packs,total_cents:packs*offer.price_cents,missing:item.missing,leftover:packs*offer.package_quantity-item.missing}}).sort((a,b)=>a.total_cents-b.total_cents)
      return {ingredient_id:item.ingredient_id,name:item.name,unit:item.unit,missing:item.missing,offer:options[0]||null,reason:options.length?null:checkedNames&&!checkedNames.has(item.name)?'not_checked':'no_verified_offer'}
    })
    const complete=lines.every(l=>l.offer),total_cents=complete?lines.reduce((n,l)=>n+l.offer!.total_cents,0):null
    return {recipe_id:recipe._id,title:recipe.title,lines,total_cents,within_budget:complete&&total_cents!<=budget,remaining_cents:complete?budget-total_cents!:null,status:complete?'priced':'unpriced'}
  }).sort((a,b)=>Number(b.within_budget)-Number(a.within_budget)||(a.total_cents??Infinity)-(b.total_cents??Infinity))
}

export function candidateBatch(recipes:PlannedRecipe[],offset:number) {
  const candidates=recipes.filter(r=>r.missing_count>0),needs:MissingItem[]=[],checked_recipe_ids:string[]=[]
  let cursor=offset
  for(;cursor<candidates.length&&checked_recipe_ids.length<4;cursor++) {
    const recipe=candidates[cursor],fresh=recipe.items.filter(i=>i.missing>0&&!needs.some(n=>n.ingredient_id===i.ingredient_id))
    if(needs.length+fresh.length>6)continue
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
