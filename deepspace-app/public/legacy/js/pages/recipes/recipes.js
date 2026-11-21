import { recipeFigure } from '../../food-images.js';
import { createMealPlanner } from './meal-planner.js';
const plural = (count, label) => `${count} ${label}${count === 1 ? '' : 's'}`;
const titleCase = (name) => name.charAt(0).toUpperCase() + name.slice(1);
const endpoint = '/api/recipes';
const emptyMessages = {
  all: 'No recipes yet. Create one to get started.',
  ready: 'None of these recipes match everything in your fridge yet.',
  saved: 'Save a recipe to find it here later.',
  owned: 'Create a recipe to add it to this list.',
  shared: 'No recipes have been shared with you yet.',
};

function badge(text, ready) {
  const span = document.createElement('span');
  span.className = ready ? 'pill recipe-badge ready' : 'pill recipe-badge';
  span.textContent = text;
  return span;
}

export function createRecipesPage(root, { api, measure }) {
  const $ = (selector) => root.querySelector(selector);
  const browse = $('#recipe-browse');
  const detail = $('#recipe-detail');
  const editor = $('#recipe-create');
  const filters = [...root.querySelectorAll('[data-recipe-filter]')];
  const form = $('#recipe-form');
  const shareForm = $('#recipe-share');
  const save = $('#recipe-save');
  const create = $('#recipe-new');
  const retry = $('#recipe-retry');
  const results = $('#recipe-results');
  const status = $('#recipe-status');
  const detailStatus = $('#recipe-action-status');
  const formStatus = $('#recipe-form-status');
  const photo = $('#recipe-photo');
  const photoPreview = $('#recipe-photo-preview');
  let photoUrl;
  let photoVersion = 0;
  let version = 0;
  let data;
  let selected;
  let filter = 'all';
  let busy = false;
  let editing;
  let removeImage = false;
  const planner = createMealPlanner(root, { api, measure, changed: reason => {
    if (reason === 'servings') { selected = undefined; show(browse); load(); }
    else renderList();
  } });

  function showExistingPhoto() {
    if (editing?.image_url && !removeImage) {
      photoPreview.src = editing.image_url;
      photoPreview.hidden = false;
      $('#recipe-photo-name').textContent = 'Current photo';
      $('#recipe-photo-remove').hidden = false;
    }
  }

  function clearPhoto() {
    photoVersion++;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = undefined;
    photo.value = '';
    photo.setCustomValidity('');
    photoPreview.removeAttribute('src');
    photoPreview.hidden = true;
    $('#recipe-photo-remove').hidden = true;
    $('#recipe-photo-name').textContent = 'No file chosen';
  }

  photo.addEventListener('change', async () => {
    const file = photo.files[0];
    const token = ++photoVersion;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = undefined;
    photoPreview.hidden = true;
    photoPreview.removeAttribute('src');
    $('#recipe-photo-name').textContent = file?.name || 'No file chosen';
    $('#recipe-photo-remove').hidden = !file;
    formStatus.textContent = '';
    if (!file) { showExistingPhoto(); return; }
    try {
      if (!['image/jpeg', 'image/png'].includes(file.type) || !/\.(jpe?g|png)$/i.test(file.name)) throw new Error('Choose a JPG or PNG image.');
      if (!file.size || file.size > 2 * 1024 * 1024) throw new Error('Choose a non-empty image no larger than 2 MB.');
      const bitmap = await createImageBitmap(file);
      const pixels = bitmap.width * bitmap.height;
      bitmap.close();
      if (pixels > 20_000_000) throw new Error('Choose an image up to 20 megapixels.');
      if (token !== photoVersion) return;
      photoUrl = URL.createObjectURL(file);
      photoPreview.src = photoUrl;
      photoPreview.hidden = false;
    } catch (error) {
      if (token !== photoVersion) return;
      clearPhoto();
      showExistingPhoto();
      formStatus.textContent = error.message || 'Cannot read this image. Choose a valid JPG or PNG.';
    }
  });
  $('#recipe-photo-remove').addEventListener('click', () => { clearPhoto(); removeImage = true; formStatus.textContent = ''; });

  function show(panel) {
    for (const section of [browse, detail, editor]) section.hidden = section !== panel;
    create.hidden = panel !== browse;
  }

  function reset() {
    planner.reset();
    version++;
    data = selected = undefined;
    editing = undefined;
    removeImage = false;
    filter = 'all';
    busy = false;
    results.replaceChildren();
    $('#recipe-ingredients').replaceChildren();
    $('#recipe-directions').replaceChildren();
    $('#recipe-description').textContent = '';
    $('#recipe-illustration').replaceChildren();
    $('#recipe-detail-title').textContent = '';
    shareForm.elements.recipient.replaceChildren();
    form.reset();
    clearPhoto();
    $('#recipe-input-items').replaceChildren();
    detailStatus.textContent = formStatus.textContent = status.textContent = '';
    for (const button of [save, $('#recipe-delete-yes'), $('#recipe-remove-yes'), shareForm.querySelector('button'), form.querySelector('[type=submit]')]) button.disabled = false;
    $('#recipe-remove-confirm').hidden = true;
    $('#recipe-delete-confirm').hidden = true;
    retry.hidden = true;
    create.disabled = true;
    show(browse);
  }

  function renderList() {
    if (!data) return;
    for (const button of filters) button.setAttribute('aria-pressed', String(button.dataset.recipeFilter === filter));
    const visible = data.recipes.filter((recipe) => {
      if (filter === 'all') return true;
      if (filter === 'ready') return recipe.items.length > 0 && recipe.missing_count === 0;
      return recipe[filter];
    }).filter(recipe => planner.includes(recipe)).sort((a, b) => planner.compare(a, b));
    status.textContent = visible.length ? plural(visible.length, 'recipe') : planner.message() || emptyMessages[filter];
    results.replaceChildren(...visible.map((recipe) => {
      const card = $('#recipe-card').content.firstElementChild.cloneNode(true);
      const ready = recipe.items.length > 0 && recipe.missing_count === 0;
      card.querySelector('.recipe-badge').replaceWith(badge(
        ready ? 'Ready to make' : recipe.items.length ? `Missing ${plural(recipe.missing_count, 'ingredient')}` : 'No ingredients listed',
        ready,
      ));
      card.querySelector('h2').textContent = recipe.title;
      card.querySelector('p').textContent = recipe.description || plural(recipe.planned_servings || recipe.servings, 'serving');
      const button = card.querySelector('button');
      button.dataset.recipeId = recipe._id;
      button.setAttribute('aria-label', 'View recipe: ' + recipe.title);
      button.addEventListener('click', () => showRecipe(recipe));
      card.prepend(recipeFigure(recipe));
      planner.decorate(card, recipe);
      return card;
    }));
  }

  function renderSave() {
    save.textContent = selected.saved ? 'Unsave recipe' : 'Save recipe';
    save.setAttribute('aria-pressed', String(selected.saved));
  }

  function showRecipe(recipe) {
    selected = recipe;
    $('#recipe-owner-actions').hidden = !recipe.owned;
    $('#recipe-delete-confirm').hidden = true;
    $('#recipe-remove-shared').hidden = !recipe.shared;
    $('#recipe-remove-confirm').hidden = true;
    show(detail);
    const title = $('#recipe-detail-title');
    title.textContent = recipe.title;
    $('#recipe-detail-meta').textContent = `${plural(recipe.planned_servings || recipe.servings, 'serving')} · Quantities adjusted to your plan`;
    $('#recipe-description').textContent = recipe.description;
    $('#recipe-description').hidden = !recipe.description;
    const illustration = $('#recipe-illustration');
    illustration.replaceChildren(recipeFigure(recipe));
    $('#recipe-ingredients').replaceChildren(...recipe.items.map((item) => {
      const row = document.createElement('li');
      const label = document.createElement('div');
      label.textContent = titleCase(item.name);
      const amount = document.createElement('small');
      amount.className = 'muted';
      amount.textContent = `Needed: ${measure(item.required, item.unit)} · In your fridge: ${measure(item.available, item.unit)}`;
      label.append(amount);
      row.append(label, badge(item.missing ? `Missing ${measure(item.missing, item.unit)}` : 'In stock', !item.missing));
      planner.addIngredientOptions(row, item, recipe);
      return row;
    }));
    $('#recipe-directions').replaceChildren(...recipe.instructions.split(/\r?\n/).map((step) => step.trim()).filter(Boolean).map((step) => {
      const row = document.createElement('li');
      row.textContent = step;
      return row;
    }));
    const friends = data.friends;
    shareForm.hidden = !recipe.owned || !friends.length;
    shareForm.elements.recipient.replaceChildren(new Option('Choose a friend', ''),
      ...friends.map((friend) => new Option(`${friend.display_name} (@${friend.username})`, friend._id)));
    detailStatus.textContent = recipe.owned && !friends.length ? 'Add a friend to share this recipe.' : '';
    renderSave();
    title.focus();
  }

  async function load(openId) {
    const token = version;
    status.textContent = 'Loading recipes…';
    retry.hidden = true;
    create.disabled = true;
    try {
      const result = await api(`${endpoint}?servings=${planner.servings}`);
      if (token !== version) return;
      data = result;
      create.disabled = false;
      renderList();
      const recipe = data.recipes.find((item) => item._id === openId);
      if (recipe) showRecipe(recipe);
      else if (openId) { show(browse); status.textContent = 'This recipe is no longer available. It may have been removed or the sharing invitation has not been accepted.'; }
    } catch (error) {
      if (token !== version) return;
      status.textContent = error.message;
      retry.hidden = false;
    }
  }

  async function action(button, message, task) {
    if (busy) return;
    const token = version;
    const current = () => token === version;
    busy = true;
    button.disabled = true;
    message.textContent = '';
    try {
      await task(current);
    } catch (error) {
      if (current()) message.textContent = error.message;
    } finally {
      if (current()) {
        busy = false;
        button.disabled = false;
      }
    }
  }

  function addItem(focus = true, item) {
    const rows = $('#recipe-input-items');
    if (rows.children.length >= Math.min(50, data.ingredients.length)) return;
    const row = $('#recipe-item-row').content.firstElementChild.cloneNode(true);
    const select = row.querySelector('select');
    select.replaceChildren(new Option('Choose an ingredient', ''),
      ...data.ingredients.map((ingredient) => new Option(titleCase(ingredient.name), ingredient._id)));
    if (item) {
      select.value = item.ingredient_id;
      row.querySelector('input').value = String((item.base_required ?? item.required) / 100);
      row.querySelector('[data-recipe-unit]').textContent = item.unit;
    }
    select.addEventListener('change', () => {
      row.querySelector('[data-recipe-unit]').textContent = data.ingredients.find((item) => item._id === select.value)?.default_unit ?? '';
    });
    row.querySelector('button').addEventListener('click', () => {
      row.remove();
      if (!rows.children.length) addItem();
      else $('#recipe-add-item').focus();
    });
    rows.append(row);
    if (focus) select.focus();
  }

  for (const button of filters) button.addEventListener('click', () => {
    filter = button.dataset.recipeFilter;
    renderList();
  });
  for (const button of root.querySelectorAll('[data-recipe-back]')) button.addEventListener('click', () => {
    if (busy) return;
    const previous = selected?._id;
    clearPhoto();
    editing = undefined;
    removeImage = false;
    selected = undefined;
    show(browse);
    renderList();
    ([...results.querySelectorAll('button')].find((entry) => entry.dataset.recipeId === previous) ?? create).focus();
  });
  retry.addEventListener('click', () => load());
  save.addEventListener('click', () => {
    const recipe = selected;
    action(save, detailStatus, async (current) => {
      const result = await api(`${endpoint}/${recipe._id}/saved`, recipe.saved ? 'DELETE' : 'PUT');
      if (!current()) return;
      recipe.saved = result.saved;
      renderSave();
      detailStatus.textContent = result.saved ? 'Recipe saved.' : 'Recipe removed from Saved.';
    });
  });
  shareForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const recipient = shareForm.elements.recipient.value;
    const friend = data.friends.find((user) => user._id === recipient);
    if (!friend) return;
    action(event.submitter, detailStatus, async (current) => {
      await api(`${endpoint}/${selected._id}/shares`, 'POST', { recipient_id: recipient });
      if (current()) location.hash = '#conversation/' + recipient;
    });
  });
  $('#recipe-remove-shared').addEventListener('click', () => {
    if (!busy && selected?.shared) { $('#recipe-remove-confirm').hidden = false; $('#recipe-remove-no').focus(); }
  });
  $('#recipe-remove-no').addEventListener('click', () => {
    if (!busy) { $('#recipe-remove-confirm').hidden = true; $('#recipe-remove-shared').focus(); }
  });
  $('#recipe-remove-yes').addEventListener('click', () => {
    const recipe = selected;
    if (!recipe?.share_id) return;
    action($('#recipe-remove-yes'), detailStatus, async (current) => {
      await api(`${endpoint}/shares/${recipe.share_id}`, 'PATCH', { status: 'removed' });
      if (!current()) return;
      selected = undefined;
      $('#recipe-remove-confirm').hidden = true;
      show(browse);
      await load();
      if (current()) status.textContent = 'Recipe removed from Shared with me and Saved.';
    });
  });
  function openEditor(recipe) {
    editing = recipe;
    removeImage = false;
    form.reset();
    clearPhoto();
    formStatus.textContent = '';
    $('#recipe-create-title').textContent = recipe ? 'Edit recipe' : 'New recipe';
    form.querySelector('[type=submit]').textContent = recipe ? 'Save changes' : 'Create recipe';
    $('#recipe-photo-help').textContent = recipe
      ? 'JPG or PNG, up to 2 MB and 20 megapixels. Keep the current photo, choose a replacement, or remove it to use the default illustration.'
      : 'JPG or PNG, up to 2 MB and 20 megapixels. Leave blank to use the default illustration.';
    $('#recipe-input-items').replaceChildren();
    if (recipe) {
      for (const name of ['title', 'description', 'instructions', 'servings']) form.elements[name].value = recipe[name];
      recipe.items.forEach((item) => addItem(false, item));
      if (!recipe.items.length) addItem(false);
      showExistingPhoto();
    } else addItem(false);
    show(editor);
    $('#recipe-create-title').focus();
  }

  $('#recipe-edit').addEventListener('click', () => {
    if (!busy && selected?.owned) openEditor(selected);
  });
  $('#recipe-delete').addEventListener('click', () => {
    if (!busy && selected?.owned) {
      $('#recipe-delete-confirm').hidden = false;
      $('#recipe-delete-no').focus();
    }
  });
  $('#recipe-delete-no').addEventListener('click', () => {
    if (busy) return;
    $('#recipe-delete-confirm').hidden = true;
    $('#recipe-delete').focus();
  });
  $('#recipe-delete-yes').addEventListener('click', () => {
    if (!selected?.owned) return;
    const recipe = selected;
    action($('#recipe-delete-yes'), detailStatus, async (current) => {
      await api(`${endpoint}/${recipe._id}`, 'DELETE');
      if (!current()) return;
      selected = undefined;
      $('#recipe-delete-confirm').hidden = true;
      show(browse);
      await load();
      if (current()) create.focus();
    });
  });

  create.addEventListener('click', () => {
    if (!data || busy) return;
    if (!data.ingredients.length) {
      status.textContent = 'No ingredients are available yet. Add ingredients to the shared dictionary first.';
      return;
    }
    openEditor();
  });
  $('#recipe-add-item').addEventListener('click', () => addItem());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = new FormData(form);
    const file = photo.files[0];
    const editId = editing?._id;
    const deletePhoto = removeImage;
    const items = [...$('#recipe-input-items').children].map((row) => ({
      ingredient_id: row.querySelector('select').value,
      quantity: Math.round(row.querySelector('input').valueAsNumber * 100),
    }));
    action(event.submitter, formStatus, async (current) => {
      let image;
      if (file) {
        if (!photoUrl) throw new Error('Wait for the photo preview before creating your recipe.');
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Cannot read this image. Please choose it again.'));
          reader.readAsDataURL(file);
        });
        image = { content_type: file.type, data: dataUrl.split(',')[1] };
      }
      if (!current()) return;
      const recipe = await api(editId ? `${endpoint}/${editId}` : endpoint, editId ? 'PATCH' : 'POST', {
        title: fields.get('title'), description: fields.get('description'), instructions: fields.get('instructions'),
        servings: Number(fields.get('servings')), items,
        ...(image ? { image } : editId && deletePhoto ? { image: null } : {}),
      });
      if (!current()) return;
      clearPhoto();
      editing = undefined;
      filter = 'owned';
      show(browse);
      await load(recipe._id);
    });
  });

  return { reset, open(recipeId) { reset(); load(recipeId); } };
}
