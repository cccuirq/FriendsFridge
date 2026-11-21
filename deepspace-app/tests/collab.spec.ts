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
