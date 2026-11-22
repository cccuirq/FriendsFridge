import sample from './data/price-sample-2026-11-22.json'
import {it,expect} from 'vitest'
import {normalizeOffer,packageQuantity,priceRecipes,inspectOffer,candidateBatch} from './shopping-math'
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

it('reads hyphenated quantities, litre symbols and counted dozen packs',()=>{
 expect(packageQuantity('Flour 16-Ounce (Pack of 2)','g')).toBe(90718)
 expect(packageQuantity('Milk 2 x 1 L','ml')).toBe(200000)
 expect(packageQuantity('Eggs 2 dozen','piece')).toBe(2400)
})
it('uses declared net size, not shipping weight or box dimensions',()=>{
 const value=normalizeOffer({...raw,title:'All Purpose Flour',attributes:[{key:'Unit Count',value:'80 Ounce'},{key:'Item Package Weight',value:'3 kg'}]},item,'now')
 expect(value?.package_quantity).toBe(226796)
 expect(normalizeOffer({...raw,title:'All Purpose Flour',attributes:[{key:'Item Package Weight',value:'3 kg'}]},item,'now')).toBeNull()
})
it('does not override contradictory title measurements using metadata',()=>{
 expect(normalizeOffer({...raw,title:'All Purpose Flour 1 kg 500 g',attributes:[{key:'Unit Count',value:'1 kg'}]},item,'now')).toBeNull()
})
it('rejects flour substitutes and explains unavailable or unmeasurable results',()=>{
 expect(normalizeOffer({...raw,title:'All Purpose Gluten-Free Flour 5 lb'},item,'now')).toBeNull()
 expect(inspectOffer({...raw,inStock:false},item,'now').reason).toBe('unavailable')
 expect(inspectOffer({...raw,title:'All Purpose Flour'},item,'now').reason).toBe('unknown_pack_size')
})
it('keeps unchecked recipes distinct and advances the next bounded group',()=>{
 const recipes=Array.from({length:6},(_,i)=>({_id:String(i),title:'Meal',missing_count:1,items:[{...item,ingredient_id:String(i)}]}))
 expect(candidateBatch(recipes,0).coverage.next_offset).toBe(4)
 expect(candidateBatch(recipes,4).coverage.checked_recipe_ids).toEqual(['4','5'])
 expect(priceRecipes(recipes,[],1500,new Set())[0].lines[0].reason).toBe('not_checked')
})

it('prices a complete pancake purchase under $15 using real captured listings',()=>{
 const items=[{ingredient_id:'egg',name:'egg',unit:'piece',missing:200},{ingredient_id:'milk',name:'milk',unit:'ml',missing:20000},{ingredient_id:'flour',name:'flour',unit:'g',missing:15000}]
 const offers=items.flatMap(item=>sample.flatMap(row=>{const offer=normalizeOffer(row,item,'2026-11-22T00:00:00Z');return offer?[offer]:[]}))
 const result=priceRecipes([{_id:'pancakes',title:'Pancakes',missing_count:3,items}],offers,1500)[0]
 expect(result.within_budget).toBe(true);expect(result.total_cents).toBeLessThanOrEqual(1262)
 expect(result.lines.every(line=>line.offer?.packs===1)).toBe(true)
 expect(result.lines.find(line=>line.name==='egg')?.offer?.price_cents).toBe(276)
})

it('does not discard later recipes when a group reaches its food limit',()=>{
 const recipes=Array.from({length:4},(_,r)=>({_id:String(r),title:'Meal',missing_count:3,items:Array.from({length:3},(_,i)=>({...item,ingredient_id:`${r}-${i}`}))}))
 const first=candidateBatch(recipes,0);expect(first.coverage.checked_recipe_ids).toEqual(['0','1']);expect(first.coverage.next_offset).toBe(2)
 expect(candidateBatch(recipes,2).coverage.checked_recipe_ids).toEqual(['2','3'])
})
