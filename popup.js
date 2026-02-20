// ============================================================
// Workshop Trend Calculator - Chrome Extension
// Keyed by advisor code + location (same code, different city = separate record)
// ============================================================

/*
  Data model stored in chrome.storage.local:
  {
    advisors: {
      "AVL|Greenbelt, MD": {
        code: "AVL",
        location: "Greenbelt, MD",
        workshops: [ ... ]
      },
      "AVL|Richmond, VA": { ... },
      ...
    },
    forecasts: {
      "AVL|Greenbelt, MD": { currentFeds: "", currentSps: "", target: "35" },
      ...
    }
  }
*/

let advisors = {};
let forecasts = {};

function advisorKey(code, location) {
  return code + '|' + (location || '').trim();
}

function parseAdvisorKey(key) {
  const idx = key.indexOf('|');
  return { code: key.substring(0, idx), location: key.substring(idx + 1) };
}

function safeId(key) {
  return key.replace(/[^a-zA-Z0-9]/g, '_');
}

// --- Storage ---
function saveData() {
  chrome.storage.local.set({ advisors, forecasts });
}

function loadData(cb) {
  chrome.storage.local.get(['advisors', 'forecasts'], (result) => {
    if (result.advisors) advisors = result.advisors;
    if (result.forecasts) forecasts = result.forecasts;
    cb();
  });
}

// --- Date & Number Parsing ---
function parseDate(val) {
  if (!val) return '';
  val = String(val).trim();
  if (/^\d{1,4}(\.\d+)?$/.test(val)) return '';
  if (val.includes('%')) return '';
  let m = val.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  m = val.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  if (/[\/\-]/.test(val) || /[a-zA-Z]/.test(val)) {
    const d = new Date(val);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 2000) return d.toISOString().slice(0, 10);
  }
  return '';
}

function parseNum(val) {
  if (!val || val === '') return 0;
  const s = String(val).replace(/%/g, '').replace(/[^0-9.\-]/g, '');
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

// --- Label Matching ---
const LABEL_MAP = [
  { field: 'workshopDate',       patterns: [/^\s*date\s*$/i] },
  { field: 'totalFedsClose',     patterns: [/feds?\s*@?\s*close/i, /feds\s*at\s*close/i] },
  { field: 'totalSpsClose',      patterns: [/sps?\s*@?\s*close/i, /spouse.*close/i] },
  { field: 'totalFedConfirmed',  patterns: [/confirmed?\s*fed/i, /fed.*confirmed/i] },
  { field: 'totalSpsConfirmed',  patterns: [/confirmed?\s*sp/i, /spouse.*confirmed/i] },
  { field: 'totalFedsAttended',  patterns: [/feds?\s*attended/i] },
  { field: 'totalSpsAttended',   patterns: [/sps?\s*attended/i, /spouse.*attended/i] },
  { field: 'totalWalkins',       patterns: [/walk\s*-?\s*in/i, /true\s*walk/i] },
  { field: 'totalYes',           patterns: [/yes\s*report/i, /total\s*yes/i, /said\s*yes/i] },
];

function matchLabel(text) {
  if (!text) return null;
  const t = String(text).trim();
  for (const entry of LABEL_MAP) {
    for (const pat of entry.patterns) {
      if (pat.test(t)) return entry.field;
    }
  }
  return null;
}

// --- Parse Pasted Advisor Block ---
function parsePastedAdvisorBlock(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) throw new Error('No data found.');

  // Step 1: Extract advisor code and location from the first line
  // The first line should contain the advisor code in column A and location in column B
  // e.g. "AVL\tGreenbelt, MD\t\t..." or the code might be alone
  let advisorCode = '';
  let location = '';

  // Check first few lines for the advisor code line (row 1 in the sheet)
  // Row 1 has the code + location, Row 2 starts with "Date" label
  const firstCols = lines[0].split('\t');
  
  // Find which line has the "Date" label to determine where data starts
  let dataStartLine = 0;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const cols = lines[i].split('\t');
    // Check if any column in this row has a label we recognize
    const hasLabel = cols.some(c => matchLabel(c));
    if (hasLabel) {
      dataStartLine = i;
      break;
    }
  }

  // Everything before the first label row is header info
  if (dataStartLine > 0) {
    // First line has the advisor code info
    const headerCols = lines[0].split('\t');
    // Find non-empty cells in the header
    const nonEmpty = headerCols.filter(c => c.trim());
    if (nonEmpty.length >= 1) {
      advisorCode = nonEmpty[0].trim().toUpperCase();
      if (nonEmpty.length >= 2) location = nonEmpty[1].trim();
    }
  } else {
    // No separate header line — check if column A of the first data line has a code
    // This handles cases where the code is in A1 and "Date" label is in B2
    // Look at the first column of the first line
    const col0 = firstCols[0].trim();
    if (col0 && !matchLabel(col0)) {
      advisorCode = col0.toUpperCase();
      // Check if second column of first line is location (not a label)
      if (firstCols.length > 1 && !matchLabel(firstCols[1]) && firstCols[1].trim()) {
        location = firstCols[1].trim();
      }
    }
  }

  // Step 2: Parse the vertical data (labels in one column, workshops across)
  const fieldData = {};
  let labelColIdx = -1; // which column has the labels

  // Detect label column index by scanning first data lines
  for (let i = dataStartLine; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    for (let c = 0; c < Math.min(cols.length, 3); c++) {
      if (matchLabel(cols[c])) {
        labelColIdx = c;
        break;
      }
    }
    if (labelColIdx >= 0) break;
  }

  if (labelColIdx < 0) {
    throw new Error('Could not find row labels (Date, Total Feds @ Close, etc.) in the pasted data. Make sure you\'re copying the full stats block.');
  }

  // If no advisor code found yet, check column before the label column
  if (!advisorCode && labelColIdx > 0) {
    // Look for code in column A of the first line
    const fc = lines[0].split('\t');
    if (fc[0] && fc[0].trim() && !matchLabel(fc[0])) {
      advisorCode = fc[0].trim().toUpperCase();
    }
  }

  // Build field data from labeled rows
  for (let i = dataStartLine; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const label = cols[labelColIdx];
    const field = matchLabel(label);
    if (!field) continue;
    // Values are all columns after the label column
    fieldData[field] = cols.slice(labelColIdx + 1);
  }

  if (!fieldData.workshopDate) {
    throw new Error('Could not find a "Date" row. Make sure you\'re copying from row 2 (Date) downward.');
  }

  // Step 3: Find columns with valid dates (skip count/average columns)
  const dateRow = fieldData.workshopDate;
  const workshopCols = [];
  for (let i = 0; i < dateRow.length; i++) {
    if (parseDate(dateRow[i])) workshopCols.push(i);
  }

  if (workshopCols.length === 0) {
    throw new Error('No valid workshop dates found. Make sure to include the date columns when copying.');
  }

  // Step 4: Build workshop objects
  const workshops = [];
  for (const ci of workshopCols) {
    const ws = {
      workshopDate: parseDate(fieldData.workshopDate[ci]),
      totalFedsClose: fieldData.totalFedsClose ? parseNum(fieldData.totalFedsClose[ci]) : 0,
      totalSpsClose: fieldData.totalSpsClose ? parseNum(fieldData.totalSpsClose[ci]) : 0,
      totalFedConfirmed: fieldData.totalFedConfirmed ? parseNum(fieldData.totalFedConfirmed[ci]) : 0,
      totalSpsConfirmed: fieldData.totalSpsConfirmed ? parseNum(fieldData.totalSpsConfirmed[ci]) : 0,
      totalFedsAttended: fieldData.totalFedsAttended ? parseNum(fieldData.totalFedsAttended[ci]) : 0,
      totalSpsAttended: fieldData.totalSpsAttended ? parseNum(fieldData.totalSpsAttended[ci]) : 0,
      totalWalkins: fieldData.totalWalkins ? parseNum(fieldData.totalWalkins[ci]) : 0,
      totalYes: fieldData.totalYes ? parseNum(fieldData.totalYes[ci]) : 0,
    };
    // Only keep completed workshops
    if (ws.totalFedsClose > 0 && ws.totalFedsAttended > 0) {
      workshops.push(ws);
    }
  }

  if (workshops.length === 0) {
    throw new Error('No completed workshops found (all rows had 0 attendance — they may be future workshops).');
  }

  if (!advisorCode) {
    throw new Error('Could not detect an advisor code. Make sure to include column A (with the code like AVL, CFG, etc.) when copying.');
  }

  return { code: advisorCode, location, workshops };
}

// --- Calculations ---
function computeWorkshopStats(ws) {
  const totalRegClose = ws.totalFedsClose + ws.totalSpsClose;
  const totalConfirmed = ws.totalFedConfirmed + (ws.totalSpsConfirmed || 0);
  const totalAttended = ws.totalFedsAttended + ws.totalSpsAttended;
  if (totalRegClose === 0) return null;

  const confirmationRate = totalConfirmed > 0 ? totalConfirmed / totalRegClose : 0;
  const attendanceOfConfirmed = totalConfirmed > 0 ? totalAttended / totalConfirmed : 0;

  const unconfirmedCount = totalRegClose - totalConfirmed;
  let unconfirmedShowRate = 0;
  if (unconfirmedCount > 0 && totalConfirmed > 0) {
    unconfirmedShowRate = ((totalAttended - ws.totalWalkins) - (totalConfirmed * attendanceOfConfirmed)) / unconfirmedCount;
  }

  let effectiveShowRate = confirmationRate * attendanceOfConfirmed + (1 - confirmationRate) * unconfirmedShowRate;
  if (isNaN(effectiveShowRate) || !isFinite(effectiveShowRate)) {
    effectiveShowRate = (totalAttended - ws.totalWalkins) / totalRegClose;
  }

  return { totalRegClose, totalConfirmed, totalAttended, confirmationRate, attendanceOfConfirmed, effectiveShowRate, walkins: ws.totalWalkins };
}

function computeRecencyWeighted(workshopList) {
  const today = new Date();
  const today_ms = today.getTime();
  let srNum = 0, srDen = 0, wkNum = 0, wkDen = 0;

  workshopList.forEach(ws => {
    const stats = computeWorkshopStats(ws);
    if (!stats) return;
    const wsDate = new Date(ws.workshopDate);
    if (wsDate >= today) return;
    const days = Math.floor((today_ms - wsDate.getTime()) / 86400000) + 1;
    const w = 1 / days;
    if (!isNaN(stats.effectiveShowRate) && isFinite(stats.effectiveShowRate)) {
      srNum += stats.effectiveShowRate * w;
      srDen += w;
    }
    wkNum += stats.walkins * w;
    wkDen += w;
  });

  return {
    showRate: srDen > 0 ? srNum / srDen : 0,
    avgWalkins: wkDen > 0 ? wkNum / wkDen : 0,
  };
}

// --- UI ---
function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showMsg(text, isError) {
  const el = document.getElementById('paste-msg');
  el.className = isError ? 'msg msg-err' : 'msg msg-ok';
  el.textContent = text;
  setTimeout(() => { el.textContent = ''; el.className = ''; }, 6000);
}

function renderAll() {
  renderForecast();
  renderStoredData();
}

function renderForecast() {
  const container = document.getElementById('forecast-rows');
  const warning = document.getElementById('no-data-warning');
  const keys = Object.keys(advisors).sort();

  if (keys.length === 0) {
    warning.style.display = 'block';
    container.innerHTML = '';
    return;
  }
  warning.style.display = 'none';

  // Ensure each advisor has a forecast entry
  keys.forEach(key => {
    if (!forecasts[key]) forecasts[key] = { currentFeds: '', currentSps: '', target: '35' };
  });

  container.innerHTML = keys.map(key => {
    const adv = advisors[key];
    const fc = forecasts[key];
    const { showRate, avgWalkins } = computeRecencyWeighted(adv.workshops);

    const feds = Number(fc.currentFeds) || 0;
    const sps = Number(fc.currentSps) || 0;
    const totalReg = feds + sps;
    const target = Number(fc.target) || 0;

    const expectedAtt = totalReg > 0 ? totalReg * showRate + avgWalkins : 0;
    const closeAt = target > 0 && showRate > 0 ? Math.ceil(Math.max(0, (target - avgWalkins) / showRate)) : 0;
    const shouldClose = totalReg > 0 && closeAt > 0 && totalReg >= closeAt;
    const hasData = totalReg > 0 && target > 0;

    const borderClass = hasData ? (shouldClose ? 'close' : 'open') : '';
    const resultStr = hasData
      ? `${adv.code} ${adv.location}: ${totalReg} is ${shouldClose ? 'at/above' : 'below'} ${closeAt}: ${shouldClose ? 'CLOSE' : 'KEEP OPEN'}`
      : '';
    const sid = safeId(key);

    return `
      <div class="forecast-row ${borderClass}" data-key="${esc(key)}">
        <div class="forecast-header">
          <span class="advisor-badge">${esc(adv.code)}</span>
          <span class="advisor-location">${esc(adv.location)}</span>
          <span class="advisor-meta">${adv.workshops.length} ws · ${(showRate * 100).toFixed(1)}% show rate</span>
        </div>
        <div class="forecast-inputs">
          <div class="field">
            <label>Current Feds Registered</label>
            <input type="number" value="${esc(fc.currentFeds)}" data-key="${esc(key)}" data-field="currentFeds" placeholder="0">
          </div>
          <div class="field">
            <label>Current Spouses Registered</label>
            <input type="number" value="${esc(fc.currentSps)}" data-key="${esc(key)}" data-field="currentSps" placeholder="0">
          </div>
          <div class="field">
            <label>Target Attendance</label>
            <input type="number" value="${esc(fc.target)}" data-key="${esc(key)}" data-field="target" placeholder="35">
          </div>
        </div>
        ${hasData ? `
        <div class="forecast-results-wrap">
        <div class="forecast-results">
          <div class="result-item">
            <div class="rlabel">Currently Reg</div>
            <div class="rvalue">${totalReg}</div>
          </div>
          <div class="result-item">
            <div class="rlabel">Expected Att.</div>
            <div class="rvalue amber">${expectedAtt.toFixed(1)}</div>
          </div>
          <div class="result-item">
            <div class="rlabel">Close At</div>
            <div class="rvalue">${closeAt}</div>
          </div>
          <div class="result-item">
            <div class="rlabel">Decision</div>
            <span class="badge ${shouldClose ? 'badge-close' : 'badge-open'}">${shouldClose ? 'CLOSE' : 'KEEP OPEN'}</span>
            <div class="decision-note">${totalReg} ${shouldClose ? '≥' : '<'} ${closeAt}</div>
          </div>
        </div>
        ${resultStr ? `<button class="copy-btn" data-action="copy-result" data-text="${esc(resultStr)}">📋 Copy result</button>` : ''}
        </div>
        ` : ''}
      </div>
    `;
  }).join('');

  // Bind input events — update results in-place without re-rendering inputs
  container.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const key = e.target.dataset.key;
      const field = e.target.dataset.field;
      if (!forecasts[key]) forecasts[key] = { currentFeds: '', currentSps: '', target: '35' };
      forecasts[key][field] = e.target.value;
      saveData();
      updateForecastResults(key);
    });
  });
}

function updateForecastResults(key) {
  const adv = advisors[key];
  if (!adv) return;
  const fc = forecasts[key] || { currentFeds: '', currentSps: '', target: '35' };
  const { showRate, avgWalkins } = computeRecencyWeighted(adv.workshops);

  const feds = Number(fc.currentFeds) || 0;
  const sps = Number(fc.currentSps) || 0;
  const totalReg = feds + sps;
  const target = Number(fc.target) || 0;

  const expectedAtt = totalReg > 0 ? totalReg * showRate + avgWalkins : 0;
  const closeAt = target > 0 && showRate > 0 ? Math.ceil(Math.max(0, (target - avgWalkins) / showRate)) : 0;
  const shouldClose = totalReg > 0 && closeAt > 0 && totalReg >= closeAt;
  const hasData = totalReg > 0 && target > 0;

  const row = document.querySelector(`.forecast-row[data-key="${CSS.escape(key)}"]`);
  if (!row) return;

  // Update border
  row.classList.remove('close', 'open');
  if (hasData) row.classList.add(shouldClose ? 'close' : 'open');

  // Update or create results section
  let resultsEl = row.querySelector('.forecast-results-wrap');
  const resultStr = hasData
    ? `${adv.code} ${adv.location}: ${totalReg} is ${shouldClose ? 'at/above' : 'below'} ${closeAt}: ${shouldClose ? 'CLOSE' : 'KEEP OPEN'}`
    : '';

  if (!hasData) {
    if (resultsEl) resultsEl.remove();
    return;
  }

  const html = `
    <div class="forecast-results">
      <div class="result-item">
        <div class="rlabel">Currently Reg</div>
        <div class="rvalue">${totalReg}</div>
      </div>
      <div class="result-item">
        <div class="rlabel">Expected Att.</div>
        <div class="rvalue amber">${expectedAtt.toFixed(1)}</div>
      </div>
      <div class="result-item">
        <div class="rlabel">Close At</div>
        <div class="rvalue">${closeAt}</div>
      </div>
      <div class="result-item">
        <div class="rlabel">Decision</div>
        <span class="badge ${shouldClose ? 'badge-close' : 'badge-open'}">${shouldClose ? 'CLOSE' : 'KEEP OPEN'}</span>
        <div class="decision-note">${totalReg} ${shouldClose ? '≥' : '<'} ${closeAt}</div>
      </div>
    </div>
    ${resultStr ? `<button class="copy-btn" data-action="copy-result" data-text="${esc(resultStr)}">📋 Copy result</button>` : ''}
  `;

  if (resultsEl) {
    resultsEl.innerHTML = html;
  } else {
    resultsEl = document.createElement('div');
    resultsEl.className = 'forecast-results-wrap';
    resultsEl.innerHTML = html;
    row.appendChild(resultsEl);
  }
}

function renderStoredData() {
  const list = document.getElementById('advisor-list');
  const countEl = document.getElementById('total-count');
  const keys = Object.keys(advisors).sort();

  if (keys.length === 0) {
    countEl.textContent = '';
    list.innerHTML = '<div class="empty-msg">No advisors stored yet. Use "Paste Data" to import.</div>';
    return;
  }

  const totalWs = keys.reduce((sum, k) => sum + advisors[k].workshops.length, 0);
  countEl.textContent = `${keys.length} advisor record${keys.length !== 1 ? 's' : ''} · ${totalWs} total workshops`;

  list.innerHTML = keys.map(key => {
    const adv = advisors[key];
    const sid = safeId(key);
    const sorted = [...adv.workshops].sort((a, b) => new Date(b.workshopDate) - new Date(a.workshopDate));

    const rows = sorted.map(ws => {
      const s = computeWorkshopStats(ws);
      if (!s) return '';
      return `<tr>
        <td>${ws.workshopDate}</td>
        <td>${s.totalRegClose}</td>
        <td>${s.totalConfirmed}</td>
        <td>${s.totalAttended}</td>
        <td>${s.walkins}</td>
        <td class="lightblue">${(s.confirmationRate * 100).toFixed(1)}%</td>
        <td class="green">${(s.effectiveShowRate * 100).toFixed(1)}%</td>
      </tr>`;
    }).join('');

    return `
      <div class="advisor-card" data-key="${esc(key)}">
        <div class="advisor-card-header" data-action="toggle-card" data-sid="${sid}">
          <span class="advisor-card-toggle" id="toggle-${sid}">▶</span>
          <span class="advisor-badge">${esc(adv.code)}</span>
          <span class="advisor-location">${esc(adv.location)}</span>
          <span class="advisor-meta">${adv.workshops.length} workshop${adv.workshops.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="advisor-card-body" id="body-${sid}">
          <table class="history-table">
            <thead><tr>
              <th>Date</th><th>Reg@Close</th><th>Confirmed</th><th>Attended</th>
              <th>Walk-ins</th><th>Conf Rate</th><th>Show Rate</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="delete-section">
            <button class="btn btn-danger btn-sm" data-action="delete-advisor" data-key="${esc(key)}">Delete ${esc(adv.code)} ${esc(adv.location)}</button>
            <span class="warn-text">Removes all history for this advisor/location</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// --- Event Handlers ---
document.addEventListener('DOMContentLoaded', () => {
  loadData(() => renderAll());

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
    });
  });

  // Import
  document.getElementById('btn-import').addEventListener('click', () => {
    const text = document.getElementById('paste-area').value;
    if (!text.trim()) { showMsg('Nothing to paste.', true); return; }
    try {
      const result = parsePastedAdvisorBlock(text);
      const key = advisorKey(result.code, result.location);
      const isNew = !advisors[key];

      if (isNew) {
        advisors[key] = { code: result.code, location: result.location, workshops: result.workshops };
      } else {
        // Merge workshops: overwrite by date, add new ones
        const existingByDate = {};
        advisors[key].workshops.forEach(ws => { existingByDate[ws.workshopDate] = ws; });
        result.workshops.forEach(ws => { existingByDate[ws.workshopDate] = ws; });
        advisors[key].workshops = Object.values(existingByDate);
      }

      // Ensure forecast entry exists
      if (!forecasts[key]) forecasts[key] = { currentFeds: '', currentSps: '', target: '35' };

      saveData();
      document.getElementById('paste-area').value = '';
      const verb = isNew ? 'Added' : 'Updated';
      showMsg(`${verb} ${result.code} (${result.location}) — ${result.workshops.length} completed workshop(s).`, false);
      renderAll();
    } catch (e) {
      showMsg(e.message, true);
    }
  });

  // Delegated clicks
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    if (btn.dataset.action === 'toggle-card') {
      const sid = btn.dataset.sid;
      const body = document.getElementById('body-' + sid);
      const toggle = document.getElementById('toggle-' + sid);
      body.classList.toggle('show');
      toggle.classList.toggle('expanded');
    }

    if (btn.dataset.action === 'delete-advisor') {
      const key = btn.dataset.key;
      const adv = advisors[key];
      const label = adv ? `${adv.code} (${adv.location})` : key;
      if (confirm(`Delete all data for ${label}? This cannot be undone.`)) {
        delete advisors[key];
        delete forecasts[key];
        saveData();
        renderAll();
      }
    }

    if (btn.dataset.action === 'copy-result') {
      navigator.clipboard.writeText(btn.dataset.text).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      });
    }
  });
});
