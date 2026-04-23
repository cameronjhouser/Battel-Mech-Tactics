/**
 * sheets-popup.js
 * Loaded inside the Sheets popup window.
 * window._pdfUrls and window._unitNames are set by the inline script before this loads.
 */

/* ── Export unit list for merge_sheets.py ───────────────────────────────── */
function exportUnitList() {
  var names = window._unitNames || [];
  if (!names.length) { alert('No units in formation.'); return; }
  var blob = new Blob([names.join('\n')], { type: 'text/plain' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'formation-sheets.txt';
  a.click();
}

/* ── Merge all available PDFs into one, then print or download ───────────── */
async function mergeAllPdfs(action) {
  var printBtn = document.getElementById('btn-print-all');
  var dlBtn    = document.getElementById('btn-dl-all');
  var prog     = document.getElementById('merge-progress');
  [printBtn, dlBtn].forEach(function(b) { b.disabled = true; });

  try {
    prog.textContent = 'Loading pdf-lib\u2026';
    var mod = await import('https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js');
    var PDFDocument = mod.PDFDocument;

    var urls = window._pdfUrls || [];
    if (!urls.length) {
      prog.textContent = 'No sheets found to merge \u2014 all units are missing PDFs.';
      return;
    }

    var merged = await PDFDocument.create();
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
        copied.forEach(function(p) { merged.addPage(p); });
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
