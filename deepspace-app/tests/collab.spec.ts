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

test('two native accounts complete the full sharing journey', async ({users}) => {
  test.setTimeout(120000)
  const [a,b] = await users(2)
  const errors:string[]=[]
  a.page.on('pageerror',error=>errors.push(error.message))
  await ready(a.page,'a'); await ready(b.page,'b')
  const alice = (await api(a.page,'/api/users/me')).data
  const bob = (await api(b.page,'/api/users/me')).data
  expect(alice._id).not.toBe(bob._id)
  expect(alice.auth_id).toBeUndefined()
  const foods = (await api(a.page,'/api/ingredients')).data
  expect(foods).toHaveLength(212)
  const egg = foods.find((f: {name:string})=>f.name==='egg')._id
  const search = await api(a.page,`/api/users?q=${bob.username}`)
  expect(search.data.some((u:{_id:string})=>u._id===bob._id)).toBe(true)
  expect(search.data[0].email).toBeUndefined()
  const friends = await api(a.page,'/api/friends')
  if (friends.data.some((f:{user:{_id:string}})=>f.user._id===bob._id)) await api(a.page,`/api/friends/${bob._id}`,'DELETE')
  const invite = await api(a.page,'/api/friends/requests','POST',{user_id:bob._id})
  expect(invite.status).toBe(201)
  expect((await api(a.page,`/api/friends/requests/${invite.data._id}`,'PATCH',{status:'accepted'})).status).toBe(404)
  expect((await api(b.page,`/api/friends/requests/${invite.data._id}`,'PATCH',{status:'accepted'})).status).toBe(200)
  const addition = {batch_id:crypto.randomUUID(),ingredient_id:egg,quantity:500,visibility:'friends'}
  expect((await api(a.page,'/api/inventory','POST',addition)).status).toBe(200)
  expect((await api(a.page,'/api/inventory','POST',addition)).data.replayed).toBe(true)
  let ownerStock = (await api(a.page,'/api/inventory')).data.find((r:{ingredient_id:string})=>r.ingredient_id===egg)
  await api(a.page,`/api/inventory/${ownerStock._id}`,'PATCH',{visibility:'friends'})
  const shared = await api(b.page,`/api/friends/${alice._id}/fridge`)
  expect(shared.data.items.some((i:{ingredient:{_id:string}})=>i.ingredient._id===egg)).toBe(true)
  const message_id = crypto.randomUUID()
  const msg = {message_id,text:'Dinner together?'}
  expect((await api(a.page,`/api/friends/${bob._id}/conversation`,'POST',msg)).status).toBe(201)
  await api(a.page,`/api/friends/${bob._id}/conversation`,'POST',msg)
  const chat = (await api(b.page,`/api/friends/${alice._id}/conversation`)).data
  expect(chat.items.filter((m:{_id:string})=>m._id===message_id)).toHaveLength(1)
  expect((await api(b.page,'/api/friends/conversations/unread')).data).toContain(alice._id)
  await api(b.page,`/api/friends/${alice._id}/conversation/read`,'POST',{through:chat.received})
  expect((await api(b.page,'/api/friends/conversations/unread')).data).not.toContain(alice._id)
  const before = ownerStock.quantity
  const borrow = await api(b.page,'/api/friends/ingredient-requests','POST',{owner_id:alice._id,ingredient_id:egg,quantity:200,message:'Two eggs please'})
  expect(borrow.status).toBe(201)
  const borrowPath = `/api/friends/ingredient-requests/${borrow.data._id}`
  expect((await api(b.page,borrowPath,'PATCH',{status:'accepted'})).status).toBe(409)
  expect((await api(a.page,borrowPath,'PATCH',{status:'accepted'})).status).toBe(200)
  const completed = await Promise.all([api(a.page,borrowPath,'PATCH',{status:'completed'}),api(a.page,borrowPath,'PATCH',{status:'completed'})])
  expect(completed.map(r=>r.status).sort()).toEqual([200,409])
  ownerStock = (await api(a.page,'/api/inventory')).data.find((r:{ingredient_id:string})=>r.ingredient_id===egg)
  expect(ownerStock.quantity).toBe(before-200)
  expect((await api(b.page,`/api/inventory/${ownerStock._id}`,'PATCH',{visibility:'friends'})).status).toBe(404)
  const recipe = await api(a.page,'/api/recipes','POST',{title:'QA eggs',instructions:'Cook gently.',servings:1,items:[{ingredient_id:egg,quantity:100}],image:{content_type:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII='}})
  expect(recipe.status).toBe(201)
  const rid=recipe.data._id
  const imageStatus = (page:Page) => page.evaluate(async rid=>(await fetch(`/api/recipes/${rid}/image`)).status,rid)
  expect(await imageStatus(a.page)).toBe(200)
  expect(await imageStatus(b.page)).toBe(404)
  expect((await api(b.page,`/api/recipes/${rid}/saved`,'PUT')).status).toBe(404)
  const share=await api(a.page,`/api/recipes/${rid}/shares`,'POST',{recipient_id:bob._id})
  expect((await api(b.page,`/api/recipes/shares/${share.data._id}`,'PATCH',{status:'accepted'})).status).toBe(200)
  expect(await imageStatus(b.page)).toBe(200)
  expect((await api(b.page,`/api/recipes/${rid}/saved`,'PUT')).status).toBe(200)
  expect((await api(b.page,'/api/recipes')).data.recipes.find((r:{_id:string})=>r._id===rid).saved).toBe(true)
  expect((await api(b.page,`/api/recipes/shares/${share.data._id}`,'PATCH',{status:'removed'})).status).toBe(200)
  expect((await api(b.page,'/api/recipes')).data.recipes.some((r:{_id:string})=>r._id===rid)).toBe(false)
  expect(await imageStatus(b.page)).toBe(404)
  await api(a.page,`/api/recipes/${rid}`,'DELETE')
  await api(a.page,`/api/friends/${bob._id}`,'DELETE')
  expect((await api(b.page,`/api/friends/${alice._id}/fridge`)).status).toBe(404)
  await a.page.reload()
  await expect(a.page.getByTestId('fridge-workspace')).toBeVisible()
  await expect(a.page.locator('#account-menu')).toBeVisible()
  for(const tab of ['recognition','recipes','friends','my-fridge']) {
    await a.page.locator(`.main-nav a[href="#${tab}"]`).click()
    await expect(a.page.locator('#notice')).not.toContainText(/could not|unable|error/i)
  }
  await a.page.screenshot({path:'.deepspace/fridge-workspace.png',fullPage:true})
  if(process.env.FRIDGE_VISION_LIVE==='1') {
    await a.page.locator('.main-nav').getByRole('link',{name:'Photo Recognition',exact:true}).click()
    await a.page.locator('#ingredient-photo').setInputFiles('public/legacy/assets/defaults/ingredient-apple.png')
    await a.page.locator('#recognition-page [data-recognize]').click()
    await expect(a.page.locator('#recognition-page [data-status]')).toContainText('model detection',{timeout:60000})
    await expect(a.page.locator('#recognition-page [data-rows] input[name="ingredient"]').first()).toHaveValue('apple')
    await a.page.screenshot({path:'.deepspace/fridge-recognition.png',fullPage:true})
  }
  expect(errors).toEqual([])
})

test('manual fridge door, friend borrowing and meal-planner layout',async({users})=>{
  test.setTimeout(240000)
  const [a,b]=await users(2)
  await ready(a.page,'a');await ready(b.page,'b')
  await a.page.emulateMedia({reducedMotion:'reduce'})
  const door=a.page.getByRole('button',{name:'Open fridge door',exact:true})
  await expect(door).toHaveAttribute('aria-expanded','false')
  await a.page.locator('.fridge-freezer').click()
  await expect(door).toHaveAttribute('aria-expanded','false')
  await a.page.locator('.fridge-door-face').click()
  const close=a.page.getByRole('button',{name:'Close fridge door',exact:true})
  await expect(close).toHaveAttribute('aria-expanded','true')
  await a.page.locator('.fridge-inside').click()
  await expect(close).toHaveAttribute('aria-expanded','true')
  const box=await a.page.locator('.fridge-door-liner').boundingBox()
  expect(box).toBeTruthy()
  await a.page.mouse.click(box!.x+box!.width-14,box!.y+box!.height/2)
  await expect(a.page.getByRole('button',{name:'Open fridge door',exact:true})).toHaveAttribute('aria-expanded','false')
  const alice=(await api(a.page,'/api/users/me')).data,bob=(await api(b.page,'/api/users/me')).data
  const food=(await api(a.page,'/api/ingredients')).data.find((r:{name:string})=>r.name==='flour')
  const priorA=(await api(a.page,'/api/inventory')).data.find((r:{ingredient_id:string})=>r.ingredient_id===food._id)
  const priorB=(await api(b.page,'/api/inventory')).data.find((r:{ingredient_id:string})=>r.ingredient_id===food._id)
  const testTitle=`Budget flour QA ${Date.now().toString(36)}`
  let rid:string|undefined
  try {
  if(priorA)expect((await api(a.page,`/api/inventory/${priorA._id}`,'PATCH',{quantity:0,expected_quantity:priorA.quantity})).status).toBe(200)
  const existingFriends=(await api(a.page,'/api/friends')).data
  if(existingFriends.some((row:{user:{_id:string}})=>row.user._id===bob._id))await api(a.page,`/api/friends/${bob._id}`,'DELETE')
  const invite=await api(a.page,'/api/friends/requests','POST',{user_id:bob._id})
  expect(invite.status).toBe(201)
  expect((await api(b.page,`/api/friends/requests/${invite.data._id}`,'PATCH',{status:'accepted'})).status).toBe(200)
  expect((await api(b.page,'/api/inventory','POST',{batch_id:crypto.randomUUID(),ingredient_id:food._id,quantity:50000,visibility:'friends'})).status).toBe(200)
  const source=(await api(b.page,'/api/inventory')).data.find((r:{ingredient_id:string})=>r.ingredient_id===food._id)
  expect((await api(b.page,`/api/inventory/${source._id}`,'PATCH',{visibility:'friends'})).status).toBe(200)
  const recipe=await api(a.page,'/api/recipes','POST',{title:testTitle,instructions:'Check quantities before cooking.',servings:1,items:[{ingredient_id:food._id,quantity:10000}]})
  expect(recipe.status).toBe(201)
  rid=recipe.data._id
  expect((await api(a.page,'/api/recipes?servings=2')).data.recipes.find((row:{_id:string})=>row._id===rid).can_borrow).toBe(true)
  await a.page.locator('.main-nav a[href="#recipes"]').click()
  await a.page.getByRole('button',{name:'Borrow from friends',exact:true}).click()
  await a.page.getByRole('button',{name:`View recipe: ${testTitle}`,exact:true}).click({timeout:15000})
  await expect(a.page.locator('.borrow-food-option')).toContainText(bob.display_name)
  await a.page.locator('.borrow-food-option').getByRole('button',{name:'Ask to borrow'}).click()
  await expect(a.page.locator('.borrow-food-option')).toContainText('Request sent')
  const requests=(await api(a.page,'/api/friends/ingredient-requests')).data
  const request=requests.find((r:{requester_id:string;owner_id:string;ingredient_id:string;status:string})=>r.requester_id===alice._id&&r.owner_id===bob._id&&r.ingredient_id===food._id&&r.status==='pending')
  expect(request.quantity).toBe(20000)
  await api(a.page,`/api/friends/ingredient-requests/${request._id}`,'PATCH',{status:'cancelled'})
  await a.page.locator('#recipe-detail [data-recipe-back]').click()
  await a.page.getByRole('button',{name:'Buy within budget',exact:true}).click()
  await expect(a.page.locator('#budget-panel')).toBeVisible()
  await expect(a.page.locator('#budget-panel')).toContainText('No Prime')
  await a.page.screenshot({path:'.deepspace/meal-planner-desktop.png',fullPage:true})
  if(process.env.FRIDGE_SHOPPING_LIVE==='1') {
    await a.page.locator('#meal-budget').fill('20.00')
    const firstResponse=a.page.waitForResponse(response=>response.url().endsWith('/api/recipes/shopping/quote')&&response.request().method()==='POST')
    await a.page.getByRole('button',{name:'Find meals in budget'}).click()
    const response=await firstResponse,started=await response.json()
    if(started.data?.job_id) {
      expect((await api(b.page,`/api/recipes/shopping/jobs/${started.data.job_id}`)).status).toBe(404)
      const replay=await api(a.page,'/api/recipes/shopping/quote','POST',response.request().postDataJSON())
      expect(replay.data.job_id).toBe(started.data.job_id)
    }
    await expect(a.page.locator('#meal-budget-status')).toContainText(/Listings checked|No estimated prices were used/,{timeout:180000})
    await expect(a.page.locator('#meal-budget-status')).toContainText('Listings checked')
    await a.page.getByRole('button',{name:`View recipe: ${testTitle}`,exact:true}).click({timeout:15000})
    await expect(a.page.locator('.purchase-food-option')).toContainText(/all.?purpose flour/i)
    await a.page.screenshot({path:'.deepspace/meal-planner-live-prices.png',fullPage:true})
    await a.page.locator('#recipe-detail [data-recipe-back]').click()
    await a.page.locator('.nearby-shops summary').click()
    await a.page.locator('#meal-city').fill('Chicago, US')
    await a.page.getByRole('button',{name:'Find nearby shops',exact:true}).click()
    await expect(a.page.locator('#meal-location-status')).toContainText('nearby listings',{timeout:180000})
    await expect(a.page.locator('#meal-shops li').first()).toBeVisible()
    await a.page.screenshot({path:'.deepspace/meal-planner-nearby.png',fullPage:true})
    await a.page.context().grantPermissions(['geolocation'])
    await a.page.context().setGeolocation({latitude:41.88,longitude:-87.62})
    await a.page.getByRole('button',{name:'Use my location',exact:true}).click()
    await expect(a.page.locator('#meal-location-status')).toContainText('nearby listings',{timeout:60000})
  }
  await a.page.setViewportSize({width:390,height:844})
  await a.page.screenshot({path:'.deepspace/meal-planner-mobile.png',fullPage:true})
  expect(await a.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false)
  } finally {
    if(rid)await api(a.page,`/api/recipes/${rid}`,'DELETE')
    await api(a.page,`/api/friends/${bob._id}`,'DELETE')
    for(const [page,prior] of [[a.page,priorA],[b.page,priorB]] as const) {
      const current=(await api(page,'/api/inventory')).data.find((row:{ingredient_id:string})=>row.ingredient_id===food._id)
      if(current)await api(page,`/api/inventory/${current._id}`,prior?'PATCH':'DELETE',prior?{quantity:prior.quantity,expected_quantity:current.quantity,visibility:prior.visibility}:{expected_quantity:current.quantity})
    }
  }
})
