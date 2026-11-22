import { createLookupController, expiryDelay } from './lookup-controller.js';
const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const notes = {
  all: 'A little inspiration, using your current inventory and chosen serving count.',
  ready: 'Everything you need is already in your fridge.',
  borrow: 'These gaps can be covered by friends’ shared stock. Nothing is reserved: ask first and complete the handoff before cooking.',
  budget: 'Choose a budget to check the cost of buying the missing ingredients. Each recommendation is a separate meal, not a combined shopping basket.',
};
export function createMealPlanner(root, { api, measure, changed }) {
  const $ = selector => root.querySelector(selector);
  let mode = 'all', quotes, generation = 0, loading = false, expiryTimer, stockSignature, offset = 0, nextOffset = null;
  let storage; try { storage = sessionStorage; } catch { /* In-memory receipts remain available. */ }
  const lookups = createLookupController({api,storage,owner:()=>document.querySelector('#username')?.textContent});
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
    generation++; quotes = undefined; clearTimeout(expiryTimer); offset = 0; nextOffset = null; loading = false; $('#budget-search').disabled = false;
    $('#meal-budget-status').textContent = 'Serving count changed. Check prices again for the updated quantities.';
    $('#meal-unpriced').hidden = true; changed('servings');
  });
  const reasons={not_checked:'not checked in this group',unknown_pack_size:'the product has no consistent net weight/count/volume',unavailable:'matching listings are unavailable',no_public_price:'no public non-member price',conditional_price:'only conditional/member pricing',no_matching_product:'results do not match this ingredient',no_results:'the retailer returned no products',invalid_link:'no verifiable product link',no_verified_offer:'no matching in-stock pack price'};
  const quoteBody=()=>({budget_cents:Math.round(Number($('#meal-budget').value)*100),servings:Number(servingInput.value),store:$('#meal-store').value,offset});
  function searchLabel(){if(!loading)$('#budget-search').textContent=lookups.hasPending('/api/recipes/shopping/quote',quoteBody())?'Resume lookup':'Find meals in budget';}
  function conditionsChanged(){
    generation++;quotes=undefined;clearTimeout(expiryTimer);offset=0;nextOffset=null;loading=false;
    $('#budget-search').disabled=false;$('#budget-next').hidden=true;$('#meal-unpriced').hidden=true;$('#meal-coverage').textContent='';
    $('#meal-budget-status').textContent='Budget changed. Check prices for these conditions, or resume an existing matching lookup.';
    changed('quote');searchLabel();
  }
  $('#meal-budget').addEventListener('input',conditionsChanged);
  $('#meal-store').addEventListener('change',conditionsChanged);
  $('#budget-next').addEventListener('click',()=>{if(nextOffset!==null&&!loading){offset=nextOffset;$('#budget-form').requestSubmit();}});
  $('#budget-form').addEventListener('submit', async event => {
    event.preventDefault(); if (loading || !servingInput.reportValidity()) return;
    const version = ++generation; loading = true; quotes = undefined; clearTimeout(expiryTimer); changed('quote');
    const budget = Math.round(Number($('#meal-budget').value) * 100);
    $('#budget-search').disabled = true; $('#meal-unpriced').hidden = true;
    $('#meal-budget-status').textContent = 'Checking current public listings and pack sizes. This may take up to two minutes…';
    try {
      const response = await lookups.run('/api/recipes/shopping/quote', quoteBody(), () => version === generation, state=>{
        if(state.resumed)$('#meal-budget-status').textContent=state.reconnecting?'Connection interrupted. Reconnecting to the same lookup…':'Resuming your existing lookup; no new search is started.';
      });
      if (!response) return;
      await changed('synchronize');
      if(version!==generation)return;
      quotes = response;
      nextOffset=response.coverage?.next_offset??null;
      $('#budget-next').hidden=nextOffset===null;
      const coverage=response.coverage;
      $('#meal-coverage').textContent=coverage?`This group checks up to ${coverage.checked_recipe_ids.length} close-match recipes and ${coverage.ingredient_count} missing foods (${coverage.total_candidates} recipes need ingredients). Cached prices may cover other recipes too.`:'Public pack prices are checked in small groups to keep searches focused.';
      const count = response.recommendations.filter(r => r.within_budget).length;
      $('#meal-budget-status').textContent = `${count} meal${count === 1 ? '' : 's'} within ${money(budget)} · Listings checked ${new Date(response.checked_at).toLocaleString()}. Prices may be cached for up to 15 minutes. Tax and delivery excluded.`;
      if(!count)$('#meal-budget-status').textContent=`No fully verified meal within ${money(budget)} yet. ${response.summary?.incomplete??0} recipes have missing quotes; ${response.summary?.over_budget??0} have verified totals above budget. See the candidates and exact missing prices below.`;
      const excluded = response.recommendations.filter(r => !r.within_budget);
      $('#meal-unpriced').hidden = !excluded.length;$('#meal-unpriced').open=count===0;
      $('#meal-unpriced ul').replaceChildren(...excluded.map(recipe => {
        const li = document.createElement('li');
        li.textContent = recipe.status === 'unpriced' ? `${recipe.title}: ${recipe.lines.filter(line => !line.offer).map(line => `${line.name} - ${reasons[line.reason]||reasons.no_verified_offer}`).join('; ')}.` : `${recipe.title}: ${money(recipe.total_cents)}, over budget.`;
        return li;
      }));
      changed('quote');
      expiryTimer=setTimeout(()=>{if(version===generation){quotes=undefined;$('#meal-budget-status').textContent='These prices have expired. Check current listings again; no paid search runs automatically.';$('#meal-unpriced').hidden=true;changed('expired');}},expiryDelay(response.checked_at)+10);
    } catch (error) { if (version === generation) $('#meal-budget-status').textContent = `${error.message} ${error.canResume?'Use Resume lookup to continue the same search.':'You can start a new search when the provider is available.'} No estimated prices were used.`; }
    finally { if (version === generation) { loading = false; $('#budget-search').disabled = false; searchLabel(); } }
  });
  let locationVersion = 0, locating = false;
  async function findStores(body) {
    if (locating) return;
    locating = true; const version = ++locationVersion;
    $('#meal-locate').disabled = true; $('#meal-city-form button').disabled = true;
    $('#meal-location-status').textContent = 'Looking for grocery stores in this area. This may take up to two minutes…';
    $('#meal-shops').replaceChildren();
    try {
      const response = await lookups.run('/api/recipes/shopping/stores', body, () => version === locationVersion);
      if (!response) return;
      $('#meal-location-status').textContent = `${response.location.label} · ${response.stores.length} nearby listings. Confirm the address before travelling.`;
      $('#meal-shops').replaceChildren(...response.stores.map(store => {
        const li = document.createElement('li'), link = document.createElement('a'), address = document.createElement('small');
        link.textContent = store.name; link.href = store.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        address.textContent = `${store.address}${Number.isFinite(store.distance_km)?` · Approx. ${store.distance_km.toFixed(1)} km`:''} · In-store prices unavailable`;
        li.append(link, address); return li;
      }));
      $('.nearby-shops').open=false;
      $('#meal-nearby-summary').textContent=`${response.stores.length} nearby grocery listings — view addresses`;
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
  renderMode(); searchLabel();
  return {
    get servings() { return Number(servingInput.value) || 2; },
    sync(recipes) {
      const signature=JSON.stringify(recipes.map(recipe=>[recipe._id,recipe.planned_servings,recipe.items.map(item=>[item.ingredient_id,item.required,item.available,item.borrow_sources?.map(source=>[source.user._id,source.quantity])]) ]));
      if(stockSignature&&signature!==stockSignature&&quotes){quotes=undefined;clearTimeout(expiryTimer);$('#meal-budget-status').textContent='Inventory or friend availability changed. Check your budget recommendations again.';$('#meal-unpriced').hidden=true;}
      stockSignature=signature;
    },
    includes(recipe) { return mode === 'ready' ? recipe.missing_count === 0 : mode === 'borrow' ? recipe.can_borrow : mode === 'budget' ? Boolean(quoteFor(recipe)?.within_budget || (quotes&&!quotes.recommendations.some(row=>row.within_budget)&&quotes.coverage?.checked_recipe_ids.includes(recipe._id))) : true; },
    compare(a, b) { return mode === 'budget' ? (quoteFor(a)?.total_cents ?? Infinity) - (quoteFor(b)?.total_cents ?? Infinity) : 0; },
    message() { return mode === 'borrow' ? 'No recipes can be fully covered by your friends’ shared stock yet. Ask friends to mark ingredients as Friends, or explore buying the gaps.' : mode === 'budget' ? quotes ? 'No verified recipes fit this budget. See the missing prices below or adjust your budget.' : 'Set a budget above to find meals.' : mode === 'ready' ? 'No recipes have every ingredient in stock for this serving count.' : ''; },
    decorate(card, recipe) {
      const note = document.createElement('p'); note.className = 'meal-card-note';
      if (mode === 'borrow') note.textContent = `Borrow ${recipe.missing_count} missing ingredient${recipe.missing_count === 1 ? '' : 's'} · Needs friends’ confirmation`;
      else if (mode === 'budget' && quoteFor(recipe)?.status==='unpriced') note.textContent = `Price incomplete - ${quoteFor(recipe).lines.filter(line=>!line.offer).length} ingredient prices missing. Verified items: ${money(quoteFor(recipe).known_total_cents||0)}; total unavailable.`;
      else if (mode === 'budget' && quoteFor(recipe)&&!quoteFor(recipe).within_budget) note.textContent=`Whole-pack cost: ${money(quoteFor(recipe).total_cents)} - above your budget`;
      else if (mode === 'budget' && quoteFor(recipe)) note.textContent = `Buy the gaps: ${money(quoteFor(recipe).total_cents)} · ${money(quoteFor(recipe).remaining_cents)} left`;
      else return;
      card.querySelector('button').before(note);
    },
    addIngredientOptions(row, item, recipe) {
      if (!item.missing) return;
      if (mode === 'borrow') {
      if(item.pending_requested){const hint=document.createElement('small');hint.className='pending-request-note';hint.textContent=`Outstanding requests: ${measure(item.pending_requested,item.unit)} across meals. Not reserved or in stock yet.`;row.append(hint);}
      for (const source of item.borrow_sources || []) {
        const form = document.createElement('form'); form.className = 'borrow-food-option';
        const label = document.createElement('label'), input = document.createElement('input'), button = document.createElement('button'), status = document.createElement('small');
        label.textContent = `${source.user.display_name} (@${source.user.username}) · ${measure(source.quantity, item.unit)} shared`;
        const remaining=Math.max(0,item.missing-(item.pending_requested||0));
        input.type = 'number'; input.min = '0.01'; input.max = String(Math.min(source.quantity, remaining) / 100); input.step = '0.01'; input.value = input.max; input.required = true;
        input.setAttribute('aria-label', `Quantity of ${item.name} to request from ${source.user.display_name} in ${item.unit}`);
        label.append(input); button.type = 'submit'; button.className = 'secondary'; button.textContent = 'Ask to borrow'; status.setAttribute('role', 'status');
        form.append(label, button, status);
        if(!remaining){button.disabled=true;input.disabled=true;button.textContent='Already requested';status.textContent='Review your outstanding requests in Friends.';}
        const request_id=crypto.randomUUID();
        form.addEventListener('submit', async event => {
          event.preventDefault(); if (button.disabled) return; button.disabled = true;
          try { await api('/api/friends/ingredient-requests', 'POST', { request_id, owner_id: source.user._id, ingredient_id: item.ingredient_id, quantity: Math.round(Number(input.value) * 100), message: `For ${recipe.title}` }); status.textContent = 'Request sent. Complete the handoff in Friends before cooking.'; input.disabled = true; button.textContent = 'Requested'; await changed('borrow'); }
          catch (error) { status.textContent = error.message; button.disabled = false; }
        });
        row.append(form);
      }
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
    reset() { generation++; locationVersion++; clearTimeout(expiryTimer); loading = locating = false; mode = 'all'; quotes = undefined; stockSignature=undefined; offset=0;nextOffset=null;servingInput.value = '2'; $('#budget-search').disabled = false; $('#meal-locate').disabled = false; $('#meal-city-form button').disabled = false; $('#meal-shops').replaceChildren(); $('#meal-location-status').textContent = ''; $('#meal-budget-status').textContent = 'Set your budget to check current public listings.'; $('#meal-unpriced').hidden = true;$('#budget-next').hidden=true;$('#meal-coverage').textContent='';$('#meal-nearby-summary').textContent='Find grocery stores nearby';renderMode();searchLabel(); },
  };
}
