/**
 * sheets-popup.js
 * Loaded inside the Sheets popup window.
 * window._pdfUrls and window._unitNames are set by the inline script before this loads.
 */

// ── WARRIOR DATA field positions ─────────────────────────────────────────────
// Percentages from the LEFT edge (xPct) and from the TOP edge (yPct) of the page.
// All mordel.net sheets share the same FPDF template, so one set of values works.
// If the text lands in the wrong spot, tweak these and re-run Download as One PDF.
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
