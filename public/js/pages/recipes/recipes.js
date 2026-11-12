import { recipeFigure } from '../../food-images.js';
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
  let version = 0;
  let data;
  let selected;
  let filter = 'all';
  let busy = false;

  function show(panel) {
    for (const section of [browse, detail, editor]) section.hidden = section !== panel;
    create.hidden = panel !== browse;
  }

  function reset() {
    version++;
    data = selected = undefined;
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
    $('#recipe-input-items').replaceChildren();
    detailStatus.textContent = formStatus.textContent = status.textContent = '';
    for (const button of [save, shareForm.querySelector('button'), form.querySelector('[type=submit]')]) button.disabled = false;
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
    });
    status.textContent = visible.length ? plural(visible.length, 'recipe') : emptyMessages[filter];
    results.replaceChildren(...visible.map((recipe) => {
      const card = $('#recipe-card').content.firstElementChild.cloneNode(true);
      const ready = recipe.items.length > 0 && recipe.missing_count === 0;
      card.querySelector('.recipe-badge').replaceWith(badge(
        ready ? 'Ready to make' : recipe.items.length ? `Missing ${plural(recipe.missing_count, 'ingredient')}` : 'No ingredients listed',
        ready,
      ));
      card.querySelector('h2').textContent = recipe.title;
      card.querySelector('p').textContent = recipe.description || plural(recipe.servings, 'serving');
      const button = card.querySelector('button');
      button.dataset.recipeId = recipe._id;
      button.setAttribute('aria-label', 'View recipe: ' + recipe.title);
      button.addEventListener('click', () => showRecipe(recipe));
      card.prepend(recipeFigure(recipe));
      return card;
    }));
  }

  function renderSave() {
    save.textContent = selected.saved ? 'Unsave recipe' : 'Save recipe';
    save.setAttribute('aria-pressed', String(selected.saved));
  }

  function showRecipe(recipe) {
    selected = recipe;
    show(detail);
    const title = $('#recipe-detail-title');
    title.textContent = recipe.title;
    $('#recipe-detail-meta').textContent = plural(recipe.servings, 'serving');
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
      const result = await api(endpoint);
      if (token !== version) return;
      data = result;
      create.disabled = false;
      renderList();
      const recipe = data.recipes.find((item) => item._id === openId);
      if (recipe) showRecipe(recipe);
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

  function addItem(focus = true) {
    const rows = $('#recipe-input-items');
    if (rows.children.length >= Math.min(50, data.ingredients.length)) return;
    const row = $('#recipe-item-row').content.firstElementChild.cloneNode(true);
    const select = row.querySelector('select');
    select.replaceChildren(new Option('Choose an ingredient', ''),
      ...data.ingredients.map((ingredient) => new Option(titleCase(ingredient.name), ingredient._id)));
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
      if (current()) detailStatus.textContent = `Recipe shared with ${friend.display_name}.`;
    });
  });
  create.addEventListener('click', () => {
    if (!data || busy) return;
    if (!data.ingredients.length) {
      status.textContent = 'No ingredients are available yet. Add ingredients to the shared dictionary first.';
      return;
    }
    form.reset();
    formStatus.textContent = '';
    $('#recipe-input-items').replaceChildren();
    addItem(false);
    show(editor);
    $('#recipe-create-title').focus();
  });
  $('#recipe-add-item').addEventListener('click', () => addItem());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const fields = new FormData(form);
    const items = [...$('#recipe-input-items').children].map((row) => ({
      ingredient_id: row.querySelector('select').value,
      quantity: Math.round(row.querySelector('input').valueAsNumber * 100),
    }));
    action(event.submitter, formStatus, async (current) => {
      const recipe = await api(endpoint, 'POST', {
        title: fields.get('title'), description: fields.get('description'), instructions: fields.get('instructions'),
        servings: Number(fields.get('servings')), items,
      });
      if (!current()) return;
      filter = 'owned';
      show(browse);
      await load(recipe._id);
    });
  });

  return { reset, open() { reset(); load(); } };
}
