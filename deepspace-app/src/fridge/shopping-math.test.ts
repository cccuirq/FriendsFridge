import {it,expect} from 'vitest'
import {normalizeOffer,packageQuantity,priceRecipes,candidateBatch,nearbyStores} from './shopping-math'
const item={ingredient_id:'flour',name:'flour',unit:'g',missing:10000}
const raw={title:'Amazon Grocery, All Purpose Flour, 5 Lb',url:'https://www.amazon.com/dp/B07Z7DY1N8',price:{value:2.07,currency:'$'},inStock:true}
it('converts a real five-pound flour package and charges the whole pack',()=>{
  const offer=normalizeOffer(raw,item,'2026-11-21T00:00:00Z')!
  expect(offer.package_quantity).toBe(226796)
  const result=priceRecipes([{_id:'r',title:'Bread',missing_count:1,items:[item]}],[offer],300)[0]
  expect(result).toMatchObject({total_cents:207,within_budget:true,remaining_cents:93})
  expect(result.lines[0].offer?.packs).toBe(1)
})
it('rounds purchases up to whole packages and excludes over-budget meals',()=>{
  const offer=normalizeOffer(raw,item,'now')!
  const result=priceRecipes([{_id:'r',title:'Bread',missing_count:1,items:[{...item,missing:226797}]}],[offer],413)[0]
  expect(result.total_cents).toBe(414);expect(result.within_budget).toBe(false)
})
it('never treats missing prices as free ingredients',()=>{
  const result=priceRecipes([{_id:'r',title:'Bread',missing_count:1,items:[item]}],[],5000)[0]
  expect(result).toMatchObject({total_cents:null,within_budget:false,status:'unpriced'})
})
it('supports volume and explicitly counted packs without guessing piece weights',()=>{
  expect(packageQuantity('Whole milk 1 gallon','ml')).toBe(378541)
  expect(packageQuantity('Eggs 12 count (Pack of 2)','piece')).toBe(2400)
  expect(packageQuantity('Apples 3 lb','piece')).toBeNull()
  expect(packageQuantity('Milk 1 liter 1000 ml','ml')).toBe(100000)
  expect(packageQuantity('Milk 1 liter 500 ml','ml')).toBeNull()
})
it('excludes member prices, unavailable items, incompatible products and unsafe URLs',()=>{
  expect(normalizeOffer({...raw,title:'Prime only All Purpose Flour 5 Lb'},item,'now')).toBeNull()
  expect(normalizeOffer({...raw,inStock:false},item,'now')).toBeNull()
  expect(normalizeOffer({...raw,title:'Bread Flour 5 Lb'},item,'now')).toBeNull()
  expect(normalizeOffer({...raw,url:'https://evil.example/product'},item,'now')).toBeNull()
})
it('does not substitute gluten-free or self-rising flour for standard all-purpose flour',()=>{
  for(const title of ['All-Purpose Gluten-Free Flour 3 lbs','Self Rising All Purpose Flour 5 lb','Measure for Measure All-Purpose 1:1 Substitute 3 lbs']) {
    expect(normalizeOffer({...raw,title},item,'now')).toBeNull()
  }
})

it('continues bounded recipe groups without repeating the previous group',()=>{
 const recipes=Array.from({length:9},(_,i)=>({_id:String(i),title:'Meal',missing_count:1,items:[{...item,ingredient_id:String(i),name:String(i)}]}))
 const first=candidateBatch(recipes,0),next=candidateBatch(recipes,first.coverage.next_offset!)
 expect(first.coverage.checked_recipe_ids).toEqual(['0','1','2','3']);expect(next.coverage.checked_recipe_ids).toEqual(['4','5','6','7'])
 expect(priceRecipes(recipes,[],100,new Set(['0']))[0].lines[0].reason).toBe('no_verified_offer')
 expect(priceRecipes(recipes,[],100,new Set(['0']))[1].lines[0].reason).toBe('not_checked')
})
it('filters non-retail or distant listings and sorts by distance',()=>{
 const row=(title:string,lat:number)=>({title,location:{lat,lng:0},address:'Test'})
 expect(nearbyStores([row('Market B',.02),row('WIC food bank',0),row('Market A',.01),row('Distant market',2)],{lat:0,lon:0}).map(s=>s.name)).toEqual(['Market A','Market B'])
})
