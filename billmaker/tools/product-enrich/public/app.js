// Vanilla JS UI for the product enrichment tool.
// Keeps state in memory — refresh = reload page 1.

const state = {
  pageIdx: 0,
  pageSize: 15,
  cursors: [null],          // cursors[i] = the nextCursor used to fetch page i (or null for page 0)
  currentPage: [],          // products on the current page
  productState: {},         // productId → { description, images: [], snippets: [], imageResults: [] }
  shopCode: null,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  $('pageSize').addEventListener('change', () => {
    state.pageSize = parseInt($('pageSize').value, 10);
    state.pageIdx = 0;
    state.cursors = [null];
    loadPage();
  });
  $('prevBtn').addEventListener('click', () => {
    if (state.pageIdx > 0) {
      state.pageIdx--;
      loadPage();
    }
  });
  $('nextBtn').addEventListener('click', () => {
    state.pageIdx++;
    loadPage();
  });
  await loadPage();
}

async function loadPage() {
  const cursor = state.cursors[state.pageIdx] || null;
  const url = `/api/products?limit=${state.pageSize}` + (cursor ? `&startAfter=${encodeURIComponent(cursor)}` : '');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.currentPage = data.products;

    // Save the cursor for the NEXT page if we got a full page back.
    if (data.hasMore && data.nextCursor) {
      state.cursors[state.pageIdx + 1] = data.nextCursor;
    }

    $('pageInfo').textContent = `Page ${state.pageIdx + 1} · ${data.products.length} products`;
    $('prevBtn').disabled = state.pageIdx === 0;
    $('nextBtn').disabled = !data.hasMore;
    $('shopInfo').textContent = `Shop: portal_products from Firestore`;

    render();
  } catch (err) {
    $('products').innerHTML = `<p class="error">Failed to load products: ${escapeHtml(String(err))}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  const container = $('products');
  container.innerHTML = '';
  if (state.currentPage.length === 0) {
    container.innerHTML = '<p style="color:#64748b;">No products on this page.</p>';
    return;
  }
  for (const p of state.currentPage) {
    container.appendChild(renderProduct(p));
  }
}

function renderProduct(product) {
  // Initialize per-product state if not already set.
  if (!state.productState[product.id]) {
    state.productState[product.id] = {
      description: product.description || '',
      images: Array.isArray(product.images) ? [...product.images] : [],
      snippets: [],
      imageResults: [],
    };
  }
  const s = state.productState[product.id];

  const div = document.createElement('div');
  div.className = 'product';
  div.dataset.id = product.id;

  const hasDesc = (product.description || '').length > 0;
  const hasImages = Array.isArray(product.images) && product.images.length > 0;

  div.innerHTML = `
    <div class="product-header">
      <div class="product-name">${escapeHtml(product.name || '(unnamed)')}</div>
      <div>
        ${hasDesc ? '<span class="status-pill has-desc">desc</span>' : '<span class="status-pill">no desc</span>'}
        ${hasImages ? `<span class="status-pill has-images">${product.images.length} img</span>` : '<span class="status-pill">no img</span>'}
      </div>
    </div>
    <div class="product-body">
      <div class="section">
        <div class="section-label">Description</div>
        <textarea class="desc-input">${escapeHtml(s.description)}</textarea>
      </div>

      <div class="section">
        <div class="section-label">Selected Images</div>
        <div class="selected-images"></div>
        <div class="url-input-row">
          <input type="text" class="manual-url" placeholder="Paste image URL manually…" />
          <button class="add-url-btn">Add</button>
        </div>
      </div>

      <div class="section">
        <button class="search-btn">🔍 Search web for "${escapeHtml(product.name)}"</button>
        <span class="search-status" style="margin-left:8px"></span>
      </div>

      <div class="section search-results-text" style="display:none">
        <div class="section-label">Search Snippets (click to copy text into description)</div>
        <div class="snippets-container"></div>
      </div>

      <div class="section search-results-img" style="display:none">
        <div class="section-label">Image Results (click to add to selected)</div>
        <div class="image-grid"></div>
      </div>

      <div class="section">
        <button class="save-btn">💾 Approve &amp; Save to Firestore</button>
        <span class="save-status" style="margin-left:8px"></span>
      </div>
    </div>
  `;

  // ---- wire events ----
  const header = div.querySelector('.product-header');
  header.addEventListener('click', () => div.classList.toggle('open'));

  const descInput = div.querySelector('.desc-input');
  descInput.addEventListener('input', () => {
    s.description = descInput.value;
  });

  const manualUrlInput = div.querySelector('.manual-url');
  const addUrlBtn = div.querySelector('.add-url-btn');
  addUrlBtn.addEventListener('click', () => {
    const url = manualUrlInput.value.trim();
    if (url) {
      s.images.push(url);
      manualUrlInput.value = '';
      renderSelectedImages(div, product.id);
    }
  });

  const searchBtn = div.querySelector('.search-btn');
  searchBtn.addEventListener('click', () => doSearch(div, product));

  const saveBtn = div.querySelector('.save-btn');
  saveBtn.addEventListener('click', () => doSave(div, product));

  // initial draw of selected images
  renderSelectedImages(div, product.id);

  // if we already searched for this product earlier, restore the results
  if (s.snippets.length) renderSnippets(div, product.id);
  if (s.imageResults.length) renderImageResults(div, product.id);

  return div;
}

function renderSelectedImages(productDiv, productId) {
  const container = productDiv.querySelector('.selected-images');
  const s = state.productState[productId];
  if (!s.images.length) {
    container.innerHTML = '<span style="color:#94a3b8;font-size:12px;">No images selected yet.</span>';
    return;
  }
  container.innerHTML = '';
  s.images.forEach((url, idx) => {
    const tile = document.createElement('div');
    tile.className = 'selected-tile';
    tile.innerHTML = `
      <img src="${escapeAttr(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity=0.3"/>
      <button class="remove-btn" title="Remove">×</button>
    `;
    tile.querySelector('.remove-btn').addEventListener('click', () => {
      s.images.splice(idx, 1);
      renderSelectedImages(productDiv, productId);
    });
    container.appendChild(tile);
  });
}

function renderSnippets(productDiv, productId) {
  const s = state.productState[productId];
  const container = productDiv.querySelector('.snippets-container');
  const wrap = productDiv.querySelector('.search-results-text');
  if (!s.snippets.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  container.innerHTML = '';
  for (const snip of s.snippets) {
    const el = document.createElement('div');
    el.className = 'snippet';
    el.innerHTML = `
      <div class="snippet-title">${escapeHtml(snip.title || '')}</div>
      <div class="snippet-link">${escapeHtml(snip.displayLink || snip.link || '')}</div>
      <div class="snippet-text">${escapeHtml(snip.snippet || '')}</div>
    `;
    el.addEventListener('click', () => {
      const textarea = productDiv.querySelector('.desc-input');
      const cur = textarea.value;
      textarea.value = cur ? cur + '\n' + (snip.snippet || '') : (snip.snippet || '');
      s.description = textarea.value;
    });
    container.appendChild(el);
  }
}

function renderImageResults(productDiv, productId) {
  const s = state.productState[productId];
  const grid = productDiv.querySelector('.image-grid');
  const wrap = productDiv.querySelector('.search-results-img');
  if (!s.imageResults.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  grid.innerHTML = '';
  for (const img of s.imageResults) {
    const tile = document.createElement('div');
    tile.className = 'image-tile';
    const isSelected = s.images.includes(img.url);
    if (isSelected) tile.classList.add('selected');
    tile.innerHTML = `<img src="${escapeAttr(img.thumbnail || img.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.opacity=0.3"/>`;
    tile.title = `${img.width || '?'}×${img.height || '?'} · ${img.mime || ''}\n${img.url}`;
    tile.addEventListener('click', () => {
      const idx = s.images.indexOf(img.url);
      if (idx >= 0) {
        s.images.splice(idx, 1);
      } else {
        s.images.push(img.url);
      }
      renderSelectedImages(productDiv, productId);
      renderImageResults(productDiv, productId);
    });
    grid.appendChild(tile);
  }
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------
async function doSearch(productDiv, product) {
  const status = productDiv.querySelector('.search-status');
  status.textContent = 'Searching…';
  status.className = 'search-status loading';
  const btn = productDiv.querySelector('.search-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: product.name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    state.productState[product.id].snippets = data.snippets || [];
    state.productState[product.id].imageResults = data.images || [];
    status.textContent = `✓ ${data.snippets?.length || 0} snippets, ${data.images?.length || 0} images`;
    status.className = 'search-status';
    renderSnippets(productDiv, product.id);
    renderImageResults(productDiv, product.id);
  } catch (err) {
    status.textContent = `✗ ${String(err.message || err)}`;
    status.className = 'search-status error';
  } finally {
    btn.disabled = false;
  }
}

async function doSave(productDiv, product) {
  const status = productDiv.querySelector('.save-status');
  status.textContent = 'Saving…';
  status.className = 'save-status loading';
  const btn = productDiv.querySelector('.save-btn');
  btn.disabled = true;
  const s = state.productState[product.id];
  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: product.id,
        description: s.description,
        images: s.images,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    status.textContent = '✓ Saved';
    status.className = 'save-status';
    // Update the in-memory product so the status pills refresh next render.
    product.description = s.description;
    product.images = [...s.images];
    // Refresh just this product's pills without full reload.
    const pills = productDiv.querySelector('.product-header > div:last-child');
    const hasDesc = (product.description || '').length > 0;
    const hasImages = product.images.length > 0;
    pills.innerHTML = `
      ${hasDesc ? '<span class="status-pill has-desc">desc</span>' : '<span class="status-pill">no desc</span>'}
      ${hasImages ? `<span class="status-pill has-images">${product.images.length} img</span>` : '<span class="status-pill">no img</span>'}
    `;
  } catch (err) {
    status.textContent = `✗ ${String(err.message || err)}`;
    status.className = 'save-status error';
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) {
  return escapeHtml(s);
}

init();
