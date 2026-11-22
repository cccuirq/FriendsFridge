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

test('fridge keeps its size, scrolls food and supports image-only editing',async({users})=>{
 test.setTimeout(150000);const [a]=await users(1);await ready(a.page,'a');await a.page.emulateMedia({reducedMotion:'reduce'});await a.page.setViewportSize({width:1280,height:1000});
 const root=a.page.locator('#my-fridge-page'),list=root.locator('[data-stock]');
 await root.locator('.fridge-door-face').click();
 await expect(root.locator('[data-stock-view="list"]')).toBeEnabled();
 const before=(await api(a.page,'/api/inventory')).data;
 const foods=(await api(a.page,'/api/ingredients')).data;
 const selected=foods.filter((food:{_id:string})=>!before.some((stock:{ingredient_id:string})=>stock.ingredient_id===food._id)).slice(0,40);
 expect(selected).toHaveLength(40);const ids=new Set(selected.map((food:{_id:string})=>food._id));
 const initialHeight=(await root.locator('.fridge-cabinet').boundingBox())!.height;
 try {
  expect((await api(a.page,'/api/inventory/imports','POST',{batch_id:crypto.randomUUID(),items:selected.map((food:{_id:string})=>({ingredient_id:food._id,quantity:100}))})).status).toBe(200);
  await expect(list.locator('.stock-row')).toHaveCount(before.length+40,{timeout:15000});
  expect(Math.abs((await root.locator('.fridge-cabinet').boundingBox())!.height-initialHeight)).toBeLessThan(1);
  expect(await list.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
  await list.evaluate(el=>el.scrollTop=180);
  const liveRefresh=a.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/inventory'&&response.request().method()==='GET',{timeout:15000});await liveRefresh;
  await expect.poll(()=>list.evaluate(el=>el.scrollTop)).toBe(180);
  await root.locator('[data-stock-view="icons"]').click();
  await expect(list.locator('.stock-icon-button')).toHaveCount(before.length+40);
  await expect(list.locator('.stock-details,.stock-controls')).toHaveCount(0);
  expect(Math.abs((await root.locator('.fridge-cabinet').boundingBox())!.height-initialHeight)).toBeLessThan(1);
  const stock=(await api(a.page,'/api/inventory')).data.find((row:{ingredient_id:string})=>row.ingredient_id===selected[0]._id);
  await list.locator(`[data-stock-id="${stock._id}"] button`).click();
  const dialog=root.locator('[data-stock-dialog]');await expect(dialog).toBeVisible();
  await dialog.locator('[name="quantity"]').fill('2');await dialog.getByRole('button',{name:'Save changes',exact:true}).click();await expect(dialog).not.toBeVisible();
  await expect.poll(async()=>((await api(a.page,'/api/inventory')).data.find((row:{_id:string})=>row._id===stock._id).quantity)).toBe(200);
  await a.page.screenshot({path:'.deepspace/inventory-icons-desktop.png',fullPage:true});
  await a.page.setViewportSize({width:390,height:844});
  const mobileHeight=(await root.locator('.fridge-cabinet').boundingBox())!.height;
  expect(await a.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  expect(await list.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
  await a.page.screenshot({path:'.deepspace/inventory-icons-mobile.png',fullPage:true});
  await root.locator('[data-stock-view="list"]').click();await expect(list.locator('.stock-details')).toHaveCount(before.length+40);
  expect(Math.abs((await root.locator('.fridge-cabinet').boundingBox())!.height-mobileHeight)).toBeLessThan(1);
  await list.hover();await a.page.mouse.wheel(0,400);await expect.poll(()=>list.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  await a.page.screenshot({path:'.deepspace/inventory-list-mobile.png',fullPage:true});
  const box=await root.locator('.fridge-door-liner').boundingBox();await a.page.mouse.click(box!.x+box!.width-14,box!.y+box!.height/2);
  await expect(root.locator('.fridge-door')).toHaveAttribute('aria-expanded','false');await expect(root.locator('.fridge-inside')).toHaveAttribute('inert','');
 }finally{
  const added=(await api(a.page,'/api/inventory')).data.filter((row:{ingredient_id:string})=>ids.has(row.ingredient_id));
  for(let i=0;i<added.length;i+=8)await Promise.all(added.slice(i,i+8).map(async(row:{_id:string;quantity:number})=>expect((await api(a.page,`/api/inventory/${row._id}`,'DELETE',{expected_quantity:row.quantity})).status).toBe(200)));
 }
});
