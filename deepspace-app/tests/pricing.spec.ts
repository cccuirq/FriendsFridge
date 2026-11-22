import { test, expect } from 'deepspace/testing'
import type { Page } from '@playwright/test'

async function ready(page: Page, suffix: string) {
  await page.goto('/home')
  await expect(page.locator('[name="username"], [data-testid="fridge-workspace"]').first()).toBeVisible({timeout:30000})
  if (await page.locator('.native-fridge-onboarding form').count()) {
    await page.locator('[name="username"]').fill(`fridgeqa_${suffix}`)
    await page.locator('[name="display_name"]').fill(`Fridge QA ${suffix}`)
    await page.locator('[name="email"]').fill(`fridgeqa_${suffix}@example.com`)
    await page.getByRole('button',{name:'Open my fridge'}).click()
  }
  await expect(page.getByTestId('fridge-workspace')).toBeVisible()
  await page.waitForFunction(() => Boolean(window.fridgeAuth))
  await expect(page.locator('#account-menu')).toBeVisible()
  await expect(page.locator('#notice')).not.toContainText('could not load')
}
async function api(page: Page, path: string, method='GET', body?: unknown) {
  return page.evaluate(async ({path,method,body}) => {
    const token = await window.fridgeAuth.getToken()
    const response = await fetch(path,{method,headers:{Authorization:`Bearer ${token}`,...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined})
    return {status:response.status,...await response.json()}
  },{path,method,body})
}

test('real public pack prices produce a complete meal and explain unknown prices',async({users})=>{
 test.skip(process.env.FRIDGE_SHOPPING_LIVE!=='1','Opt-in real retailer lookup; consumes bounded credits.');test.setTimeout(240000);
 const [a]=await users(1);await ready(a.page,'a');
 const foods=(await api(a.page,'/api/ingredients')).data;
 const names=['egg','milk','flour'];const selected=names.map(name=>foods.find((food:{name:string})=>food.name===name));
 const inventory=(await api(a.page,'/api/inventory')).data;
 const prior=selected.map(food=>inventory.find((stock:{ingredient_id:string})=>stock.ingredient_id===food._id));
 let recipeId:string|undefined;const title=`A Pancake price QA ${Date.now().toString(36)}`;
 try {
  for(const stock of prior)if(stock)expect((await api(a.page,`/api/inventory/${stock._id}`,'PATCH',{quantity:0,expected_quantity:stock.quantity})).status).toBe(200);
  const created=await api(a.page,'/api/recipes','POST',{title,instructions:'Whisk, pan fry and cook through.',servings:2,items:selected.map((food,i)=>({ingredient_id:food._id,quantity:[200,20000,15000][i]}))});expect(created.status).toBe(201);recipeId=created.data._id;
  await a.page.locator('.main-nav a[href="#recipes"]').click();await a.page.getByRole('button',{name:'Buy within budget',exact:true}).click();
  await a.page.locator('#meal-budget').fill('15.00');
  const finished=a.page.waitForResponse(async response=>response.url().includes('/api/recipes/shopping/')&&response.status()===200&&(await response.json()).data?.status==='complete',{timeout:180000});
  await a.page.getByRole('button',{name:'Find meals in budget',exact:true}).click();const result=(await (await finished).json()).data;
  const meal=result.recommendations.find((row:{recipe_id:string})=>row.recipe_id===recipeId);
  expect(meal,JSON.stringify(meal)).toMatchObject({status:'priced',within_budget:true});expect(meal.total_cents).toBeGreaterThan(0);expect(meal.total_cents).toBeLessThanOrEqual(1500);
  expect(meal.lines).toHaveLength(3);expect(meal.lines.every((line:{offer:unknown})=>line.offer)).toBe(true);
  await expect(a.page.locator('#meal-budget-status')).toContainText('Listings checked');await expect(a.page.locator('#meal-coverage')).toContainText('6 search listings');
  await a.page.getByRole('button',{name:`View recipe: ${title}`,exact:true}).click();await expect(a.page.locator('.purchase-food-option')).toHaveCount(3);
  await a.page.screenshot({path:'.deepspace/verified-meal-price.png',fullPage:true});
  const path=process.env.FRIDGE_TEST_URL?'.deepspace/verified-meal-live.json':'.deepspace/verified-meal-local.json';
  const {writeFile}=await import('node:fs/promises');await writeFile(path,JSON.stringify({meal,summary:result.summary,coverage:result.coverage,checked_at:result.checked_at},null,2));
 }finally{
  if(recipeId)await api(a.page,`/api/recipes/${recipeId}`,'DELETE');
  for(let i=0;i<selected.length;i++){const stock=(await api(a.page,'/api/inventory')).data.find((row:{ingredient_id:string})=>row.ingredient_id===selected[i]._id);if(stock)await api(a.page,`/api/inventory/${stock._id}`,prior[i]?'PATCH':'DELETE',prior[i]?{quantity:prior[i].quantity,expected_quantity:stock.quantity,visibility:prior[i].visibility}:{expected_quantity:stock.quantity});}
 }
});
