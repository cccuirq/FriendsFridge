import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { recognizeIngredients } from '../fridge/vision'
export const actions: Record<string, ActionHandler<Env>> = { recognizeIngredients }
