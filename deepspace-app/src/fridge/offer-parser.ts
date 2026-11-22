import type {MissingItem,Offer} from './shopping-math'

export function packageQuantity(label:string,unit:string):number|null {
  const t=label.toLowerCase().replace(/,/g,'').replace(/half\s+(gallon|liter|litre)/g,'0.5 $1')
  const packs=[...t.matchAll(/(?:packs? of\s*|\b)(\d+)\s*(?:[- ]?packs?\b)|packs? of\s*(\d+)/g)]
  if(packs.length>1)return null
  const multiple=t.match(/\b(\d+)\s*[x×]\s*\d/)
  const count=packs.length?Number(packs[0][1]||packs[0][2]):multiple?Number(multiple[1]):1
  if(count<1||count>100)return null
  let candidates:number[]=[]
  if(unit==='piece') {
    candidates=[...t.matchAll(/\b(\d+)\s*[- ]?\s*(?:counts?|ct|eggs|pieces?|pcs)\b/g)].map(m=>Number(m[1]))
    if(!candidates.length&&/\bdozen\b/.test(t))candidates=[12*Number(t.match(/\b(\d+)\s*dozen/)?.[1]||1)]
  } else {
    const conversions:Record<string,number>=unit==='g'
      ?{g:1,gram:1,grams:1,kg:1000,lb:453.59237,lbs:453.59237,pound:453.59237,pounds:453.59237,oz:28.349523125,ounce:28.349523125,ounces:28.349523125}
      :unit==='ml'?{ml:1,l:1000,liter:1000,liters:1000,litre:1000,litres:1000,gal:3785.411784,gallon:3785.411784,gallons:3785.411784,qt:946.352946,quart:946.352946,quarts:946.352946,floz:29.5735295625,fluidounce:29.5735295625,fluidounces:29.5735295625}:{}
    candidates=[...t.matchAll(/\b(\d+(?:\.\d+)?)\s*[- ]?\s*(fl\.?\s*oz|fluid\s*ounces?|gallons?|gal|quarts?|qt|liters?|litres?|ml|l|kg|grams?|g|pounds?|lbs?|ounces?|oz)\b/g)]
      .map(m=>Number(m[1])*(conversions[m[2].replace(/[.\s]/g,'')]??NaN)).filter(n=>Number.isFinite(n)&&n>0)
  }
  if(!candidates.length)return null
  const small=Math.min(...candidates),large=Math.max(...candidates)
  if(large/small>1.02)return null
  const result=Math.floor(small*count*100)
  return Number.isSafeInteger(result)&&result>0?result:null
}

export function searchTerm(item:MissingItem):string {
  const terms:Record<string,string>={egg:'fresh large eggs 12 count',milk:'whole milk half gallon 64 fl oz',flour:'all purpose wheat flour 5 lb',tomato:'fresh tomatoes 1 lb',pasta:'dry pasta spaghetti 16 oz',garlic:'fresh garlic 8 oz',banana:'fresh bananas count',lettuce:'fresh lettuce weight',cheese:'cheddar cheese block 8 oz',butter:'unsalted butter 16 oz'}
  return terms[item.name]||`${item.name} grocery ${item.unit==='piece'?'count':item.unit==='ml'?'fl oz':'net weight'}`
}

const attributes=(raw:Record<string,unknown>)=>Array.isArray(raw.attributes)
  ?Object.fromEntries(raw.attributes.filter(a=>a&&typeof a.key==='string'&&typeof a.value==='string').map(a=>[a.key.toLowerCase(),a.value])) as Record<string,string>:{}

export function inspectOffer(raw:Record<string,unknown>,item:MissingItem,checked_at:string):{offer:Offer|null;reason:string|null} {
  const reject=(reason:string)=>({offer:null,reason})
  const title=typeof raw.title==='string'?raw.title:''
  const name=item.name.toLowerCase(),details=`${title} ${String(raw.inStockText||'')} ${JSON.stringify(raw.priceRange||'')}`.toLowerCase()
  if(!name.split(/[\s-]+/).every(term=>new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:s|es)?\\b`,'i').test(title)))return reject('different_product')
  if(/\b(?:toy|artificial|scent|candle|powdered|extract|flavo(?:r|u)red|replacement)\b/i.test(title)&&!name.includes('powder')&&!name.includes('extract'))return reject('different_product')
  if(name==='flour'&&(!/all.purpose/i.test(title)||/gluten.free|self.rising|whole.wheat|almond|coconut|cassava|chickpea|rice flour|substitute|measure for measure/i.test(title)))return reject('different_product')
  if(name==='milk'&&/almond|oat|coconut|soy|powder|condensed|evaporated/i.test(title))return reject('different_product')
  if(name==='egg'&&/liquid|dried|powder|egg white|substitute|chocolate/i.test(title))return reject('different_product')
  if(name==='tomato'&&/canned|diced|crushed|paste|sauce|dried|seeds/i.test(title))return reject('different_product')
  if(/prime.only|members?.only|subscribe|subscription|coupon|used|refurbished/.test(details))return reject('conditional_price')
  if(raw.inStock!==true||/out of stock/.test(details))return reject('unavailable')
  const price=raw.price as {value?:unknown;currency?:unknown}|undefined
  if(!['$','USD'].includes(String(price?.currency))||typeof price?.value!=='number'||price.value<=0||price.value>1000)return reject('no_public_price')
  let url:string
  try {const parsed=new URL(String(raw.url));const asin=parsed.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1];if(parsed.protocol!=='https:'||!['amazon.com','www.amazon.com'].includes(parsed.hostname)||!asin)return reject('invalid_link');url=`https://www.amazon.com/dp/${asin.toUpperCase()}`}catch{return reject('invalid_link')}
  let package_quantity=packageQuantity(title,item.unit),package_label=title
  const a=attributes(raw)
  // Net/size fields only. Shipping weight and physical box dimensions are not food amounts.
  if(!package_quantity) {
    const explicit=item.unit==='piece'?/\d+\s*[- ]?\s*(?:counts?|ct|pieces?|eggs)\b/i:item.unit==='g'?/\d+(?:\.\d+)?\s*[- ]?\s*(?:g|kg|grams?|lbs?|pounds?|oz|ounces?)\b/i:/\d+(?:\.\d+)?\s*[- ]?\s*(?:ml|l|liters?|litres?|gallons?|fl\.?\s*oz|fluid\s*ounces?)\b/i
    if(explicit.test(title))return reject('unknown_pack_size')
    const labels=['unit count','units','package size name','size'].map(key=>a[key]).filter(Boolean)
    for(const label of labels){const parsed=packageQuantity(label,item.unit);if(parsed){package_quantity=parsed;package_label=label;break}}
  }
  if(!package_quantity)return reject('unknown_pack_size')
  return {offer:{name:item.name,title,url,price_cents:Math.round(price.value*100),package_quantity,unit:item.unit,checked_at,package_label},reason:null}
}

export const normalizeOffer=(raw:Record<string,unknown>,item:MissingItem,checked_at:string)=>inspectOffer(raw,item,checked_at).offer

/** Product IDs are search candidates only: every run rechecks current price and stock. */
export function productCandidates(item:MissingItem):string[] {
  const ids:Record<string,string[]>={milk:['B000O6K8TI','B06XWL6TFW'],egg:['B0FBNVS43Q','B0F79Y7SGK'],flour:['B07Z78Q8TB','B07Z7DY1N8']}
  return (ids[item.name]||[]).map(asin=>`https://www.amazon.com/dp/${asin}`)
}
