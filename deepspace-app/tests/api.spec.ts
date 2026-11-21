import {test,expect} from '@playwright/test'
test('private business APIs reject unsigned and forged identities',async({request})=>{
  expect((await request.get('/api/health')).ok()).toBe(true)
  for(const path of ['/api/users/me','/api/inventory','/api/friends','/api/recipes','/api/ingredients','/api/recipes/shopping/jobs/00000000-0000-4000-8000-000000000000']){
    expect((await request.get(path,{headers:{'x-fridge-subject':'forged','X-FF-User':'forged'}})).status()).toBe(401)
  }
})
