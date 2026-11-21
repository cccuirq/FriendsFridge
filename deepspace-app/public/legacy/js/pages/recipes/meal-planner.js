const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const notes = {
  all: 'A little inspiration, using your current inventory and chosen serving count.',
  ready: 'Everything you need is already in your fridge.',
  borrow: 'These gaps can be covered by friends’ shared stock. Nothing is reserved: ask first and complete the handoff before cooking.',
  budget: 'Choose a budget to check the cost of buying the missing ingredients. Each recommendation is a separate meal, not a combined shopping basket.',
};
export function createMealPlanner(root, { api, measure, changed }) {
  const $ = selector => root.querySelector(selector);
  let mode = 'all', quotes, generation = 0, loading = false;
  const modes = [...root.querySelectorAll('[data-recipe-mode]')];
  const servingInput = $('#meal-servings');
  function renderMode() {
    modes.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.recipeMode === mode)));
    $('#budget-panel').hidden = mode !== 'budget';
    $('#meal-mode-note').textContent = notes[mode];
  }
  for (const button of modes) button.addEventListener('click', () => { mode = button.dataset.recipeMode; renderMode(); changed('mode'); });
  servingInput.addEventListener('change', () => {
    if (!servingInput.reportValidity()) return;
    generation++; quotes = undefined; loading = false; $('#budget-search').disabled = false;
    $('#meal-budget-status').textContent = 'Serving count changed. Check prices again for the updated quantities.';
    $('#meal-unpriced').hidden = true; changed('servings');
  });
  async function poll(path, body, current) {
    let response = await api(path, 'POST', { ...body, request_id: crypto.randomUUID() });
    for (let attempt = 0; response.status === 'pending' && attempt < 60; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      if (!current()) return null;
      response = await api(`/api/recipes/shopping/jobs/${response.job_id}`);
    }
    if (!current()) return null;
    if (response.status !== 'complete') throw new Error('The provider is still working. Please try again shortly.');
    return response;
  }
  $('#budget-form').addEventListener('submit', async event => {
    event.preventDefault(); if (loading || !servingInput.reportValidity()) return;
    const version = ++generation; loading = true; quotes = undefined; changed('quote');
    const budget = Math.round(Number($('#meal-budget').value) * 100);
    $('#budget-search').disabled = true; $('#meal-unpriced').hidden = true;
    $('#meal-budget-status').textContent = 'Checking current public listings and pack sizes. This may take up to two minutes…';
    try {
      const response = await poll('/api/recipes/shopping/quote', { budget_cents: budget, servings: Number(servingInput.value), store: $('#meal-store').value }, () => version === generation);
      if (!response) return;
      quotes = response;
      const count = response.recommendations.filter(r => r.within_budget).length;
      $('#meal-budget-status').textContent = `${count} meal${count === 1 ? '' : 's'} within ${money(budget)} · Listings checked ${new Date(response.checked_at).toLocaleString()}. Prices may be cached for up to 15 minutes. Tax and delivery excluded.`;
      const excluded = response.recommendations.filter(r => !r.within_budget);
      $('#meal-unpriced').hidden = !excluded.length;
      $('#meal-unpriced ul').replaceChildren(...excluded.map(recipe => {
        const li = document.createElement('li');
        li.textContent = recipe.status === 'unpriced' ? `${recipe.title}: could not verify prices and pack sizes for ${recipe.lines.filter(line => !line.offer).map(line => line.name).join(', ')}.` : `${recipe.title}: ${money(recipe.total_cents)}, over budget.`;
        return li;
      }));
      changed('quote');
    } catch (error) { if (version === generation) $('#meal-budget-status').textContent = `${error.message} No estimated prices were used.`; }
    finally { if (version === generation) { loading = false; $('#budget-search').disabled = false; } }
  });
  let locationVersion = 0, locating = false;
  async function findStores(body) {
    if (locating) return;
    locating = true; const version = ++locationVersion;
    $('#meal-locate').disabled = true; $('#meal-city-form button').disabled = true;
    $('#meal-location-status').textContent = 'Looking for grocery stores in this area. This may take up to two minutes…';
    $('#meal-shops').replaceChildren();
    try {
      const response = await poll('/api/recipes/shopping/stores', body, () => version === locationVersion);
      if (!response) return;
      $('#meal-location-status').textContent = `${response.location.label} · ${response.stores.length} nearby listings. Confirm the address before travelling.`;
      $('#meal-shops').replaceChildren(...response.stores.map(store => {
        const li = document.createElement('li'), link = document.createElement('a'), address = document.createElement('small');
        link.textContent = store.name; link.href = store.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        address.textContent = `${store.address} · In-store prices unavailable`;
        li.append(link, address); return li;
      }));
    } catch (error) { if (version === locationVersion) $('#meal-location-status').textContent = `${error.message} Online budget searches still work separately.`; }
    finally { if (version === locationVersion) { locating = false; $('#meal-locate').disabled = false; $('#meal-city-form button').disabled = false; } }
  }
  $('#meal-locate').addEventListener('click', () => {
    if (locating) return;
    if (!navigator.geolocation) { $('#meal-location-status').textContent = 'Location is not supported. Enter a city below.'; $('#meal-city').focus(); return; }
    $('#meal-locate').disabled = true; $('#meal-location-status').textContent = 'Waiting for location permission…';
    navigator.geolocation.getCurrentPosition(position => {
      $('#meal-locate').disabled = false;
      findStores({ lat: Math.round(position.coords.latitude * 100) / 100, lon: Math.round(position.coords.longitude * 100) / 100 });
    }, () => {
      $('#meal-locate').disabled = false;
      $('#meal-location-status').textContent = 'Location was unavailable or not allowed. Enter your city instead; you can also use online prices without location.'; $('#meal-city').focus();
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  });
  $('#meal-city-form').addEventListener('submit', event => { event.preventDefault(); findStores({ city: $('#meal-city').value.trim() }); });
  function quoteFor(recipe) {
    if (!quotes || Date.now() - new Date(quotes.checked_at).getTime() > 15 * 60 * 1000) return null;
    const quote = quotes?.recommendations.find(row => row.recipe_id === recipe._id);
    if (!quote || quote.lines.length !== recipe.items.filter(i => i.missing > 0).length || quote.lines.some(line => recipe.items.find(i => i.ingredient_id === line.ingredient_id)?.missing !== line.missing)) return null;
    return quote;
  }
  renderMode();
  return {
    get servings() { return Number(servingInput.value) || 2; },
    includes(recipe) { return mode === 'ready' ? recipe.missing_count === 0 : mode === 'borrow' ? recipe.can_borrow : mode === 'budget' ? Boolean(quoteFor(recipe)?.within_budget) : true; },
    compare(a, b) { return mode === 'budget' ? (quoteFor(a)?.total_cents ?? Infinity) - (quoteFor(b)?.total_cents ?? Infinity) : 0; },
    message() { return mode === 'borrow' ? 'No recipes can be fully covered by your friends’ shared stock yet. Ask friends to mark ingredients as Friends, or explore buying the gaps.' : mode === 'budget' ? quotes ? 'No verified recipes fit this budget. See the missing prices below or adjust your budget.' : 'Set a budget above to find meals.' : mode === 'ready' ? 'No recipes have every ingredient in stock for this serving count.' : ''; },
    decorate(card, recipe) {
      const note = document.createElement('p'); note.className = 'meal-card-note';
      if (mode === 'borrow') note.textContent = `Borrow ${recipe.missing_count} missing ingredient${recipe.missing_count === 1 ? '' : 's'} · Needs friends’ confirmation`;
      else if (mode === 'budget' && quoteFor(recipe)) note.textContent = `Buy the gaps: ${money(quoteFor(recipe).total_cents)} · ${money(quoteFor(recipe).remaining_cents)} left`;
      else return;
      card.querySelector('button').before(note);
    },
    addIngredientOptions(row, item, recipe) {
      if (!item.missing) return;
      if (mode === 'borrow') for (const source of item.borrow_sources || []) {
        const form = document.createElement('form'); form.className = 'borrow-food-option';
        const label = document.createElement('label'), input = document.createElement('input'), button = document.createElement('button'), status = document.createElement('small');
        label.textContent = `${source.user.display_name} (@${source.user.username}) · ${measure(source.quantity, item.unit)} shared`;
        input.type = 'number'; input.min = '0.01'; input.max = String(Math.min(source.quantity, item.missing) / 100); input.step = '0.01'; input.value = input.max; input.required = true;
        input.setAttribute('aria-label', `Quantity of ${item.name} to request from ${source.user.display_name} in ${item.unit}`);
        label.append(input); button.type = 'submit'; button.className = 'secondary'; button.textContent = 'Ask to borrow'; status.setAttribute('role', 'status');
        form.append(label, button, status);
        form.addEventListener('submit', async event => {
          event.preventDefault(); if (button.disabled) return; button.disabled = true;
          try { await api('/api/friends/ingredient-requests', 'POST', { owner_id: source.user._id, ingredient_id: item.ingredient_id, quantity: Math.round(Number(input.value) * 100), message: `For ${recipe.title}` }); status.textContent = 'Request sent. Complete the handoff in Friends before cooking.'; input.disabled = true; button.textContent = 'Requested'; }
          catch (error) { status.textContent = error.message; button.disabled = false; }
        });
        row.append(form);
      }
      if (mode === 'budget') {
        const offer = quoteFor(recipe)?.lines.find(line => line.ingredient_id === item.ingredient_id)?.offer;
        if (offer) {
          const box = document.createElement('div'), link = document.createElement('a'), detail = document.createElement('small'); box.className = 'purchase-food-option';
          link.href = offer.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `${offer.packs} × ${offer.title}`;
          detail.textContent = `${money(offer.price_cents)} per pack · ${money(offer.total_cents)} total · Pack: ${measure(offer.package_quantity, offer.unit)} · Left over: ${measure(offer.leftover, offer.unit)}. Checked ${new Date(offer.checked_at).toLocaleString()}. Confirm price and delivery on Amazon.`;
          box.append(link, detail); row.append(box);
        }
      }
    },
    reset() { generation++; locationVersion++; loading = locating = false; mode = 'all'; quotes = undefined; servingInput.value = '2'; $('#budget-search').disabled = false; $('#meal-locate').disabled = false; $('#meal-city-form button').disabled = false; $('#meal-shops').replaceChildren(); $('#meal-location-status').textContent = ''; $('#meal-budget-status').textContent = 'Set your budget to check current public listings.'; $('#meal-unpriced').hidden = true; renderMode(); },
  };
}
