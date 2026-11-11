export function createRecognitionPage(root, { api }) {
  const $ = (selector) => root.querySelector(selector);
  let catalog = [];
  let file;
  let bitmap;
  let detections = [];
  let rows = [];
  let version = 0;
  let busy = false;
  let submitted = false;
  let recognized = false;
  let pending;
  let batchId = crypto.randomUUID();
  const status = (message) => { $('[data-status]').textContent = message; };
  const ingredient = (name) => catalog.find((item) => item.name.toLowerCase() === name.trim().toLowerCase());

  function controls() {
    $('[data-upload]').disabled = busy || Boolean(pending);
    $('[data-recognize]').disabled = busy || !file || recognized || submitted || Boolean(pending);
    $('[data-new]').disabled = busy || Boolean(pending);
    $('[data-add]').disabled = busy || submitted || Boolean(pending) || !catalog.length || rows.length >= 50;
    $('[data-confirm]').disabled = busy || submitted || !rows.length || !catalog.length;
    $('[data-confirm]').textContent = pending ? 'Retry Same Confirmation' : 'Confirm and Add to Fridge';
    $('[data-rows]').querySelectorAll('input, button').forEach((control) => { control.disabled = busy || submitted || Boolean(pending); });
    root.setAttribute('aria-busy', String(busy));
  }

  function draw() {
    const canvas = $('[data-preview]');
    canvas.hidden = !bitmap;
    if (!bitmap) return;
    const scale = Math.min(1, 1280 / bitmap.width);
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 3;
    ctx.font = 'bold 16px system-ui';
    detections.forEach((detection) => {
      const [x1, y1, x2, y2] = detection.box.map((n) => n * scale);
      ctx.strokeStyle = '#ffdc72';
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const label = `${detection.name} ${Math.round(detection.confidence * 100)}%`;
      const labelY = Math.max(0, y1 - 25);
      ctx.fillStyle = '#28221d';
      ctx.fillRect(x1, labelY, ctx.measureText(label).width + 12, 25);
      ctx.fillStyle = '#fff9ec';
      ctx.fillText(label, x1 + 6, labelY + 18);
    });
  }

  function renderRows() {
    $('[data-rows]').replaceChildren();
    rows.forEach((row, index) => {
      const node = $('[data-row-template]').content.firstElementChild.cloneNode(true);
      const name = node.querySelector('[name="ingredient"]');
      const quantity = node.querySelector('[name="quantity"]');
      const unit = node.querySelector('[data-unit]');
      name.value = row.name;
      quantity.value = row.quantity;
      const updateUnit = () => { unit.textContent = ingredient(row.name)?.default_unit || 'Choose a listed ingredient'; };
      updateUnit();
      name.addEventListener('input', () => {
        const previous = ingredient(row.name)?.default_unit;
        row.name = name.value;
        if (previous !== ingredient(row.name)?.default_unit) { row.quantity = ''; quantity.value = ''; }
        updateUnit();
      });
      quantity.addEventListener('input', () => { row.quantity = quantity.value; });
      node.querySelector('[data-confidence]').textContent = row.confidence == null ? 'Manually added' : `Original model suggestion: ${row.originalName} · ${Math.round(row.confidence * 100)}% highest confidence · ${row.count} detection(s)${row.needsReview ? ' · Includes uncertain detections: check carefully' : ''}`;
      node.querySelector('button').addEventListener('click', () => { rows.splice(index, 1); renderRows(); });
      $('[data-rows]').append(node);
    });
    $('[data-empty]').hidden = Boolean(rows.length);
    controls();
  }

  function clear(resetUpload = true) {
    version++;
    bitmap?.close(); bitmap = null; file = null; rows = []; detections = [];
    pending = undefined; submitted = false; recognized = false; busy = false;
    batchId = crypto.randomUUID();
    if (resetUpload) $('[data-upload]').value = '';
    $('[data-saved]').hidden = true;
    status('Choose a photo, or add ingredients manually. Nothing is saved until you confirm.');
    draw(); renderRows();
  }

  async function loadCatalog() {
    const current = version;
    try {
      const result = await api('/api/recognition/ingredients');
      if (current !== version) return;
      catalog = result;
      $('[data-catalog]').replaceChildren(...catalog.map((item) => {
        const option = document.createElement('option'); option.value = item.name; return option;
      }));
      $('[data-retry]').hidden = Boolean(catalog.length);
      if (!catalog.length) status('Ingredient list is empty. Run npm run db:seed, then reload the ingredient list.');
      renderRows();
    } catch (error) {
      if (current !== version) return;
      status(error.message); $('[data-retry]').hidden = false;
    }
  }

  $('[data-upload]').addEventListener('change', async (event) => {
    const selected = event.target.files[0];
    if (!selected) return;
    clear(false);
    if (!/\.(jpe?g|png)$/i.test(selected.name) || !['image/jpeg', 'image/png'].includes(selected.type)) return status('Choose a JPG, JPEG or PNG image.');
    if (!selected.size || selected.size > 10 * 1024 * 1024) return status('Choose a non-empty image no larger than 10 MB.');
    const current = version;
    busy = true; controls();
    try {
      const decoded = await createImageBitmap(selected, { imageOrientation: 'from-image' });
      if (current !== version) { decoded.close(); return; }
      if (decoded.width * decoded.height > 20_000_000) { decoded.close(); throw new Error('Choose an image up to 20 megapixels.'); }
      bitmap = decoded; file = selected;
      draw(); status(`${selected.name} is ready. Click Recognize Ingredients.`);
    } catch { if (current === version) status('Cannot read this image. Use a valid JPG or PNG up to 20 megapixels.'); }
    finally { if (current === version) { busy = false; controls(); } }
  });

  $('[data-recognize]').addEventListener('click', async () => {
    if (busy || !file || recognized || submitted || pending) return;
    const current = version;
    busy = true; controls(); status('Recognizing ingredients… This may take a moment on CPU.');
    try {
      const result = await api('/api/recognition', 'POST', file);
      if (current !== version) return;
      detections = result.detections;
      recognized = true;
      const grouped = new Map();
      for (const detection of detections) {
        const name = detection.name;
        const row = grouped.get(name) || { name, originalName: detection.name, count: 0, confidence: 0, quantity: '' };
        row.count++; row.confidence = Math.max(row.confidence, detection.confidence);
        row.needsReview ||= detection.confidence < 0.5;
        grouped.set(name, row);
      }
      rows = [...grouped.values()];
      rows.forEach((row) => { if (ingredient(row.name)?.default_unit === 'piece') row.quantity = String(row.count); });
      draw(); renderRows();
      status(detections.length ? `${detections.length} model detection(s). Review every ingredient and enter quantities in the displayed units. Boxes show the original model output.` : 'No ingredients detected. Try a clearer photo or add ingredients manually.');
    } catch (error) { if (current === version) status(error.message); }
    finally { if (current === version) { busy = false; controls(); } }
  });

  $('[data-add]').addEventListener('click', () => {
    if (busy || submitted || pending || rows.length >= 50) return;
    rows.push({ name: '', quantity: '' }); renderRows();
    $('[data-rows]').lastElementChild.querySelector('input').focus();
  });
  $('[data-confirm-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || submitted || !rows.length) return;
    if (!pending) {
      const items = [];
      for (const row of rows) {
        const selected = ingredient(row.name);
        if (!selected) return status(`Choose a listed ingredient for "${row.name || 'the empty row'}". New dictionary entries must be agreed with the inventory team.`);
        if (!/^\d+(\.\d{1,2})?$/.test(row.quantity)) return status('Enter a positive quantity with at most two decimal places for every ingredient.');
        const [whole, fraction = ''] = row.quantity.split('.');
        const quantity = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
        if (!Number.isSafeInteger(quantity) || quantity <= 0) return status('Enter a valid positive quantity for every ingredient.');
        items.push({ ingredient_id: selected._id, quantity });
      }
      pending = { batch_id: batchId, items };
    }
    const current = version;
    busy = true; controls(); status('Adding your confirmed ingredients…');
    try {
      await api('/api/inventory/imports', 'POST', pending);
      if (current !== version) return;
      pending = undefined; submitted = true;
      $('[data-saved]').hidden = false;
      status('Added to your fridge. New ingredients are private; existing sharing settings are preserved. Start a new photo for another batch.');
    } catch (error) {
      if (current !== version) return;
      // Keep the identical batch after an uncertain network/server failure.
      if (error.status >= 400 && error.status < 500 && error.status !== 409) pending = undefined;
      status(pending ? `${error.message} Retry the same confirmation to safely check/save this batch.` : error.message);
    } finally { if (current === version) { busy = false; controls(); } }
  });
  $('[data-new]').addEventListener('click', () => { clear(); loadCatalog(); });
  $('[data-retry]').addEventListener('click', loadCatalog);
  return { open: loadCatalog, reset() { clear(); catalog = []; $('[data-catalog]').replaceChildren(); controls(); } };
}
