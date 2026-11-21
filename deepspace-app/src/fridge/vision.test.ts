import {it,expect} from 'vitest'
import {parseSuggestions} from './vision'
it('accepts only listed ingredients and finite, correctly ordered boxes',()=>{
  const detections=parseSuggestions(JSON.stringify({detections:[{name:'apple',box:[0,0,500,500]},{name:'unlisted food',box:[0,0,500,500]},{name:'egg',box:[500,0,0,500]},{name:'egg',box:[0,0,Infinity,500]}]}))
  expect(detections).toHaveLength(1)
  expect(detections[0]).toMatchObject({name:'apple',confidence:null,review_required:true})
})
it('rejects malformed or truncated model output rather than inventing detections',()=>{
  expect(()=>parseSuggestions('{"detections":[')).toThrow()
  expect(()=>parseSuggestions('{"detections":"apple"}')).toThrow()
})
