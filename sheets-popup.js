/**
 * sheets-popup.js
 * Loaded inside the Sheets popup window.
 * window._pdfUrls and window._unitNames are set by the inline script before this loads.
 */

// ── WARRIOR DATA field positions ─────────────────────────────────────────────
// Percentages from the LEFT edge (xPct) and from the TOP edge (yPct) of the page.
// Use 🎯 Calibrate Positions to set these precisely on your actual sheets.
var PILOT_POS = {
  name: { xPct: 0.597, yPct: 0.091 },  // after "Name:"
  gu:   { xPct: 0.646, yPct: 0.110 },  // after "Gunnery Skill:"
  pi:   { xPct: 0.833, yPct: 0.110 },  // after "Piloting Skill:"
  size: 7.5                              // font size in points
};

/* ── Export unit list for merge_sheets.py ────────────────────────────────── */
function exportUnitList() {
  var names = window._unitNames || [];
  if (!names.length) { alert('No units in formation.'); return; }
  var blob = new Blob([names.join('\n')], { type: 'text/plain' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'formation-sheets.txt';
  a.click();
}

/* ── Calibration tool ────────────────────────────────────────────────────── */
// Renders the first sheet on a canvas; click Name → GU → PI fields in order.
// Applies immediately for the session and shows code to paste into sheets-popup.js.

var _calStep   = 0;
var _calFields = ['name', 'gu', 'pi'];
var _calLabels = [
  'Step 1 of 3 — Click right after the "Name:" label in the WARRIOR DATA box',
  'Step 2 of 3 — Click right after the "Gunnery Skill:" label',
  'Step 3 of 3 — Click right after the "Piloting Skill:" label'
];

async function calibratePilotPos() {
  var urls = window._pdfUrls || [];
  if (!urls.length) { alert('No PDFs loaded — build a formation with sheets first.'); return; }
  if (!window.pdfjsLib) {
    alert('pdf.js is not loaded yet. Wait a moment for the page to finish loading, then try again.');
    return;
  }

  try {

  // Fetch first PDF
  var resp = await fetch(urls[0], { mode: 'cors' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' fetching PDF');
  var buf  = await resp.arrayBuffer();
  var pdf  = await pdfjsLib.getDocument({ data: buf }).promise;
  var page = await pdf.getPage(1);
  var nativeVp = page.getViewport({ scale: 1 });
  var scale    = Math.min(1.5, (window.innerWidth - 40) / nativeVp.width);
  var vp       = page.getViewport({ scale: scale });

  // ── Build full-screen overlay ──
  var ov = document.createElement('div');
  ov.style.cssText = [
    'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;',
    'display:flex;flex-direction:column;align-items:center;overflow:auto;gap:0;'
  ].join('');

  var banner = document.createElement('div');
  banner.style.cssText = [
    'width:100%;padding:10px 16px;background:#0d47a1;color:#fff;',
    'font-size:13px;font-weight:700;text-align:center;flex-shrink:0;'
  ].join('');
  banner.textContent = _calLabels[0];

  var hint = document.createElement('div');
  hint.style.cssText = 'width:100%;padding:4px 16px;background:#1a237e;color:#90caf9;font-size:11px;text-align:center;flex-shrink:0;';
  hint.textContent = 'Zoom in or scroll to find the WARRIOR DATA box (upper-right of the sheet). Crosshair shows cursor position.';

  var canvas = document.createElement('canvas');
  canvas.width  = vp.width;
  canvas.height = vp.height;
  canvas.style.cssText = 'cursor:crosshair;border:3px solid #ffd600;display:block;flex-shrink:0;max-width:100%;';

  var closeBtn = document.createElement('button');
  closeBtn.textContent = '✕ Cancel calibration';
  closeBtn.style.cssText = 'margin:10px;padding:6px 22px;background:#b71c1c;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;flex-shrink:0;';
  closeBtn.onclick = function() { document.body.removeChild(ov); };

  ov.appendChild(banner);
  ov.appendChild(hint);
  ov.appendChild(canvas);
  ov.appendChild(closeBtn);
  document.body.appendChild(ov);

  // Render page
  var ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  var baseImg = ctx.getImageData(0, 0, canvas.width, canvas.height);
  var dots = [];

  // Helper: convert mouse event → canvas pixel coords
  function evToCanvas(e) {
    var r  = canvas.getBoundingClientRect();
    var sx = canvas.width  / r.width;
    var sy = canvas.height / r.height;
    return { px: (e.clientX - r.left) * sx, py: (e.clientY - r.top) * sy };
  }

  // Redraw base + dots + crosshair
  function redraw(crossX, crossY) {
    ctx.putImageData(baseImg, 0, 0);
    dots.forEach(function(d) {
      // Dot
      ctx.fillStyle = d.c;
      ctx.beginPath(); ctx.arc(d.x, d.y, 6, 0, Math.PI * 2); ctx.fill();
      // Label
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(d.label, d.x + 9, d.y + 4);
    });
    if (crossX !== undefined) {
      ctx.strokeStyle = 'rgba(255,214,0,.65)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(crossX, 0); ctx.lineTo(crossX, canvas.height); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, crossY); ctx.lineTo(canvas.width, crossY);  ctx.stroke();
    }
  }

  canvas.addEventListener('mousemove', function(e) {
    var c = evToCanvas(e);
    redraw(c.px, c.py);
  });

  _calStep = 0;
  var newPos = {};
  var dotColors = ['#f44336', '#4caf50', '#2196f3'];
  var dotLabels = ['Name', 'GU', 'PI'];

  canvas.addEventListener('click', function handler(e) {
    var c    = evToCanvas(e);
    var xPct = Math.round(c.px / canvas.width  * 1000) / 1000;
    var yPct = Math.round(c.py / canvas.height * 1000) / 1000;

    dots.push({ x: c.px, y: c.py, c: dotColors[_calStep % 3], label: dotLabels[_calStep] });
    newPos[_calFields[_calStep]] = { xPct: xPct, yPct: yPct };
    _calStep++;

    if (_calStep < _calFields.length) {
      banner.textContent = _calLabels[_calStep];
      redraw();
    } else {
      // All 3 clicked — apply and show result
      canvas.removeEventListener('click', handler);
      redraw();

      PILOT_POS.name = newPos.name;
      PILOT_POS.gu   = newPos.gu;
      PILOT_POS.pi   = newPos.pi;

      var code = 'var PILOT_POS = {\n' +
        '  name: ' + JSON.stringify(newPos.name) + ',\n' +
        '  gu:   ' + JSON.stringify(newPos.gu)   + ',\n' +
        '  pi:   ' + JSON.stringify(newPos.pi)   + ',\n' +
        '  size: 7.5\n};';

      banner.textContent = '✅ Calibration applied! Test with Download as One PDF, then paste into sheets-popup.js to make it permanent:';
      banner.style.background = '#1b5e20';
      hint.style.display = 'none';

      var ta = document.createElement('textarea');
      ta.readOnly = true;
      ta.value = code;
      ta.style.cssText = [
        'width:90%;max-width:640px;height:110px;',
        'font-family:monospace;font-size:12px;',
        'background:#111;color:#8bc34a;border:1px solid #333;',
        'padding:8px;margin:8px 0;display:block;resize:none;flex-shrink:0;'
      ].join('');
      ta.addEventListener('focus', function() { ta.select(); document.execCommand('copy'); });
      ta.title = 'Click to select & copy';

      var applyBtn = document.createElement('button');
      applyBtn.textContent = '✓ Close & test Download as One PDF';
      applyBtn.style.cssText = 'margin:6px;padding:7px 22px;background:#2e7d32;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;flex-shrink:0;';
      applyBtn.onclick = function() { document.body.removeChild(ov); };

      ov.insertBefore(ta, closeBtn);
      ov.insertBefore(applyBtn, closeBtn);
      closeBtn.textContent = '✕ Cancel (discard calibration)';
    }
  });

  } catch(err) {
    console.error('Calibration error:', err);
    alert('Calibration failed: ' + err.message + '\n\nCheck the browser console (F12) for details.');
    var existing = document.getElementById('cal-overlay');
    if (existing) document.body.removeChild(existing);
  }
}

/* ── Merge PDFs, burn in pilot data, then print or download ─────────────── */
async function mergeAllPdfs(action) {
  var printBtn = document.getElementById('btn-print-all');
  var dlBtn    = document.getElementById('btn-dl-all');
  var prog     = document.getElementById('merge-progress');
  [printBtn, dlBtn].forEach(function(b) { b.disabled = true; });

  try {
    prog.textContent = 'Loading pdf-lib\u2026';
    var mod           = await import('https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js');
    var PDFDocument   = mod.PDFDocument;
    var StandardFonts = mod.StandardFonts;
    var rgb           = mod.rgb;

    var urls = window._pdfUrls || [];
    if (!urls.length) {
      prog.textContent = 'No sheets found to merge \u2014 all units are missing PDFs.';
      return;
    }

    // ── Collect pilot data from the UI inputs, keyed by pdf-index ────────────
    var pilotData = urls.map(function() { return { name: '', gu: '', pi: '' }; });
    document.querySelectorAll('.pilot-bar[data-pdf-index]').forEach(function(bar) {
      var idx = parseInt(bar.getAttribute('data-pdf-index'), 10);
      if (isNaN(idx) || idx < 0 || idx >= pilotData.length) return;
      var nameEl = bar.querySelector('.pilot-name');
      var skills = bar.querySelectorAll('.pilot-skill');
      pilotData[idx].name = nameEl    ? nameEl.value.trim()    : '';
      pilotData[idx].gu   = skills[0] ? skills[0].value.trim() : '';
      pilotData[idx].pi   = skills[1] ? skills[1].value.trim() : '';
    });

    // ── Build merged PDF ──────────────────────────────────────────────────────
    var merged = await PDFDocument.create();
    var font   = await merged.embedFont(StandardFonts.Helvetica);
    var black  = rgb(0, 0, 0);
    var i = 0, skipped = 0;

    for (var u = 0; u < urls.length; u++) {
      i++;
      prog.textContent = 'Loading sheet ' + i + ' / ' + urls.length + '\u2026';
      try {
        var r = await fetch(urls[u], { mode: 'cors' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var buf = await r.arrayBuffer();
        var src = await PDFDocument.load(buf, { ignoreEncryption: true });
        var copied = await merged.copyPages(src, src.getPageIndices());

        var pilot     = pilotData[u] || {};
        var hasPilot  = pilot.name || pilot.gu || pilot.pi;
        var firstPage = true;

        copied.forEach(function(page) {
          merged.addPage(page);

          // Only burn pilot data onto the first page of each unit's sheet
          if (firstPage && hasPilot) {
            firstPage = false;
            var pw = page.getWidth();
            var ph = page.getHeight();
            var sz = PILOT_POS.size;

            if (pilot.name) {
              page.drawText(pilot.name, {
                x: pw * PILOT_POS.name.xPct,
                y: ph * (1 - PILOT_POS.name.yPct),
                size: sz, font: font, color: black
              });
            }
            if (pilot.gu) {
              page.drawText(pilot.gu, {
                x: pw * PILOT_POS.gu.xPct,
                y: ph * (1 - PILOT_POS.gu.yPct),
                size: sz, font: font, color: black
              });
            }
            if (pilot.pi) {
              page.drawText(pilot.pi, {
                x: pw * PILOT_POS.pi.xPct,
                y: ph * (1 - PILOT_POS.pi.yPct),
                size: sz, font: font, color: black
              });
            }
          }
        });
      } catch(e) {
        skipped++;
        console.warn('Skipped', urls[u], e);
      }
    }

    var pageCount = merged.getPageCount();
    if (pageCount === 0) {
      prog.textContent = 'Error: no pages loaded (' + skipped + ' failed). Check console (F12).';
      return;
    }

    prog.textContent = 'Saving ' + pageCount + ' pages\u2026';
    var bytes   = await merged.save();
    var blob    = new Blob([bytes], { type: 'application/pdf' });
    var blobUrl = URL.createObjectURL(blob);
    var suffix  = skipped ? ' (' + skipped + ' unit' + (skipped !== 1 ? 's' : '') + ' had no sheet)' : '';

    if (action === 'print') {
      var a = document.createElement('a');
      a.href = blobUrl; a.target = '_blank'; a.rel = 'noopener'; a.click();
      prog.textContent = '\u2713 ' + pageCount + '-page PDF opened \u2014 press Ctrl+P to print' + suffix;
    } else {
      var a2 = document.createElement('a');
      a2.href = blobUrl; a2.download = 'battletech-sheets.pdf'; a2.click();
      prog.textContent = '\u2713 Downloading ' + pageCount + '-page PDF' + suffix;
    }
  } catch(e) {
    console.error(e);
    prog.textContent = 'Error: ' + e.message;
  } finally {
    [printBtn, dlBtn].forEach(function(b) { b.disabled = false; });
  }
}
