import { readFileSync } from 'node:fs';

export const recognitionIngredients = JSON.parse(readFileSync(new URL('./recognition-ingredients.json', import.meta.url), 'utf8'));
