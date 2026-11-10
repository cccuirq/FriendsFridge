import { createRecipesPage } from './js/pages/recipes/recipes.js';

const $ = (selector) => document.querySelector(selector);
const recipesPage = createRecipesPage($('#recipes-page'), { api, measure });
const requestPath = '/api/friends/ingredient-requests';
const listPaths = {
  incoming: '/api/friends/requests?direction=incoming',
  outgoing: '/api/friends/requests?direction=outgoing',
};
const emptyMessages = {
  incoming: 'No invites to respond to.',
  outgoing: 'No pending invites.',
};

let currentUser;
let generation = 0;
let routeVersion = 0;
let searchQuery = '';
let searchVersion = 0;
let searchTimer;
let offsets = {};
let fridge;
let selectedIngredient;
let conversation;
let directorySignature;
let directoryCount = 20;
let directoryRevision = 0;
let directoryTimer;
let activityStream;
let unreadPeers = new Set();
let unreadRevision = 0;
const messageTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function notice(message = '', error = false) {
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
}

async function api(path, method = 'GET', body) {
  const version = generation;
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/login') && version === generation) showAccount(null);
    const error = new Error(result.error?.message || 'Request failed. Please try again.');
    error.status = response.status;
    throw error;
  }
  return result.data;
}

function initials(user) {
  return (user?.display_name || '?').trim().split(/\s+/u).slice(0, 2)
    .map((word) => Array.from(word)[0]).join('').toLocaleUpperCase();
}

function displayProfile(user) {
  $('#account-avatar').textContent = initials(user);
  $('#profile-avatar').textContent = initials(user);
  $('#username').textContent = '@' + user.username;
  $('#profile-form').elements.display_name.value = user.display_name;
  $('#profile-form').elements.email.value = user.email;
}

function showAccount(user) {
  generation++;
  recipesPage.reset();
  currentUser = user;
  offsets = {};
  clearTimeout(searchTimer);
  searchVersion++;
  searchQuery = '';
  fridge = null;
  selectedIngredient = null;
  conversation = null;
  directorySignature = null;
  directoryCount = 20;
  clearTimeout(directoryTimer);
  $('#friend-filter-form').reset();
  activityStream?.close();
  activityStream = null;
  unreadPeers = new Set();
  renderUnread();
  $('#conversation-messages').replaceChildren();
  $('#conversation-form').reset();
  $('#request-dialog').close();
  $('#account-menu').open = false;
  $('#account-menu').hidden = !user;
  $('.main-nav').hidden = !user;
  $('#auth-panel').hidden = Boolean(user);
  $('#dashboard').hidden = !user;
  for (const name of Object.keys(listPaths)) {
    $('#' + name + '-list').replaceChildren();
    $('#' + name + '-more').hidden = true;
  }
  $('#friends-list').replaceChildren();
  $('#friends-more').hidden = true;
  $('#search-more').hidden = true;
  $('#search-results').replaceChildren();
  $('#search-form').reset();
  $('#search-directory').hidden = true;
  $('#invite-dot').hidden = true;
  $('#invitations-link').removeAttribute('aria-label');
  $('#profile-form').reset();
  if (user) {
    displayProfile(user);
    renderRoute();
    activityStream = new EventSource('/api/friends/conversations/events');
    activityStream.onopen = refreshLive;
    activityStream.onmessage = refreshLive;
  }
}

async function run(control, task) {
  control.disabled = true;
  notice();
  try {
    await task();
  } catch (error) {
    notice(error.message, true);
  } finally {
    control.disabled = false;
  }
}

function action(label, task, className = 'secondary') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = className;
  button.addEventListener('click', () => run(button, task));
  return button;
}

function pill(label, className = '') {
  const element = document.createElement('span');
  element.className = 'pill ' + className;
  element.textContent = label;
  return element;
}

function entry(user, actions = [], { href, preview, peerId = user?._id } = {}) {
  const row = document.createElement('li');
  const person = document.createElement(href ? 'a' : 'div');
  if (href) person.href = href;
  person.className = 'person';
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = initials(user);
  const text = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = user?.display_name || 'Unavailable account';
  if (href && peerId) {
    const dot = document.createElement('span');
    dot.className = 'notification-dot unread-dot';
    dot.dataset.unreadPeer = peerId;
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', 'Unread messages');
    dot.hidden = !unreadPeers.has(peerId);
    name.append(dot);
  }
  const username = document.createElement('small');
  username.textContent = preview ?? (user ? '@' + user.username : '');
  text.append(name, username);
  person.append(avatar, text);
  row.append(person);
  if (actions.length) {
    const controls = document.createElement('div');
    controls.className = 'actions';
    controls.append(...actions);
    row.append(controls);
  }
  return row;
}

function emptyList(target, message) {
  if (target.childElementCount) return;
  const item = document.createElement('li');
  item.className = 'empty';
  item.textContent = message;
  target.append(item);
}

function quantityText(quantity) {
  const fraction = quantity % 100;
  const whole = (quantity - fraction) / 100;
  return fraction ? whole + '.' + String(fraction).padStart(2, '0').replace(/0$/, '') : String(whole);
}

function measure(quantity, unit) {
  if (unit === 'piece' && quantity !== 100) unit = 'pieces';
  return [quantityText(quantity), unit].filter(Boolean).join(' ');
}

function requestCard(row, state) {
  const incoming = row.recipient_id === currentUser._id;
  const card = document.createElement('div');
  card.className = 'request-card';
  const body = document.createElement('div');
  body.className = 'activity-body';
  const title = document.createElement('strong');
  title.textContent = 'Requested ' + (row.ingredient?.name || 'ingredient') + ' · ' + measure(row.quantity, row.ingredient?.default_unit);
  body.append(title);
  if (row.text) {
    const message = document.createElement('p');
    message.className = 'message-text';
    message.textContent = row.text;
    body.append(message);
  }
  const controls = document.createElement('div');
  controls.className = 'actions';
  controls.append(pill(row.status[0].toUpperCase() + row.status.slice(1), row.status));
  const options = [];
  if (incoming && row.status === 'pending') options.push(['Accept', 'accepted'], ['Decline', 'declined']);
  if (incoming && row.status === 'accepted') options.push(['Mark handed off', 'completed']);
  if (row.status === 'pending' || row.status === 'accepted') {
    if (!incoming || row.status === 'accepted') options.push(['Cancel request', 'cancelled']);
  }
  for (const [label, status] of options) {
    controls.append(action(label, async () => {
      if (state.updating) return;
      state.updating = true;
      try {
        await state.loading;
        if (conversation !== state) return;
        const result = await api(requestPath + '/' + row._id, 'PATCH', { status });
        if (conversation !== state) return;
        state.items.set(row._id, { ...row, status: result.status });
        renderMessages(state);
      } finally {
        state.updating = false;
        if (state.livePending) refreshOpenConversation(state);
      }
    }));
  }
  card.append(body, controls);
  return card;
}

function messageEntry(row, state) {
  const mine = row.sender_id === currentUser._id;
  const item = document.createElement('li');
  item.className = 'message-row';
  const avatar = document.createElement('span');
  avatar.className = 'avatar message-avatar' + (mine ? ' mine' : '');
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = initials(mine ? currentUser : state.peer);
  const content = document.createElement('div');
  content.className = 'message-content';
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const author = document.createElement('strong');
  author.textContent = mine ? 'You' : state.peer.display_name;
  const time = document.createElement('time');
  time.dateTime = row.created_at;
  time.textContent = messageTime.format(new Date(row.created_at));
  meta.append(author, time);
  content.append(meta);
  if (row.kind === 'request') content.append(requestCard(row, state));
  else {
    const text = document.createElement('p');
    text.className = 'message-text';
    text.textContent = row.text;
    content.append(text);
  }
  item.append(avatar, content);
  return item;
}

function conversationUrl(peerId) {
  return '/api/friends/' + peerId + '/conversation';
}

function renderUnread() {
  for (const dot of document.querySelectorAll('[data-unread-summary]')) {
    dot.hidden = !unreadPeers.size;
  }
  for (const dot of document.querySelectorAll('[data-unread-peer]')) {
    dot.hidden = !unreadPeers.has(dot.dataset.unreadPeer);
  }
}

async function loadUnread() {
  const account = generation;
  const revision = ++unreadRevision;
  const peers = await api('/api/friends/conversations/unread');
  if (account !== generation || revision !== unreadRevision) return;
  unreadPeers = new Set(peers);
  renderUnread();
}

function nearLatestMessage() {
  const history = $('#conversation-history');
  return history.scrollHeight - history.scrollTop - history.clientHeight < 48;
}

async function markConversationRead(state) {
  if (!state?.loaded || state.markingRead || document.hidden || !nearLatestMessage() || state.received <= state.read) return;
  const through = state.received;
  const account = generation;
  state.markingRead = true;
  try {
    await api(conversationUrl(state.peerId) + '/read', 'POST', { through });
    state.read = Math.max(state.read, through);
    if (account === generation) await loadUnread();
  } catch {
    // Leave the indicator intact and retry on the next foreground refresh.
  } finally { state.markingRead = false; }
}

function renderMessages(state, { older = false, bottom = false } = {}) {
  const list = $('#conversation-messages');
  const history = $('#conversation-history');
  const items = Array.from(state.items.values()).sort((a, b) => a.created_at.localeCompare(b.created_at) || a._id.localeCompare(b._id));
  const signature = JSON.stringify(items);
  if (signature === state.signature) return;
  state.signature = signature;
  const wasNearBottom = nearLatestMessage();
  const oldHeight = history.scrollHeight;
  list.replaceChildren(...items.map((item) => messageEntry(item, state)));
  emptyList(list, 'No messages yet. Say hi!');
  if (older) history.scrollTop += history.scrollHeight - oldHeight;
  else if (bottom || wasNearBottom) history.scrollTop = history.scrollHeight;
}

function loadConversation(state, { older = false, silent = false } = {}) {
  if (state.loading) return state.loading;
  const cursor = older ? '?before=' + encodeURIComponent(state.before) : '';
  const status = $('#conversation-status');
  state.loading = (async () => {
    try {
      const result = await api(conversationUrl(state.peerId) + cursor);
      if (conversation !== state) return;
      const rows = [...result.items];
      // Catch up across pages if more than one page arrived between refreshes.
      let page = result;
      while (!older && state.items.size && page.next_before && !page.items.some((row) => state.items.has(row._id))) {
        page = await api(conversationUrl(state.peerId) + '?before=' + encodeURIComponent(page.next_before));
        if (conversation !== state) return;
        rows.push(...page.items);
      }
      state.peer = result.peer;
      $('#conversation-title').textContent = result.peer.display_name;
      $('#conversation-form').hidden = !result.can_message;
      const fridgeLink = $('#conversation-fridge');
      fridgeLink.href = '#friends/' + state.peerId;
      fridgeLink.hidden = !result.can_message;
      if (older || !state.items.size) state.before = result.next_before;
      $('#conversation-more').hidden = !state.before;
      status.textContent = result.can_message ? '' : 'This conversation is read-only.';
      for (const row of rows) state.items.set(row._id, row);
      renderMessages(state, { older, bottom: !state.loaded });
      if (!older) state.received = result.received;
      state.read = Math.max(state.read, result.read);
      state.loaded = true;
      markConversationRead(state);
    } catch (error) {
      if (conversation === state && !silent) status.textContent = error.message;
    } finally {
      state.loading = null;
      if (state.livePending) refreshOpenConversation(state);
    }
  })();
  return state.loading;
}

function directoryEntry(row) {
  const actions = [];
  if (row.active && row.peer) {
    const open = document.createElement('a');
    open.className = 'friend-fridge-link';
    open.href = '#friends/' + row._id;
    open.title = 'View fridge';
    open.setAttribute('aria-label', 'View fridge for ' + row.peer.display_name);
    open.append($('#friend-fridge-icon').content.cloneNode(true));
    actions.push(open);
  }
  let preview;
  if (row.latest) {
    const prefix = row.latest.sender_id === currentUser._id ? 'You: ' : '';
    preview = prefix + (row.latest.kind === 'request' ? 'Ingredient request' : row.latest.text);
  }
  return entry(row.peer, actions, { href: '#conversation/' + row._id, preview, peerId: row._id });
}

async function loadDirectory() {
  if (!currentUser) return;
  const version = generation;
  const revision = ++directoryRevision;
  const count = directoryCount;
  const query = $('#friend-filter').value.trim();
  const params = new URLSearchParams({ count, q: query });
  const rows = await api('/api/friends/directory?' + params);
  if (version !== generation || revision !== directoryRevision) return;
  $('#friends-more').hidden = rows.length <= count;
  const signature = JSON.stringify([query, count, rows]);
  if (signature === directorySignature) return;
  directorySignature = signature;
  const target = $('#friends-list');
  target.replaceChildren(...rows.slice(0, count).map(directoryEntry));
  emptyList(target, query ? 'No matching friends.' : 'No friends yet. Open Invites to add someone.');
}

function invitationEntry(row, type) {
  const actions = [];
  if (type === 'incoming') {
    for (const [label, status] of [['Accept', 'accepted'], ['Decline', 'declined']]) {
      actions.push(action(label, async () => {
        await api('/api/friends/requests/' + row._id, 'PATCH', { status });
        await refresh();
        notice(status === 'accepted' ? 'You are now friends.' : 'Invitation declined.');
      }));
    }
  }
  if (type === 'outgoing') actions.push(pill('Pending', 'pending'));
  return entry(row.user, actions);
}

async function loadList(type, append = false) {
  if (!currentUser) return;
  const version = generation;
  const offset = append ? offsets[type] + 20 : 0;
  const path = listPaths[type];
  const rows = await api(path + (path.includes('?') ? '&' : '?') + 'offset=' + offset);
  if (version !== generation) return;
  offsets[type] = offset;
  const target = $('#' + type + '-list');
  if (!append) target.replaceChildren();
  for (const row of rows) target.append(invitationEntry(row, type));
  emptyList(target, emptyMessages[type]);
  $('#' + type + '-more').hidden = rows.length < 20;
  if (type === 'incoming' && !append) {
    $('#invite-dot').hidden = !rows.length;
    if (rows.length) $('#invitations-link').setAttribute('aria-label', 'Invites, pending invitations');
    else $('#invitations-link').removeAttribute('aria-label');
  }
}

function refresh() {
  return Promise.all([...Object.keys(listPaths).map((type) => loadList(type)), loadUnread(), loadDirectory()]);
}

function openRequest(item) {
  selectedIngredient = item;
  const { ingredient, quantity } = item;
  const form = $('#request-form');
  form.reset();
  form.elements.quantity.max = quantityText(quantity);
  $('#request-title').textContent = 'Ask for ' + ingredient.name;
  $('#request-unit').textContent = '(' + ingredient.default_unit + ')';
  $('#request-stock').textContent = measure(quantity, ingredient.default_unit) + ' available from ' + fridge.friend.display_name + '.';
  $('#request-error').textContent = '';
  $('#request-dialog').showModal();
}

function ingredientEntry(item) {
  const row = document.createElement('li');
  const details = document.createElement('div');
  details.className = 'activity-body';
  const name = document.createElement('strong');
  name.className = 'ingredient-name';
  name.textContent = item.ingredient.name;
  const quantity = document.createElement('p');
  quantity.className = 'muted';
  quantity.textContent = measure(item.quantity, item.ingredient.default_unit) + ' available';
  details.append(name, quantity);
  const button = action('Request', () => openRequest(item));
  button.setAttribute('aria-label', 'Request ' + item.ingredient.name);
  row.append(details, button);
  return row;
}

async function loadFridge(friendId, append = false) {
  const version = routeVersion;
  const account = generation;
  const offset = append ? offsets.fridge + 20 : 0;
  const target = $('#ingredient-list');
  const status = $('#fridge-status');
  status.hidden = false;
  status.textContent = 'Loading shared ingredients…';
  try {
    const result = await api('/api/friends/' + friendId + '/fridge?offset=' + offset);
    if (version !== routeVersion || account !== generation) return;
    fridge = result;
    offsets.fridge = offset;
    status.hidden = true;
    $('#fridge-title').textContent = result.friend.display_name + '’s fridge';
    $('#fridge-avatar').textContent = initials(result.friend);
    $('#fridge-avatar').hidden = false;
    $('#remove-friend').hidden = false;
    $('#fridge-conversation').href = '#conversation/' + friendId;
    $('#fridge-conversation').hidden = false;
    if (!append) target.replaceChildren();
    for (const item of result.items) target.append(ingredientEntry(item));
    emptyList(target, 'No shared ingredients available right now.');
    $('#fridge-more').hidden = result.items.length < 20;
  } catch (error) {
    if (version === routeVersion && account === generation) status.textContent = error.message;
  }
}

function renderRoute(focus = false) {
  if (!currentUser) return;
  routeVersion++;
  $('#account-menu').open = false;
  $('#request-dialog').close();
  const hash = location.hash === '#activity' ? 'friends' : location.hash.slice(1);
  const shared = /^friends\/([0-9a-f-]{36})$/.exec(hash);
  const chat = /^conversation\/([0-9a-f-]{36})$/.exec(hash);
  const mainPages = ['my-fridge', 'recipes', 'friends', 'profile', 'invitations'];
  const page = shared ? 'fridge' : chat ? 'conversation' : mainPages.includes(hash) ? hash : 'my-fridge';
  const activeTab = ['fridge', 'invitations', 'conversation'].includes(page) ? 'friends' : page;
  conversation = null;
  for (const panel of document.querySelectorAll('.page')) panel.hidden = panel.id !== page + '-page';
  if (page === 'recipes') recipesPage.open();
  else recipesPage.reset();
  for (const tab of document.querySelectorAll('.main-nav a')) {
    if (tab.hash === '#' + activeTab) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (shared) {
    fridge = null;
    $('#fridge-title').textContent = 'Shared fridge';
    $('#fridge-avatar').textContent = '';
    $('#fridge-avatar').hidden = true;
    $('#ingredient-list').replaceChildren();
    $('#fridge-more').hidden = true;
    $('#remove-friend').hidden = true;
    $('#fridge-conversation').hidden = true;
    loadFridge(shared[1]);
  }
  if (chat) {
    conversation = { peerId: chat[1], items: new Map(), received: 0, read: 0 };
    $('#conversation-title').textContent = 'Conversation';
    $('#conversation-status').textContent = 'Loading messages…';
    $('#conversation-messages').replaceChildren();
    $('#conversation-more').hidden = true;
    $('#conversation-fridge').hidden = true;
    $('#conversation-form').hidden = true;
    $('#conversation-form').reset();
    loadConversation(conversation);
  }
  if (focus) {
    $('#' + page + '-title').focus();
    if (page === 'friends') loadDirectory().catch((error) => notice(error.message, true));
    if (page === 'invitations') {
      Promise.all([loadList('incoming'), loadList('outgoing')]).catch((error) => notice(error.message, true));
    }
  }
}

window.addEventListener('hashchange', () => {
  notice();
  renderRoute(true);
});
const accountMenu = $('#account-menu');
accountMenu.querySelector('a').addEventListener('click', () => { accountMenu.open = false; });
document.addEventListener('click', (event) => {
  if (!accountMenu.contains(event.target)) accountMenu.open = false;
});
accountMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && accountMenu.open) {
    accountMenu.open = false;
    $('#account-avatar').focus();
  }
});

for (const type of Object.keys(listPaths)) {
  $('#' + type + '-more').addEventListener('click', (event) => run(event.currentTarget, () => loadList(type, true)));
}
$('#friends-more').addEventListener('click', (event) => run(event.currentTarget, async () => {
  directoryCount += 20;
  await loadDirectory();
}));
$('#fridge-more').addEventListener('click', (event) => run(event.currentTarget, () => loadFridge(fridge.friend._id, true)));
$('#conversation-more').addEventListener('click', (event) => {
  if (conversation?.before) run(event.currentTarget, () => loadConversation(conversation, { older: true }));
});
const composer = $('#conversation-form');
composer.elements.text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const state = conversation;
  if (!state || state.sending) return;
  const input = composer.elements.text;
  const draft = input.value;
  const text = draft.trim();
  if (!text) return;
  if (state.draft?.text !== text) state.draft = { text, message_id: crypto.randomUUID() };
  state.sending = true;
  run(composer.querySelector('button'), async () => {
    try {
      const message = await api(conversationUrl(state.peerId), 'POST', state.draft);
      if (conversation !== state) return;
      if (input.value === draft) input.value = '';
      state.draft = null;
      state.items.set(message._id, { ...message, kind: 'message' });
      renderMessages(state, { bottom: true });
      input.focus();
    } finally {
      state.sending = false;
      if (state.livePending) refreshOpenConversation(state);
    }
  });
});

function refreshOpenConversation(state) {
  if (conversation !== state) return;
  state.livePending = Boolean(state.loading || state.sending || state.updating);
  if (!state.livePending) loadConversation(state, { silent: true });
}

function refreshLive() {
  if (!currentUser) return;
  loadUnread().catch(() => {});
  if (conversation) refreshOpenConversation(conversation);
  if (!$('#friends-page').hidden) loadDirectory().catch(() => {});
}
function pollActivity() {
  if (!document.hidden) refreshLive();
}
setInterval(pollActivity, 5000);
document.addEventListener('visibilitychange', pollActivity);
$('#conversation-history').addEventListener('scroll', () => markConversationRead(conversation));

$('#remove-friend').addEventListener('click', (event) => run(event.currentTarget, async () => {
  const friend = fridge.friend;
  if (!confirm('Remove ' + friend.display_name + ' from your friends?')) return;
  await api('/api/friends/' + friend._id, 'DELETE');
  location.hash = 'friends';
  await refresh();
  notice('Friend removed.');
}));
$('#close-request').addEventListener('click', () => $('#request-dialog').close());
$('#request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const control = form.querySelector('[type="submit"]');
  const value = form.elements.quantity.value;
  const [whole, fraction = ''] = value.split('.');
  const quantity = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!/^\d*(?:\.\d{1,2})?$/.test(value) || !Number.isSafeInteger(quantity) || quantity <= 0) {
    $('#request-error').textContent = 'Enter a positive quantity with up to two decimal places.';
    return;
  }
  const { ingredient } = selectedIngredient;
  const version = routeVersion;
  const account = generation;
  const peerId = fridge.friend._id;
  control.disabled = true;
  $('#request-error').textContent = '';
  try {
    await api(requestPath, 'POST', {
      owner_id: peerId,
      ingredient_id: ingredient._id,
      quantity,
      message: form.elements.message.value,
    });
    if (account !== generation) return;
    if (version === routeVersion) location.hash = 'conversation/' + peerId;
  } catch (error) {
    if (version === routeVersion && account === generation) $('#request-error').textContent = error.message;
  } finally {
    control.disabled = false;
  }
});

for (const mode of ['login', 'register']) {
  $('#show-' + mode).addEventListener('click', () => {
    for (const item of ['login', 'register']) {
      $('#' + item + '-form').hidden = mode !== item;
      $('#show-' + item).setAttribute('aria-pressed', String(item === mode));
    }
    notice();
  });
  $('#' + mode + '-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    run(form.querySelector('button'), async () => {
      const user = await api('/api/auth/' + mode, 'POST', Object.fromEntries(new FormData(form)));
      form.reset();
      showAccount(user);
      await refresh();
    });
  });
}

$('#profile-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  run(form.querySelector('button'), async () => {
    const version = generation;
    const user = await api('/api/users/me', 'PATCH', Object.fromEntries(new FormData(form)));
    if (version !== generation) return;
    currentUser = user;
    displayProfile(user);
    notice('Profile saved.');
  });
});
$('#logout').addEventListener('click', (event) => run(event.currentTarget, async () => {
  await api('/api/auth/logout', 'POST');
  showAccount(null);
  history.replaceState(null, '', location.pathname + location.search);
  notice('You have logged out.');
}));

function queueFriendFilter(delay) {
  clearTimeout(directoryTimer);
  directoryRevision++;
  directoryCount = 20;
  $('#friends-more').hidden = true;
  directoryTimer = setTimeout(() => loadDirectory().catch((error) => notice(error.message, true)), delay);
}
$('#friend-filter').addEventListener('input', () => queueFriendFilter(250));
$('#friend-filter-form').addEventListener('submit', (event) => {
  event.preventDefault();
  queueFriendFilter(0);
});

async function search(append = false) {
  const version = generation;
  const revision = searchVersion;
  const offset = append ? offsets.search + 20 : 0;
  const query = searchQuery;
  let rows;
  try {
    rows = await api('/api/users?q=' + encodeURIComponent(query) + '&offset=' + offset + '&invitable=1');
  } catch (error) {
    if (version === generation && revision === searchVersion) $('#search-status').textContent = error.message;
    return;
  }
  if (version !== generation || revision !== searchVersion) return;
  offsets.search = offset;
  const target = $('#search-results');
  if (!append) target.replaceChildren();
  $('#search-status').textContent = '';
  for (const user of rows) {
    const add = action('+', async () => {
      await api('/api/friends/requests', 'POST', { user_id: user._id });
      add.replaceWith(pill('Invited', 'pending'));
      let updatedSearch;
      if (version === generation && query === searchQuery) {
        clearTimeout(searchTimer);
        searchVersion++;
        updatedSearch = search();
      }
      await Promise.all([loadList('outgoing'), updatedSearch]);
      notice('Invitation sent to ' + user.display_name + '.');
    }, 'add-friend');
    add.setAttribute('aria-label', 'Add ' + user.display_name);
    target.append(entry(user, [add]));
  }
  emptyList(target, 'No matching people to invite.');
  $('#search-more').hidden = rows.length < 20;
}
function queueSearch(value, immediate = false) {
  clearTimeout(searchTimer);
  searchVersion++;
  searchQuery = value.trim();
  $('#search-directory').hidden = !searchQuery;
  $('#search-results').replaceChildren();
  $('#search-more').hidden = true;
  $('#search-status').textContent = searchQuery.length < 2 ? 'Type at least two characters.' : 'Searching…';
  if (searchQuery.length < 2) return;
  if (immediate) search();
  else searchTimer = setTimeout(() => search(), 250);
}
$('#search-form').elements.q.addEventListener('input', (event) => queueSearch(event.currentTarget.value));
$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  queueSearch(event.currentTarget.elements.q.value, true);
});
$('#search-more').addEventListener('click', (event) => run(event.currentTarget, () => search(true)));

try {
  showAccount(await api('/api/users/me'));
  await refresh();
} catch (error) {
  if (error.status !== 401) notice(error.message, true);
}
