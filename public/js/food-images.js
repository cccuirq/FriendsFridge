import { defaultImages } from '../assets/defaults/manifest.js';

const icons = { fruit: '🍎', vegetable: '🥕', dairy: '🥛', protein: '🥚', grain: '🌾', pantry: '🫙', drink: '🧃' };
const aliases = { eggs: 'egg', tomatoes: 'tomato', carrots: 'carrot', 'white rum': 'rum' };
export function findFoodImage(name, kind = 'ingredient') {
  const normalized = typeof name === 'string' ? name.trim().toLowerCase() : '';
  const key = kind === 'ingredient' ? aliases[normalized] || normalized : normalized;
  return defaultImages.find((entry) => entry.kind === kind && entry.key === key)
    || (kind === 'recipe' ? defaultImages.find((entry) => entry.kind === 'drink' && entry.key === key) : null) || null;
}

export function imageCredit(media) {
  const credit = document.createElement('small'); credit.className = 'image-attribution';
  const source = document.createElement('a'); source.href = media.source; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = media.provider;
  credit.append(source);
  if (media.author) credit.append(document.createTextNode(' · ' + media.author));
  if (media.license) {
    credit.append(document.createTextNode(' · '));
    const license = document.createElement('a'); license.textContent = media.license;
    if (/^https?:\/\//.test(media.license_url || '')) { license.href = media.license_url; license.target = '_blank'; license.rel = 'noopener noreferrer'; }
    credit.append(license);
  }
  return credit;
}

export function foodImage(ingredient, { cover = false, kind = 'ingredient' } = {}) {
  const wrapper = document.createElement('span');
  wrapper.className = cover ? 'food-picture food-picture-cover' : 'food-picture';
  wrapper.setAttribute('role', 'img');
  wrapper.setAttribute('aria-label', ingredient.name || 'Food');
  const fallback = document.createElement('span');
  fallback.className = 'food-picture-fallback';
  fallback.textContent = icons[ingredient.category] || (kind === 'drink' ? '🍹' : '🍽️');
  fallback.setAttribute('aria-hidden', 'true');
  wrapper.append(fallback);
  const media = findFoodImage(ingredient.name, kind);
  if (media) {
    wrapper.title = `Illustration from ${media.provider}${media.author ? ' · ' + media.author : ''}${media.license ? ' · ' + media.license : ''}`;
    const image = document.createElement('img');
    image.alt = '';
    image.width = image.height = cover ? 240 : 72;
    image.loading = 'lazy'; image.decoding = 'async';
    image.addEventListener('load', () => { fallback.hidden = true; image.classList.add('is-loaded'); }, { once: true });
    image.addEventListener('error', () => { image.remove(); fallback.hidden = false; }, { once: true });
    wrapper.append(image); image.src = media.src;
  }
  return wrapper;
}

export function recipeFigure(recipe) {
  const figure = document.createElement('figure'); figure.className = 'recipe-picture';
  const image = foodImage({ name: recipe.title }, { cover: true, kind: 'recipe' });
  const caption = document.createElement('figcaption');
  const media = findFoodImage(recipe.title, 'recipe');
  if (media) {
    caption.append(document.createTextNode('Illustration · '), imageCredit(media));
  } else caption.textContent = 'Recipe illustration';
  figure.append(image, caption); return figure;
}
