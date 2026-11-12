import { foodImage } from '../../food-images.js';

function scaled(value, minimum) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Enter a quantity with up to two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const quantity = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(quantity) || quantity < minimum) throw new Error('Enter a valid quantity.');
  return quantity;
}

export function createInventoryPage(root, { api, measure }) {
  const $ = (selector) => root.querySelector(selector);
  const dialog = $('[data-stock-dialog]');
  const form = $('[data-stock-form]');
  const status = $('[data-stock-status]');
  let version = 0;
  let catalog = [];
  let editing;
  let pending;
  let busy = false;
  let opened = false;
  const ingredient = () => catalog.find((item) => item.name.toLowerCase() === form.elements.ingredient.value.trim().toLowerCase());
  const error = (message = '') => { $('[data-stock-error]').textContent = message; };

  function setBusy(value) {
    busy = value;
    root.setAttribute('aria-busy', String(value));
    root.querySelectorAll('button, input, select').forEach((node) => { node.disabled = value || node.dataset.atLimit === 'true'; });
    $('[data-stock-add]').disabled = value || !catalog.length;
    // An uncertain add must retry the exact same payload.
    if (pending) form.querySelectorAll('input, select').forEach((node) => { node.disabled = true; });
  }

  function button(label, task, className = 'secondary') {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label; node.className = className;
    node.addEventListener('click', task);
    return node;
  }

  async function mutate(task, message) {
    if (busy) return;
    const current = version;
    setBusy(true); status.textContent = '';
    try {
      await task();
      if (current !== version) return;
      await load();
      if (current === version) status.textContent = message;
    } catch (err) {
      if (current !== version) return;
      if (err.status === 409 || err.status === 404) await load().catch(() => {});
      if (current === version) { status.textContent = err.message; $('[data-stock-retry]').hidden = false; }
    } finally { if (current === version) setBusy(false); }
  }

  function render(items) {
    $('[data-stock-count]').textContent = `${items.length} food${items.length === 1 ? '' : 's'}`;
    $('[data-stock-empty]').hidden = Boolean(items.length);
    $('[data-stock]').replaceChildren(...items.map((item) => {
      const row = document.createElement('li'); row.className = 'stock-row';
      const icon = foodImage(item.ingredient); icon.classList.add('food-icon'); icon.setAttribute('aria-hidden', 'true');
      const details = document.createElement('div'); details.className = 'stock-details';
      const name = document.createElement('strong'); name.className = 'ingredient-name'; name.textContent = item.ingredient.name;
      const amount = document.createElement('span'); amount.className = 'muted'; amount.textContent = item.quantity ? measure(item.quantity, item.ingredient.default_unit) : 'Out of stock';
      details.append(name, amount);
      const controls = document.createElement('div'); controls.className = 'stock-controls';
      const step = 100;
      for (const [label, change] of [['−', -step], ['+', step]]) {
        const adjust = button(label, () => mutate(() => api(`/api/inventory/${item._id}`, 'PATCH', { quantity: Math.max(0, item.quantity + change), expected_quantity: item.quantity }), 'Quantity updated.'));
        adjust.setAttribute('aria-label', `${change > 0 ? 'Increase' : 'Decrease'} ${item.ingredient.name} by ${measure(Math.min(change < 0 ? item.quantity : step, step), item.ingredient.default_unit)}`);
        if ((change < 0 && item.quantity === 0) || !Number.isSafeInteger(item.quantity + change)) adjust.dataset.atLimit = 'true';
        controls.append(adjust);
      }
      const sharing = button(item.visibility === 'friends' ? 'Friends' : 'Only me', () => mutate(() => api(`/api/inventory/${item._id}`, 'PATCH', { visibility: item.visibility === 'friends' ? 'private' : 'friends' }), 'Sharing updated.'), 'stock-sharing');
      sharing.setAttribute('aria-label', `Share ${item.ingredient.name} with friends`); sharing.setAttribute('aria-pressed', String(item.visibility === 'friends'));
      controls.append(sharing, button('Edit', () => open(item)), button('Delete', () => {
        if (confirm(`Delete ${item.ingredient.name} from your fridge?`)) mutate(() => api(`/api/inventory/${item._id}`, 'DELETE', { expected_quantity: item.quantity }), 'Food removed.');
      }, 'danger'));
      row.append(icon, details, controls); return row;
    }));
  }

  async function load() {
    const current = version;
    $('[data-stock-retry]').hidden = true;
    const items = await api('/api/inventory');
    if (current !== version) return;
    render(items);
  }

  function open(item) {
    if (busy) return;
    editing = item; pending = undefined; form.reset(); error();
    $('[data-stock-picker]').hidden = Boolean(item);
    form.elements.ingredient.required = !item;
    $('[data-stock-edit-name]').hidden = !item;
    $('[data-stock-edit-name]').textContent = item?.ingredient.name || '';
    $('#stock-dialog-title').textContent = item ? 'Edit food' : 'Add food';
    form.querySelector('[type="submit"]').textContent = item ? 'Save changes' : 'Add to fridge';
    form.elements.quantity.min = item ? '0' : '0.01';
    form.elements.quantity.value = item ? `${(item.quantity - item.quantity % 100) / 100}.${String(item.quantity % 100).padStart(2, '0')}` : '';
    form.elements.visibility.value = item?.visibility || 'private';
    $('[data-stock-unit]').textContent = item?.ingredient.default_unit || '';
    $('[data-stock-help]').textContent = item ? 'Set quantity to zero to keep an out-of-stock entry.' : 'Adding existing food increases its stock and keeps its sharing setting.';
    setBusy(false); dialog.showModal();
  }

  $('[data-stock-add]').addEventListener('click', () => open());
  $('[data-stock-cancel]').addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { pending = undefined; editing = undefined; $('[data-stock-add]').focus(); });
  form.elements.ingredient.addEventListener('input', () => { $('[data-stock-unit]').textContent = ingredient()?.default_unit || 'Choose a listed ingredient'; });
  form.addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy) return;
    const current = version;
    try {
      if (!pending) {
        const quantity = scaled(form.elements.quantity.value, editing ? 0 : 1);
        if (editing) pending = { quantity, visibility: form.elements.visibility.value, expected_quantity: editing.quantity };
        else {
          const selected = ingredient();
          if (!selected) throw new Error('Choose an ingredient from the list.');
          pending = { batch_id: crypto.randomUUID(), ingredient_id: selected._id, quantity, visibility: form.elements.visibility.value };
        }
      }
      setBusy(true); error();
      await api(editing ? `/api/inventory/${editing._id}` : '/api/inventory', editing ? 'PATCH' : 'POST', pending);
      if (current !== version) return;
      pending = undefined; dialog.close(); setBusy(true);
      await load();
      if (current === version) status.textContent = 'Your fridge is updated.';
    } catch (err) {
      if (current !== version) return;
      if (!dialog.open) {
        status.textContent = `Saved, but the fridge could not refresh. ${err.message}`;
        $('[data-stock-retry]').hidden = false;
        return;
      }
      if (editing || (err.status >= 400 && err.status < 500)) pending = undefined;
      if (editing && [404, 409].includes(err.status)) {
        dialog.close();
        await load().catch(() => {});
        if (current === version) { status.textContent = err.message; $('[data-stock-retry]').hidden = false; }
      } else {
        error(pending ? `${err.message} Retry to safely check this same addition.` : err.message);
        form.querySelector('[type="submit"]').textContent = pending ? 'Retry same addition' : editing ? 'Save changes' : 'Add to fridge';
      }
    } finally { if (current === version) setBusy(false); }
  });

  async function openPage() {
    const current = ++version;
    if (!opened) { root.classList.remove('fridge-open'); void root.offsetWidth; root.classList.add('fridge-open'); opened = true; }
    setBusy(true); status.textContent = 'Loading your fridge…';
    try {
      const [, ingredients] = await Promise.all([load(), api('/api/ingredients')]);
      if (current !== version) return;
      catalog = ingredients;
      $('#stock-catalog').replaceChildren(...catalog.map((item) => { const option = document.createElement('option'); option.value = item.name; option.label = item.default_unit; return option; }));
      status.textContent = catalog.length ? '' : 'The ingredient list is empty. Please seed the ingredient dictionary.';
    } catch (err) { if (current === version) { status.textContent = err.message; $('[data-stock-retry]').hidden = false; } }
    finally { if (current === version) setBusy(false); }
  }
  $('[data-stock-retry]').addEventListener('click', openPage);
  return {
    open: openPage,
    reset(accountChanged = false) {
      version++; dialog.close(); pending = undefined; editing = undefined; busy = false; catalog = [];
      $('[data-stock]').replaceChildren(); status.textContent = ''; $('[data-stock-empty]').hidden = true;
      if (accountChanged) { opened = false; root.classList.remove('fridge-open'); }
    },
  };
}
