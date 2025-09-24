/* Camp Catanese Scholarship Database
   - Loads scholarships.json
   - Guided filter (year, non-US, degree + keyword)
   - Renders cards (hides blank datapoints)
   - Favorites saved asynchronously in IndexedDB store "favorites"
*/

const JSON_PATH = 'scholarships.json';

/* ---------------------------- IndexedDB Favorites ---------------------------- */
const FavDB = (() => {
  const DB_NAME = 'scholarshipDB';
  const STORE = 'favorites'; // “file” name as requested
  const VER = 1;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const res = fn(store);
      tx.oncomplete = () => resolve(res);
      tx.onerror = () => reject(tx.error);
    });
  }

  return {
    async getAll() {
      return withStore('readonly', store => {
        return new Promise(res => {
          const out = [];
          const req = store.openCursor();
          req.onsuccess = e => {
            const cur = e.target.result;
            if (cur) { out.push(cur.value); cur.continue(); }
            else res(out);
          };
        });
      });
    },
    async has(id) {
      return withStore('readonly', store => {
        return new Promise(res => {
          const req = store.get(id);
          req.onsuccess = () => res(!!req.result);
        });
      });
    },
    async add(fav) { return withStore('readwrite', s => s.put(fav)); },
    async remove(id) { return withStore('readwrite', s => s.delete(id)); }
  };
})();

/* ----------------------------- App State/Helpers ----------------------------- */
let RAW = [];             // original JSON rows
let FAVORITES = new Set(); // ids in favorites
let SHOW_FAVORITES_ONLY = false;

const els = {
  year: document.getElementById('yearInput'),
  nonUS: document.getElementById('nonUS'),
  degree: document.getElementById('degreeInput'),
  search: document.getElementById('searchInput'),
  form: document.getElementById('filterForm'),
  reset: document.getElementById('resetBtn'),
  count: document.getElementById('resultsCount'),
  sort: document.getElementById('sortSelect'),
  cards: document.getElementById('cards'),
  yearOptions: document.getElementById('yearOptions'),
  degreeOptions: document.getElementById('degreeOptions'),
  showAllBtn: document.getElementById('showAllBtn'),
  showFavsBtn: document.getElementById('showFavsBtn'),
};

function safeDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function daysUntil(dateStr) {
  const d = safeDate(dateStr);
  if (!d) return null;
  const ms = d - new Date();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function normalize(str) {
  return (str || '').toString().toLowerCase();
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(v => v.trim()))].sort((a,b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );
}

function buildId(row) {
  // Stable-ish id based on name + closes date
  return normalize(row['Scholarship Name']) + '|' + (row['Application Closes'] || '');
}

/* ------------------------------- Load & Init -------------------------------- */
(async function init(){
  // Load favorites first
  const favRows = await FavDB.getAll();
  FAVORITES = new Set(favRows.map(r => r.id));

  // Load JSON
  const res = await fetch(JSON_PATH, { cache: 'no-store' });
  const json = await res.json();

  // Convert tabular “headers + data” into objects with consistent keys
  RAW = (json.data || []).map(row => {
    const obj = {};
    (json.headers || []).forEach(h => { obj[h] = row[h]; });
    obj._id = buildId(obj);
    return obj;
  });

  // Build suggestion lists
  populateSuggestions();

  // Wire UI
  els.form.addEventListener('submit', e => { e.preventDefault(); render(); });
  els.reset.addEventListener('click', () => { els.form.reset(); render(); });
  els.sort.addEventListener('change', render);
  els.showAllBtn.addEventListener('click', () => { SHOW_FAVORITES_ONLY = false; render(); });
  els.showFavsBtn.addEventListener('click', () => { SHOW_FAVORITES_ONLY = true; render(); });

  // First render
  render();
})();

function populateSuggestions() {
  const years = uniqueSorted([
    ...RAW.map(r => r['Eligibility - Grade']),
    ...RAW.map(r => r['Scholarship Target Audience'])
  ]).filter(Boolean);

  const degrees = uniqueSorted([
    ...RAW.map(r => r['Eligibility - Intended Level of Study']),
    ...RAW.map(r => r['Scholarship Target Audience'])
  ]).filter(Boolean);

  els.yearOptions.innerHTML = years.map(v => `<option value="${escapeHtml(v)}">`).join('');
  els.degreeOptions.innerHTML = degrees.map(v => `<option value="${escapeHtml(v)}">`).join('');
}

/* --------------------------------- Render ---------------------------------- */
function render() {
  let rows = filterRows(RAW);

  // Sort
  const mode = els.sort.value;
  if (mode === 'nameAsc') {
    rows.sort((a,b) => (a['Scholarship Name']||'').localeCompare(b['Scholarship Name']||''));
  } else if (mode === 'amountDesc') {
    // crude numeric extraction from amount strings
    const amt = s => {
      const m = (s||'').toString().replace(/[, ]/g,'').match(/(\d+)(\.\d+)?/g);
      return m ? Math.max(...m.map(Number)) : 0;
    };
    rows.sort((a,b) => amt(b['Amount']) - amt(a['Amount']));
  } else if (mode === 'closesAsc') {
    rows.sort((a,b) => (safeDate(a['Application Closes'])||Infinity) - (safeDate(b['Application Closes'])||Infinity));
  }
  // otherwise, "relevance" is the current filtered order

  // Favorites toggle
  if (SHOW_FAVORITES_ONLY) {
    rows = rows.filter(r => FAVORITES.has(r._id));
  }

  els.count.textContent = `${rows.length} result${rows.length===1?'':'s'} ${SHOW_FAVORITES_ONLY ? '(favorites)' : ''}`;
  els.cards.innerHTML = rows.map(renderCard).join('');

  // Attach favorite handlers
  document.querySelectorAll('[data-fav]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-fav');
      const idx = rows.findIndex(r => r._id === id);
      const row = rows[idx] || RAW.find(r => r._id === id);
      const saved = FAVORITES.has(id);
      if (saved) {
        await FavDB.remove(id);
        FAVORITES.delete(id);
        btn.setAttribute('data-saved', 'false');
      } else {
        await FavDB.add({ id, name: row['Scholarship Name'], savedAt: Date.now() });
        FAVORITES.add(id);
        btn.setAttribute('data-saved', 'true');
      }
      // If showing only favorites, remove card after un-faving
      if (SHOW_FAVORITES_ONLY && !FAVORITES.has(id)) {
        btn.closest('.sch-card').remove();
        const remaining = document.querySelectorAll('.sch-card').length;
        els.count.textContent = `${remaining} result${remaining===1?'':'s'} (favorites)`;
      }
    });
  });
}

function filterRows(rows) {
  const year = normalize(els.year.value);
  const degree = normalize(els.degree.value);
  const nonUS = els.nonUS.value; // any|yes|no
  const q = normalize(els.search.value);

  return rows.filter(r => {
    // Year in school: match against Eligibility - Grade or Target Audience
    const yrMatch = !year || [r['Eligibility - Grade'], r['Scholarship Target Audience']]
      .some(v => normalize(v).includes(year));

    // Degree pursuing: match against Intended Level / Audience
    const degMatch = !degree || [r['Eligibility - Intended Level of Study'], r['Scholarship Target Audience']]
      .some(v => normalize(v).includes(degree));

    // Non-US citizenship logic:
    // - "yes": include scholarships that mention undocumented/DACA/intl OR those that do NOT explicitly require "US citizen"
    // - "no": include only ones that explicitly require US citizen/permanent resident
    const citizenshipText = normalize(r['Eligibility - USA Citizenship']);
    let usMatch = true;
    if (nonUS === 'yes') {
      const inclusive = /(non[- ]?us|undocumented|daca|international|any citizenship|noncitizen|no citizenship requirement)/.test(citizenshipText);
      const notStrict = !/(us citizen|u\.s\. citizen|permanent resident|us residency required)/.test(citizenshipText);
      usMatch = inclusive || notStrict;
    } else if (nonUS === 'no') {
      usMatch = /(us citizen|u\.s\. citizen|permanent resident)/.test(citizenshipText);
    }

    // Keyword across many fields
    const fieldsForQ = [
      'Scholarship Name','Scholarship Target Audience','About','Amount',
      'Eligbility - Specific HS/College','Eligbility - Subject/Major',
      'Eligibility - Grade','Eligibility - GPA','Eligibility - Heritage/Ethnicity',
      'Eligibility - Intended Level of Study','Eligibility - Geogrphic Location',
      'Eligbility - Financial Need','Application Requirements'
    ];
    const qMatch = !q || fieldsForQ.some(k => normalize(r[k]).includes(q));

    return yrMatch && degMatch && usMatch && qMatch;
  });
}

function renderCard(r) {
  const name = r['Scholarship Name'] || 'Scholarship';
  const about = r['About'];
  const website = r['Scholarship Website'];
  const amount = r['Amount'];
  const opens = r['Application Opens'];
  const closes = r['Application Closes'];
  const grade = r['Eligibility - Grade'];
  const level = r['Eligibility - Intended Level of Study'] || r['Scholarship Target Audience'];
  const gpa = r['Eligibility - GPA'];
  const geo = r['Eligibility - Geogrphic Location'];
  const need = r['Eligbility - Financial Need'];
  const major = r['Eligbility - Subject/Major'];
  const numAwards = r['Number of awards'];

  const days = daysUntil(closes);
  const deadlineBadge = days !== null && days <= 21
    ? `<span class="badge-deadline">Deadline Soon</span>` : '';

  const favSaved = FAVORITES.has(r._id) ? 'true' : 'false';

  const kvItem = (k,v) => (v ? `
    <div class="item">
      <span class="k">${escapeHtml(k)}</span>
      <span class="v">${escapeHtml(v)}</span>
    </div>` : '');

  const chips = [
    level && `<span class="chip">${escapeHtml(level)}</span>`,
    grade && `<span class="chip">${escapeHtml(grade)}</span>`,
    gpa && `<span class="chip">GPA ${escapeHtml(gpa)}+</span>`,
    geo && `<span class="chip">${escapeHtml(geo)}</span>`,
    need && `<span class="chip">Financial Need: ${escapeHtml(need)}</span>`,
    major && `<span class="chip">${escapeHtml(major)}</span>`
  ].filter(Boolean).join('');

  return `
  <article class="sch-card">
    <div class="sch-cover">
      ${deadlineBadge}
      <button class="favorite" title="Save to favorites" data-fav="${r._id}" data-saved="${favSaved}">⭐</button>
      <h3 class="sch-title">${escapeHtml(name)}</h3>
    </div>

    <div class="sch-body">
      ${about ? `<p class="about">${escapeHtml(about)}</p>` : ''}

      ${chips ? `<div class="chips">${chips}</div>` : ''}

      <div class="kv">
        ${kvItem('Amount', amount)}
        ${kvItem('Awards', numAwards)}
        ${kvItem('Opens', opens)}
        ${kvItem('Closes', closes)}
      </div>

      <div class="sch-actions">
        ${website ? `<a class="btn-link" href="${escapeAttr(website)}" target="_blank" rel="noopener">Scholarship Website</a>` : ''}
        <button class="btn-link secondary" data-fav="${r._id}" data-saved="${favSaved}">${FAVORITES.has(r._id) ? 'Saved' : 'Save'}</button>
      </div>
    </div>
  </article>`;
}

/* ------------------------------ Small Utilities ----------------------------- */
function escapeHtml(s) {
  return (s ?? '').toString()
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'", '&#039;');
}
function escapeAttr(s){ return escapeHtml(s).replaceAll(' ', '%20'); }
