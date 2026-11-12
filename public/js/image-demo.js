import { defaultImages } from '../assets/defaults/manifest.js';
import { foodImage, imageCredit } from './food-images.js';

let loaded = 0;
let failed = 0;
function status() {
  document.querySelector('#image-status').textContent = `${loaded} of ${defaultImages.length} photos loaded${failed ? ` · ${failed} using fallback` : ''}.`;
}
for (const media of defaultImages) {
  const bar = media.category === 'drink' && media.kind === 'ingredient';
  const card = document.createElement('article'); card.className = 'card image-gallery-card';
  card.dataset.category = media.kind === 'ingredient' ? media.category : 'recipes';
  card.dataset.name = media.key;
  const picture = foodImage({ name: media.key, category: media.category }, { cover: true, kind: media.kind });
  if (media.kind !== 'ingredient') picture.classList.add('dish-picture');
  const image = picture.querySelector('img');
  image.loading = 'eager';
  image.addEventListener('load', () => { loaded++; status(); }, { once: true });
  image.addEventListener('error', () => { failed++; status(); }, { once: true });
  const title = document.createElement('h3'); title.textContent = media.kind === 'recipe' ? media.key : media.name;
  card.append(picture, title, imageCredit(media));
  document.querySelector(media.kind !== 'ingredient' ? '#recipe-gallery' : bar ? '#bar-gallery' : '#food-gallery').append(card);
}
document.querySelector('#fallback-example').append(foodImage({ name: 'Unknown vegetable', category: 'vegetable' }, { cover: true }));
status();

const category = document.querySelector('#image-category');
for (const value of [...new Set(defaultImages.filter((image) => image.kind === 'ingredient').map((image) => image.category))].sort()) {
  const option = document.createElement('option'); option.value = value; option.textContent = value.charAt(0).toUpperCase() + value.slice(1); category.append(option);
}
function filter() {
  const query = document.querySelector('#image-search').value.trim().toLowerCase();
  let visible = 0;
  for (const card of document.querySelectorAll('.image-gallery-card')) {
    card.hidden = Boolean((category.value && card.dataset.category !== category.value) || (query && !card.dataset.name.includes(query)));
    if (!card.hidden) visible++;
  }
  document.querySelector('#filter-status').textContent = `${visible} images shown`;
}
document.querySelector('#image-search').addEventListener('input', filter);
category.addEventListener('change', filter);
filter();
