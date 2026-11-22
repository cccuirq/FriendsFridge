import {describe,it,expect,beforeEach} from 'vitest'
import {command,initialState,quantity,DomainError,type State,type Body} from './domain'

describe('fridge domain invariants',()=>{
  let state:State
  const run=(actor:string,path:string,method='GET',body:Body={})=>command(state,actor,method,new URL(path,'https://fridge.test'),body)
  beforeEach(()=>{state=initialState();for(const who of ['alice','bob'])run(who,'/api/users/me','POST',{username:who,email:`${who}@example.com`,display_name:who})})
  it('seeds all ingredients and valid recipe references',()=>{
    expect(state.ingredients).toHaveLength(212)
    expect(state.recipes).toHaveLength(11)
    for(const recipe of state.recipes) for(const item of recipe.items) expect(state.ingredients.some(i=>i._id===item.ingredient_id)).toBe(true)
  })
  it.each([-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'100'])('rejects invalid fixed point quantity %s',value=>expect(()=>quantity(value)).toThrow(DomainError))
  it('does not accept a client supplied ownership identity',()=>{
    expect(()=>run('alice','/api/inventory','POST',{user_id:state.profiles[1]._id})).toThrow('Unexpected field')
  })
  it('keeps private stock hidden and prevents stale edits',()=>{
    const alice=state.profiles[0],bob=state.profiles[1],ingredient=state.ingredients[0]
    const invitation=run('alice','/api/friends/requests','POST',{user_id:bob._id}).data as {_id:string}
    run('bob',`/api/friends/requests/${invitation._id}`,'PATCH',{status:'accepted'})
    run('alice','/api/inventory','POST',{batch_id:crypto.randomUUID(),ingredient_id:ingredient._id,quantity:200})
    expect((run('bob',`/api/friends/${alice._id}/fridge`).data as {items:unknown[]}).items).toEqual([])
    const stock=state.stock[0]
    expect(()=>run('alice',`/api/inventory/${stock._id}`,'PATCH',{quantity:100,expected_quantity:300})).toThrow('Stock changed')
    expect(stock.quantity).toBe(200)
  })
  it('rejects duplicate imports with changed contents',()=>{
    const batch_id=crypto.randomUUID(),ingredient_id=state.ingredients[0]._id
    run('alice','/api/inventory/imports','POST',{batch_id,items:[{ingredient_id,quantity:100}]})
    expect(()=>run('alice','/api/inventory/imports','POST',{batch_id,items:[{ingredient_id,quantity:200}]})).toThrow('different contents')
    expect(state.stock[0].quantity).toBe(100)
  })
  it('caps recognition attempts before invoking a billed service',()=>{
    for(let i=0;i<10;i++)run('alice','/api/_vision/quota','POST')
    expect(()=>run('alice','/api/_vision/quota','POST')).toThrow('Daily cloud recognition limit')
  })
  it('recommends borrowing only from accepted friends with shared stock, scaled to servings',()=>{
    const a=state.profiles[0],b=state.profiles[1],ingredient=state.ingredients[0]
    const invitation=run('alice','/api/friends/requests','POST',{user_id:b._id}).data as {_id:string}
    run('bob',`/api/friends/requests/${invitation._id}`,'PATCH',{status:'accepted'})
    run('bob','/api/inventory','POST',{batch_id:crypto.randomUUID(),ingredient_id:ingredient._id,quantity:400,visibility:'private'})
    const recipe=run('alice','/api/recipes','POST',{title:'Shared eggs',instructions:'Cook',servings:2,items:[{ingredient_id:ingredient._id,quantity:200}]}).data as {_id:string}
    const find=()=>((run('alice','/api/recipes?servings=4').data as {recipes:Array<{_id:string;can_borrow:boolean;items:Array<{required:number;base_required:number;borrow_sources:unknown[]}>}>}).recipes.find(r=>r._id===recipe._id)!)
    expect(find().can_borrow).toBe(false)
    run('bob',`/api/inventory/${state.stock[0]._id}`,'PATCH',{visibility:'friends'})
    expect(find().can_borrow).toBe(true);expect(find().items[0]).toMatchObject({required:400,base_required:200})
    run('alice',`/api/friends/${b._id}`,'DELETE')
    expect(find().can_borrow).toBe(false);expect(find().items[0].borrow_sources).toEqual([])
    expect(a._id).not.toBe(b._id)
  })
  it('exports only the current account data and excludes native identities',()=>{
    run('bob','/api/inventory','POST',{batch_id:crypto.randomUUID(),ingredient_id:state.ingredients[0]._id,quantity:100})
    const data=run('alice','/api/users/me/export').data as {user:Record<string,unknown>;inventory:unknown[];messages:unknown[]}
    expect(data.user.username).toBe('alice');expect(data.user.auth_id).toBeUndefined();expect(data.inventory).toEqual([]);expect(data.messages).toEqual([])
  })
  it('deduplicates borrow retries and rejects changed contents',()=>{
    const bob=state.profiles[1],food=state.ingredients[0]
    const invitation=run('alice','/api/friends/requests','POST',{user_id:bob._id}).data as {_id:string}
    run('bob',`/api/friends/requests/${invitation._id}`,'PATCH',{status:'accepted'})
    run('bob','/api/inventory','POST',{batch_id:crypto.randomUUID(),ingredient_id:food._id,quantity:400,visibility:'friends'})
    const body={request_id:crypto.randomUUID(),owner_id:bob._id,ingredient_id:food._id,quantity:200}
    const first=run('alice','/api/friends/ingredient-requests','POST',body)
    expect(run('alice','/api/friends/ingredient-requests','POST',body).data).toEqual(first.data)
    expect(state.requests).toHaveLength(1)
    expect(()=>run('alice','/api/friends/ingredient-requests','POST',{...body,quantity:300})).toThrow('different contents')
  })

})
