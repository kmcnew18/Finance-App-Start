/* ============= LOG EXPORT =============
   The Log's "Export" menu:
   - Spreadsheet (.xlsx): a formatted workbook built in the browser with
     ExcelJS (loaded on first use) — branded title, summary figures, a
     frozen filterable header, banded rows, type tints, real dates and
     currency, live SUBTOTAL totals that follow the filters, print setup,
     plus a Summary sheet (by month, with data bars, and by category).
   - Print or PDF: a document preview (one page or many, as needed) with
     a "Print / Save as PDF" button — month sections with subtotals,
     column headers repeated on every printed page, page numbers.
   - Plain CSV: unformatted, for importing elsewhere.
   All three export what the Log is currently showing (its filters), or
   only the checked rows when any are selected.

   Category columns in the spreadsheet and document show each entry's
   effect on that category (+ money in, − money out); the Log stores a
   subtraction as a positive number, so summing the raw values would
   mean nothing. The Amount column stays exactly as the Log shows it. */
(function () {
  var EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
  var FONTS_URL = 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=IBM+Plex+Mono:wght@500;600&family=Public+Sans:wght@400;500;600;700&display=swap';

  var TYPES = {
    add: { label: 'Add', ink: '3F8F64', tint: 'E7F3EC', css: '#3F8F64', cssTint: '#E7F3EC' },
    subtract: { label: 'Subtract', ink: 'B5544A', tint: 'F8E7E4', css: '#B5544A', cssTint: '#F8E7E4' },
    transfer: { label: 'Transfer', ink: '9C7A26', tint: 'F7F0DC', css: '#9C7A26', cssTint: '#F7F0DC' },
    debt_payment: { label: 'Card payment', ink: '4E6E9A', tint: 'E6EDF6', css: '#4E6E9A', cssTint: '#E6EDF6' },
  };
  function typeOf(r) { return TYPES[r.action_type] || { label: r.action_type || 'Entry', ink: '1B2330', tint: 'F1F1F1', css: '#1B2330', cssTint: '#F1F1F1' }; }

  // ---------- data ----------
  function rawCat(r, col) {
    return col.type === 'default'
      ? Number(r[col.key] || 0)
      : (r.custom_category_id === col.id ? Number(r.custom_category_amount || 0) : 0);
  }
  // + money into the category, − money out of it.
  function effect(r, col) {
    var v = rawCat(r, col);
    if (!v) return 0;
    if (r.action_type === 'subtract' || r.action_type === 'debt_payment') return -Math.abs(v);
    if (r.action_type === 'add') return Math.abs(v);
    return v; // transfers are already signed (from −, to +)
  }
  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  function selectedIds() {
    return Array.prototype.map.call(document.querySelectorAll('.row-select:checked'), function (cb) { return cb.dataset.id; });
  }
  function rowsToExport() {
    var ids = selectedIds();
    var rows = ids.length
      ? allLogRows.filter(function (r) { return ids.indexOf(String(r.id)) !== -1; })
      : getFilteredLogRows();
    return rows.slice().sort(function (a, b) {
      return a.entry_date === b.entry_date ? String(a.created_at || a.id).localeCompare(String(b.created_at || b.id)) : a.entry_date.localeCompare(b.entry_date);
    });
  }
  function scopeText(rows) {
    var parts = [];
    var ids = selectedIds();
    if (ids.length) parts.push(ids.length + ' selected ' + (ids.length === 1 ? 'entry' : 'entries'));
    else {
      parts.push(logMonthLabel());
      if (logSelectedType && TYPES[logSelectedType]) parts.push(TYPES[logSelectedType].label + ' only');
      var q = document.getElementById('log-search-input').value.trim();
      if (q) parts.push('notes matching “' + q + '”');
    }
    if (rows.length) parts.push(fmtDay(rows[0].entry_date) + ' – ' + fmtDay(rows[rows.length - 1].entry_date));
    return parts.join(' · ');
  }
  function totals(rows) {
    var t = { count: rows.length, added: 0, subtracted: 0, transferred: 0, cardPayments: 0 };
    rows.forEach(function (r) {
      var a = Number(r.amount || 0);
      if (r.action_type === 'add') t.added += a;
      else if (r.action_type === 'subtract') t.subtracted += a;
      else if (r.action_type === 'debt_payment') t.cardPayments += a;
      else if (r.action_type === 'transfer') t.transferred += a;
    });
    t.net = round2(t.added - t.subtracted - t.cardPayments);
    ['added', 'subtracted', 'transferred', 'cardPayments'].forEach(function (k) { t[k] = round2(t[k]); });
    return t;
  }
  function byMonth(rows) {
    var map = {}, order = [];
    rows.forEach(function (r) {
      var k = r.entry_date.slice(0, 7);
      if (!map[k]) { map[k] = []; order.push(k); }
      map[k].push(r);
    });
    return order.map(function (k) { return { key: k, label: fmtMonth(k), rows: map[k], totals: totals(map[k]) }; });
  }
  function byCategory(rows) {
    return logColumns.map(function (col) {
      var inn = 0, out = 0;
      rows.forEach(function (r) { var e = effect(r, col); if (e > 0) inn += e; else out -= e; });
      return { label: col.label, in: round2(inn), out: round2(out), net: round2(inn - out) };
    });
  }

  function fmtDay(d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  function fmtMonth(k) { return new Date(k + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
  function usd(n) { return (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function signed(n) { return n > 0 ? '+' + usd(n) : n < 0 ? usd(n) : '–'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function today() { return new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
  function fileStamp() { return new Date().toLocaleDateString('en-CA'); }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // ---------- CSV ----------
  function csvEscape(value) {
    var str = String(value == null ? '' : value);
    return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }
  function exportCsv(rows) {
    var header = ['Date', 'Type', 'Amount'].concat(logColumns.map(function (c) { return c.label; }), ['Notes']);
    var lines = [header.map(csvEscape).join(',')];
    rows.forEach(function (r) {
      lines.push([r.entry_date, typeOf(r).label, Number(r.amount || 0).toFixed(2)]
        .concat(logColumns.map(function (col) { return rawCat(r, col).toFixed(2); }), [r.notes || ''])
        .map(csvEscape).join(','));
    });
    download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }), 'arko-log-' + fileStamp() + '.csv');
  }

  // ---------- XLSX ----------
  var excelPromise = null;
  function loadExcelJS() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    if (!excelPromise) {
      excelPromise = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = EXCELJS_URL;
        s.onload = function () { window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('ExcelJS did not load')); };
        s.onerror = function () { excelPromise = null; reject(new Error('Could not load the spreadsheet builder')); };
        document.head.appendChild(s);
      });
    }
    return excelPromise;
  }

  var X = {
    ink: 'FF1B2330', sub: 'FF6B7680', faint: 'FF98A2AA', brand: 'FF2E5472', brandLight: 'FF6E8FA3',
    band: 'FFF8F6F1', white: 'FFFFFFFF', rule: 'FFE6E1D6', month: 'FFBFCBD4', totalFill: 'FFEEF2F5',
  };
  // Signed effect (+/−); colors come from conditional formatting in the
  // brand's own green/red rather than Excel's harsh built-in [Red].
  var CURRENCY = '+"$"#,##0.00;-"$"#,##0.00;[Color16]"–"';
  var CURRENCY_PLAIN = '"$"#,##0.00;-"$"#,##0.00;[Color16]"–"';
  var NET_FMT = '+"$"#,##0.00;-"$"#,##0.00;"$0.00"';
  function signColors(ws, ref, positive) {
    var rules = [{ type: 'cellIs', operator: 'lessThan', formulae: ['0'], style: { font: { color: { argb: 'FFB5544A' } } } }];
    if (positive) rules.push({ type: 'cellIs', operator: 'greaterThan', formulae: ['0'], style: { font: { color: { argb: 'FF3F8F64' } } } });
    ws.addConditionalFormatting({ ref: ref, rules: rules });
  }
  function fill(argb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: argb } }; }
  function hair(argb) { return { style: 'thin', color: { argb: argb } }; }
  function dayUTC(d) { var p = d.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])); }
  function colLetter(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

  function titleBlock(ws, title, subtitle, lastCol) {
    ws.mergeCells(1, 1, 1, lastCol);
    var t = ws.getCell(1, 1);
    t.value = { richText: [
      { text: 'Arko  ', font: { name: 'Georgia', size: 20, bold: true, color: { argb: X.brand } } },
      { text: title, font: { name: 'Georgia', size: 20, color: { argb: X.ink } } },
    ] };
    t.alignment = { vertical: 'middle' };
    ws.getRow(1).height = 36;
    ws.mergeCells(2, 1, 2, lastCol);
    var s = ws.getCell(2, 1);
    s.value = subtitle;
    s.font = { name: 'Calibri', size: 10, color: { argb: X.sub } };
    s.alignment = { vertical: 'top' };
    ws.getRow(2).height = 20;
  }

  function kpiRow(ws, startRow, items) {
    // label row, value row; a colored rule above each figure
    items.forEach(function (k, i) {
      var c = i + 1;
      var l = ws.getCell(startRow, c);
      l.value = k.label.toUpperCase();
      l.font = { name: 'Calibri', size: 8, bold: true, color: { argb: X.faint } };
      l.border = { top: { style: 'medium', color: { argb: k.color } } };
      l.alignment = { vertical: 'bottom' };
      var v = ws.getCell(startRow + 1, c);
      v.value = k.value;
      v.numFmt = k.fmt || CURRENCY_PLAIN;
      v.font = { name: 'Calibri', size: 14, bold: true, color: { argb: k.color } };
      v.alignment = { horizontal: 'left', vertical: 'top' };
    });
    ws.getRow(startRow).height = 18;
    ws.getRow(startRow + 1).height = 24;
  }

  function headerRow(ws, rowNum, labels, alignRightFrom) {
    var row = ws.getRow(rowNum);
    labels.forEach(function (label, i) {
      var cell = row.getCell(i + 1);
      cell.value = label;
      cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: X.white } };
      cell.fill = fill(X.brand);
      cell.alignment = { vertical: 'middle', horizontal: i >= alignRightFrom.from && i < alignRightFrom.to ? 'right' : 'left', indent: 1 };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF1F3A52' } } };
    });
    row.height = 24;
  }

  async function exportXlsx(rows) {
    var ExcelJS = await loadExcelJS();
    var wb = new ExcelJS.Workbook();
    wb.creator = 'Arko Finance';
    wb.created = new Date();
    wb.title = 'Arko — Full Log';
    wb.calcProperties.fullCalcOnLoad = true; // formulas show live values the moment it opens

    var t = totals(rows);
    var scope = scopeText(rows);
    var cats = logColumns;
    var lastCol = 4 + cats.length;
    var HEADER = 6;

    // ===== Log sheet =====
    var ws = wb.addWorksheet('Log', {
      properties: { tabColor: { argb: X.brand }, defaultRowHeight: 20 },
      views: [{ state: 'frozen', xSplit: 1, ySplit: HEADER, showGridLines: false, zoomScale: 110 }],
      pageSetup: {
        paperSize: 1, orientation: cats.length > 3 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.4, right: 0.4, top: 0.55, bottom: 0.6, header: 0.25, footer: 0.3 },
        printTitlesRow: HEADER + ':' + HEADER, horizontalCentered: true,
      },
      headerFooter: {
        oddHeader: '&L&"Georgia,Bold"&11Arko&"Georgia,Regular"  Full Log&R&9' + scope.replace(/&/g, '&&'),
        oddFooter: '&L&8Generated ' + today() + '&R&8Page &P of &N',
      },
    });
    ws.columns = [{ width: 15 }, { width: 14 }, { width: 15 }]
      .concat(cats.map(function () { return { width: 15 }; }), [{ width: 46 }]);

    titleBlock(ws, 'Full Log', scope + '  ·  ' + t.count + ' ' + (t.count === 1 ? 'entry' : 'entries') + '  ·  Generated ' + today(), lastCol);
    kpiRow(ws, 3, [
      { label: 'Added', value: t.added, color: 'FF3F8F64' },
      { label: 'Subtracted', value: t.subtracted + t.cardPayments, color: 'FFB5544A' },
      { label: 'Transfers', value: t.transferred, color: 'FF9C7A26' },
      { label: 'Net', value: t.net, color: t.net >= 0 ? 'FF2E5472' : 'FFB5544A', fmt: '"$"#,##0.00;-"$"#,##0.00;"$0.00"' },
      { label: 'Entries', value: t.count, color: X.brandLight, fmt: '0' },
    ]);
    ws.getRow(5).height = 10;
    headerRow(ws, HEADER, ['Date', 'Type', 'Amount'].concat(cats.map(function (c) { return c.label; }), ['Notes']), { from: 2, to: 3 + cats.length });
    // Explain the signed category columns right on their headers.
    cats.forEach(function (c, i) {
      ws.getCell(HEADER, 4 + i).note = { texts: [{ text: 'Effect on ' + c.label + ': + money in, − money out. The total row shows the net change.' }], margins: { insetmode: 'auto' } };
    });

    var r0 = HEADER + 1;
    var prevMonth = null;
    rows.forEach(function (r, i) {
      var rowNum = r0 + i;
      var row = ws.getRow(rowNum);
      var ty = typeOf(r);
      var band = i % 2 ? X.band : X.white;
      var month = r.entry_date.slice(0, 7);
      var monthStart = prevMonth !== null && month !== prevMonth;
      prevMonth = month;

      row.values = [dayUTC(r.entry_date), ty.label, Number(r.amount || 0)]
        .concat(cats.map(function (col) { return effect(r, col); }), [r.notes || '']);
      var notesLen = (r.notes || '').length;
      row.height = notesLen > 52 ? Math.min(60, 15 * Math.ceil(notesLen / 52) + 6) : 21;

      row.eachCell({ includeEmpty: true }, function (cell, c) {
        if (c > lastCol) return;
        cell.fill = fill(band);
        cell.font = { name: 'Calibri', size: 11, color: { argb: X.ink } };
        cell.alignment = { vertical: 'middle', indent: 1 };
        cell.border = { bottom: hair(X.rule), top: monthStart ? { style: 'medium', color: { argb: X.month } } : undefined };
      });
      var dateCell = row.getCell(1);
      dateCell.numFmt = 'mmm d, yyyy';
      dateCell.font = { name: 'Calibri', size: 11, color: { argb: X.sub } };

      var typeCell = row.getCell(2);
      typeCell.fill = fill('FF' + ty.tint);
      typeCell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FF' + ty.ink } };
      typeCell.alignment = { vertical: 'middle', horizontal: 'center' };

      var amt = row.getCell(3);
      amt.numFmt = CURRENCY_PLAIN;
      amt.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF' + ty.ink } };
      amt.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };

      cats.forEach(function (col, ci) {
        var cell = row.getCell(4 + ci);
        cell.numFmt = CURRENCY;
        cell.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
      });
      var note = row.getCell(lastCol);
      note.font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF55606A' } };
      note.alignment = { vertical: 'middle', wrapText: true, indent: 1 };
    });

    // Totals that follow the AutoFilter (SUBTOTAL ignores hidden rows).
    var last = r0 + rows.length - 1;
    var totalRowNum = last + 1;
    var tr = ws.getRow(totalRowNum);
    tr.getCell(1).value = 'Total';
    tr.getCell(2).value = { formula: 'SUBTOTAL(103,B' + r0 + ':B' + last + ')&" entries"', result: rows.length + ' entries' };
    cats.forEach(function (col, ci) {
      var L = colLetter(4 + ci);
      var sum = round2(rows.reduce(function (s, r) { return s + effect(r, col); }, 0));
      tr.getCell(4 + ci).value = { formula: 'SUBTOTAL(109,' + L + r0 + ':' + L + last + ')', result: sum };
      tr.getCell(4 + ci).numFmt = CURRENCY;
    });
    for (var c = 1; c <= lastCol; c++) {
      var cell = tr.getCell(c);
      cell.fill = fill(X.totalFill);
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: X.ink } };
      cell.alignment = { vertical: 'middle', horizontal: c >= 3 && c < lastCol ? 'right' : 'left', indent: 1 };
      cell.border = { top: { style: 'double', color: { argb: X.brand } }, bottom: { style: 'thin', color: { argb: X.brand } } };
    }
    tr.getCell(2).font = { name: 'Calibri', size: 10, color: { argb: X.sub } };
    tr.height = 24;
    var foot = ws.getRow(totalRowNum + 2).getCell(1);
    foot.value = 'Category columns show each entry’s effect on that category (+ in, − out); Total is the net change for the rows shown. Exported from Arko Finance.';
    foot.font = { name: 'Calibri', size: 9, italic: true, color: { argb: X.faint } };

    ws.autoFilter = { from: { row: HEADER, column: 1 }, to: { row: last, column: lastCol } };
    if (cats.length) signColors(ws, 'D' + r0 + ':' + colLetter(3 + cats.length) + totalRowNum, false);

    // ===== Summary sheet =====
    var ss = wb.addWorksheet('Summary', {
      properties: { tabColor: { argb: 'FF6EC4B8' } },
      views: [{ showGridLines: false, zoomScale: 110 }],
      pageSetup: { paperSize: 1, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
      headerFooter: { oddFooter: '&L&8Arko Finance · Summary&R&8Page &P of &N' },
    });
    ss.columns = [{ width: 24 }, { width: 17 }, { width: 17 }, { width: 17 }, { width: 17 }, { width: 17 }];
    titleBlock(ss, 'Summary', scope + '  ·  Generated ' + today(), 6);

    var months = byMonth(rows);
    var row = 4;
    var section = function (label) {
      ss.mergeCells(row, 1, row, 6);
      var c = ss.getCell(row, 1);
      c.value = label;
      c.font = { name: 'Georgia', size: 13, bold: true, color: { argb: X.ink } };
      c.border = { bottom: { style: 'thin', color: { argb: X.rule } } };
      ss.getRow(row).height = 24;
      row += 1;
    };
    var bodyRow = function (rowNum, i) {
      for (var c = 1; c <= 6; c++) {
        var cell = ss.getCell(rowNum, c);
        cell.fill = fill(i % 2 ? X.band : X.white);
        cell.border = { bottom: hair(X.rule) };
        cell.font = { name: 'Calibri', size: 11, color: { argb: X.ink } };
        cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'left' : 'right', indent: 1 };
        if (c > 1) cell.numFmt = CURRENCY_PLAIN;
      }
      ss.getRow(rowNum).height = 21;
    };
    var totalStyle = function (rowNum) {
      for (var c = 1; c <= 6; c++) {
        var cell = ss.getCell(rowNum, c);
        cell.fill = fill(X.totalFill);
        cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: X.ink } };
        cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'left' : 'right', indent: 1 };
        cell.border = { top: { style: 'double', color: { argb: X.brand } } };
        if (c > 1) cell.numFmt = CURRENCY_PLAIN;
      }
      ss.getRow(rowNum).height = 23;
    };

    section('By month');
    headerRow(ss, row, ['Month', 'Added', 'Subtracted', 'Card payments', 'Transfers', 'Net'], { from: 1, to: 6 });
    row += 1;
    var mStart = row;
    months.forEach(function (m, i) {
      ss.getCell(row, 1).value = m.label;
      ss.getCell(row, 2).value = m.totals.added;
      ss.getCell(row, 3).value = m.totals.subtracted;
      ss.getCell(row, 4).value = m.totals.cardPayments;
      ss.getCell(row, 5).value = m.totals.transferred;
      ss.getCell(row, 6).value = { formula: 'B' + row + '-C' + row + '-D' + row, result: m.totals.net };
      bodyRow(row, i);
      ss.getCell(row, 2).font = { name: 'Calibri', size: 11, color: { argb: 'FF3F8F64' } };
      ss.getCell(row, 3).font = { name: 'Calibri', size: 11, color: { argb: 'FFB5544A' } };
      ss.getCell(row, 6).numFmt = NET_FMT;
      ss.getCell(row, 6).font = { name: 'Calibri', size: 11, bold: true, color: { argb: X.ink } };
      row += 1;
    });
    var mEnd = row - 1;
    ss.getCell(row, 1).value = 'Total';
    ['B', 'C', 'D', 'E', 'F'].forEach(function (L, i) {
      var sums = [t.added, t.subtracted, t.cardPayments, t.transferred, t.net];
      ss.getCell(row, i + 2).value = { formula: 'SUM(' + L + mStart + ':' + L + mEnd + ')', result: sums[i] };
    });
    totalStyle(row);
    ss.getCell(row, 6).numFmt = NET_FMT;
    signColors(ss, 'F' + mStart + ':F' + row, true);
    try {
      if (months.length > 1) {
        ss.addConditionalFormatting({ ref: 'B' + mStart + ':B' + mEnd, rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'max' }], color: { argb: 'FF8FCBA6' }, gradient: true }] });
        ss.addConditionalFormatting({ ref: 'C' + mStart + ':C' + mEnd, rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'max' }], color: { argb: 'FFE3A399' }, gradient: true }] });
      }
    } catch (e) { /* data bars are a nicety */ }
    row += 3;

    section('By category');
    headerRow(ss, row, ['Category', 'Money in', 'Money out', 'Net change', '', ''], { from: 1, to: 4 });
    [5, 6].forEach(function (c) { ss.getCell(row, c).fill = fill(X.white); ss.getCell(row, c).border = {}; });
    row += 1;
    var cStart = row;
    byCategory(rows).forEach(function (cat, i) {
      ss.getCell(row, 1).value = cat.label;
      ss.getCell(row, 2).value = cat.in;
      ss.getCell(row, 3).value = cat.out;
      ss.getCell(row, 4).value = { formula: 'B' + row + '-C' + row, result: cat.net };
      bodyRow(row, i);
      [5, 6].forEach(function (c) { ss.getCell(row, c).fill = fill(X.white); ss.getCell(row, c).border = {}; });
      ss.getCell(row, 4).numFmt = '+"$"#,##0.00;-"$"#,##0.00;[Color16]"–"';
      ss.getCell(row, 4).font = { name: 'Calibri', size: 11, bold: true, color: { argb: X.ink } };
      row += 1;
    });
    if (cats.length) {
      var catSums = byCategory(rows).reduce(function (s, c) { s[0] += c.in; s[1] += c.out; s[2] += c.net; return s; }, [0, 0, 0]);
      ss.getCell(row, 1).value = 'Total';
      ['B', 'C', 'D'].forEach(function (L, i) { ss.getCell(row, i + 2).value = { formula: 'SUM(' + L + cStart + ':' + L + (row - 1) + ')', result: round2(catSums[i]) }; });
      totalStyle(row);
      [5, 6].forEach(function (c) { ss.getCell(row, c).fill = fill(X.white); ss.getCell(row, c).border = {}; });
      ss.getCell(row, 4).numFmt = NET_FMT;
      signColors(ss, 'D' + cStart + ':D' + row, true);
    }
    row += 2;
    var note = ss.getCell(row, 1);
    note.value = 'Net = Added − Subtracted − Card payments. Transfers move money between categories and don’t change the total.';
    note.font = { name: 'Calibri', size: 9, italic: true, color: { argb: X.faint } };

    var buf = await wb.xlsx.writeBuffer();
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ---------- printable document ----------
  function documentHtml(rows) {
    var t = totals(rows);
    var months = byMonth(rows);
    var cats = logColumns;
    var landscape = cats.length > 4;
    var scope = scopeText(rows);
    var catHead = cats.map(function (c) { return '<th class="num">' + esc(c.label) + '</th>'; }).join('');

    // Fixed column widths so every month's table lines up with the next.
    var catPct = (100 - 10.5 - 10.5 - 9.5 - 23) / Math.max(1, cats.length);
    var colgroup = '<colgroup><col style="width:10.5%"><col style="width:10.5%"><col style="width:9.5%">' +
      cats.map(function () { return '<col style="width:' + catPct.toFixed(2) + '%">'; }).join('') + '<col style="width:23%"></colgroup>';

    var monthSections = months.map(function (m) {
      var mt = m.totals;
      var rowHtml = m.rows.map(function (r, i) {
        var ty = typeOf(r);
        return '<tr' + (i % 2 ? ' class="alt"' : '') + '>' +
          '<td class="date">' + esc(fmtDay(r.entry_date)) + '</td>' +
          '<td><span class="pill" style="color:' + ty.css + ';background:' + ty.cssTint + '">' + esc(ty.label) + '</span></td>' +
          '<td class="num amt" style="color:' + ty.css + '">' + usd(Number(r.amount || 0)) + '</td>' +
          cats.map(function (col) { var e = effect(r, col); return '<td class="num' + (e ? '' : ' zero') + (e < 0 ? ' neg' : '') + '">' + signed(e) + '</td>'; }).join('') +
          '<td class="note">' + esc(r.notes || '') + '</td>' +
          '</tr>';
      });
      // The month's last two rows ride with its subtotal in their own
      // unbreakable group, so a page never starts with a lone total.
      var tail = rowHtml.splice(Math.max(0, rowHtml.length - 2));
      var catTotals = cats.map(function (col) {
        var s = round2(m.rows.reduce(function (acc, r) { return acc + effect(r, col); }, 0));
        return '<td class="num' + (s < 0 ? ' neg' : '') + (s ? '' : ' zero') + '">' + signed(s) + '</td>';
      }).join('');
      var subtotal = '<tr class="subtotal"><td colspan="3">' + m.rows.length + ' ' + (m.rows.length === 1 ? 'entry' : 'entries') + '</td>' + catTotals + '<td></td></tr>';
      return '<section class="month">' +
        '<div class="month-head"><h2>' + esc(m.label) + '</h2>' +
          '<div class="month-figs"><span class="in">+' + usd(mt.added) + ' in</span><span class="out">' + usd(-(mt.subtracted + mt.cardPayments)) + ' out</span>' +
          (mt.transferred ? '<span class="xfer">' + usd(mt.transferred) + ' moved</span>' : '') + '</div></div>' +
        '<table class="ledger">' + colgroup + '<thead><tr><th>Date</th><th>Type</th><th class="num">Amount</th>' + catHead + '<th>Notes</th></tr></thead>' +
        (rowHtml.length ? '<tbody>' + rowHtml.join('') + '</tbody>' : '') +
        '<tbody class="keep">' + tail.join('') + subtotal + '</tbody>' +
        '</table></section>';
    }).join('');

    var catRows = byCategory(rows).map(function (c, i) {
      var cell = function (n, cls) { return n ? '<td class="num ' + cls + '">' + usd(n) + '</td>' : '<td class="num zero">–</td>'; };
      return '<tr' + (i % 2 ? ' class="alt"' : '') + '><td>' + esc(c.label) + '</td>' + cell(c.in, 'in') + cell(c.out, 'out') +
        '<td class="num strong' + (c.net < 0 ? ' neg' : '') + (c.net ? '' : ' zero') + '">' + signed(c.net) + '</td></tr>';
    }).join('');

    var kpi = function (label, value, color, sub) {
      return '<div class="kpi" style="--k:' + color + '"><span class="kpi-label">' + label + '</span><span class="kpi-value">' + value + '</span>' + (sub ? '<span class="kpi-sub">' + sub + '</span>' : '') + '</div>';
    };

    return '<!doctype html><html><head><meta charset="utf-8"><title>Arko — Full Log</title>' +
      '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="' + FONTS_URL + '">' +
      '<style>' +
      '@page { size: letter ' + (landscape ? 'landscape' : 'portrait') + '; margin: 15mm 13mm 17mm; @bottom-left { content: "Arko Finance · Full Log"; font: 500 8pt "Public Sans", sans-serif; color: #98A2AA; } @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 500 8pt "Public Sans", sans-serif; color: #98A2AA; } }' +
      ':root { --ink:#1B2330; --sub:#5F6B75; --faint:#98A2AA; --rule:#E6E1D6; --band:#FAF8F4; --brand:#2E5472; --in:#3F8F64; --out:#B5544A; --xfer:#9C7A26; }' +
      '* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }' +
      'html { background: #E9E6DF; } body { margin: 0; color: var(--ink); font: 400 9.5pt/1.45 "Public Sans", system-ui, sans-serif; }' +
      '.paper { background: #fff; max-width: ' + (landscape ? '1056px' : '816px') + '; margin: 28px auto; padding: 56px 52px 64px; box-shadow: 0 2px 4px rgba(0,0,0,.06), 0 18px 48px rgba(0,0,0,.12); border-radius: 3px; }' +
      '@media print { html { background: #fff; } .paper { max-width: none; margin: 0; padding: 0; box-shadow: none; border-radius: 0; } }' +
      '.masthead { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 14px; border-bottom: 2px solid var(--brand); }' +
      '.brand { display: flex; align-items: center; gap: 10px; } .brand img { width: 30px; height: 30px; } .brand span { font: 600 13pt "Fraunces", Georgia, serif; letter-spacing: .01em; } .brand b { color: var(--brand); font-weight: 600; }' +
      '.meta { text-align: right; font-size: 8.5pt; color: var(--sub); line-height: 1.5; }' +
      'h1 { font: 600 24pt/1.15 "Fraunces", Georgia, serif; margin: 26px 0 4px; letter-spacing: -.01em; }' +
      '.scope { color: var(--sub); font-size: 9.5pt; margin: 0 0 20px; }' +
      '.kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 26px; }' +
      '.kpi { border: 1px solid var(--rule); border-top: 3px solid var(--k); border-radius: 8px; padding: 10px 12px 11px; background: #fff; break-inside: avoid; }' +
      '.kpi-label { display: block; font-size: 7pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }' +
      '.kpi-value { display: block; margin-top: 4px; font: 600 13.5pt "IBM Plex Mono", monospace; color: var(--k); letter-spacing: -.02em; }' +
      '.kpi-sub { display: block; font-size: 7.5pt; color: var(--faint); margin-top: 1px; }' +
      '.month { margin-top: 22px; } .month-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; break-after: avoid; }' +
      '.month-head h2 { font: 600 14pt "Fraunces", Georgia, serif; margin: 0; }' +
      '.month-figs { display: flex; gap: 14px; font: 600 8.5pt "IBM Plex Mono", monospace; } .month-figs .in { color: var(--in); } .month-figs .out { color: var(--out); } .month-figs .xfer { color: var(--xfer); }' +
      'table { width: 100%; border-collapse: collapse; } table.ledger { table-layout: fixed; } thead { display: table-header-group; } tbody.keep { break-inside: avoid; }' +
      '.ledger td { overflow-wrap: anywhere; } .ledger td.num { overflow-wrap: normal; }' +
      'th { text-align: left; font-size: 7pt; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: #fff; background: var(--brand); padding: 7px 8px; }' +
      'th:first-child { border-radius: 5px 0 0 0; } th:last-child { border-radius: 0 5px 0 0; }' +
      'td { padding: 6px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; } tr.alt td { background: var(--band); } tr { break-inside: avoid; }' +
      '.num { text-align: right; white-space: nowrap; font-family: "IBM Plex Mono", monospace; font-size: 8.5pt; } .amt { font-weight: 600; } .zero { color: #C2C8CD; } .neg { color: var(--out); }' +
      '.date { white-space: nowrap; color: var(--sub); }' +
      '.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 7.5pt; font-weight: 700; white-space: nowrap; }' +
      '.note { font: italic 400 9pt "Fraunces", Georgia, serif; color: #4A5560; min-width: 140px; }' +
      'tr.subtotal td { font-weight: 600; background: #EEF2F5 !important; border-top: 1.5px solid var(--brand); border-bottom: none; color: var(--sub); font-size: 8pt; }' +
      'tr.subtotal td.num { color: var(--ink); } tr.subtotal td.neg { color: var(--out); } tr.subtotal td.zero { color: #C2C8CD; font-weight: 400; }' +
      '.cats { margin-top: 30px; break-inside: avoid; } .cats h2 { font: 600 14pt "Fraunces", Georgia, serif; margin: 0 0 8px; }' +
      '.cats table { max-width: 560px; } .cats td.in { color: var(--in); } .cats td.out { color: var(--out); } .strong { font-weight: 600; }' +
      '.fineprint { margin-top: 26px; padding-top: 10px; border-top: 1px solid var(--rule); color: var(--faint); font-size: 7.5pt; }' +
      '@media screen and (max-width: 760px) { .paper { margin: 10px; padding: 26px 16px 34px; } h1 { font-size: 19pt; } .kpis { grid-template-columns: repeat(2, 1fr); } .kpi:last-child { grid-column: span 2; } .month, .cats { overflow-x: auto; } .ledger { min-width: 760px; } .month-head { flex-direction: column; gap: 4px; } .meta { font-size: 7.5pt; } }' +
      '</style></head><body><div class="paper">' +
      '<header class="masthead"><div class="brand"><img src="' + location.origin + '/favicon-192.png" alt=""><span><b>Arko</b> Finance</span></div>' +
        '<div class="meta">Full Log<br>Generated ' + esc(today()) + '</div></header>' +
      '<h1>Your Log</h1><p class="scope">' + esc(scope) + '</p>' +
      '<div class="kpis">' +
        kpi('Added', usd(t.added), '#3F8F64') +
        kpi('Subtracted', usd(t.subtracted + t.cardPayments), '#B5544A', t.cardPayments ? 'incl. ' + usd(t.cardPayments) + ' card payments' : '') +
        kpi('Transfers', usd(t.transferred), '#9C7A26', 'moved between categories') +
        kpi('Net', (t.net > 0 ? '+' : '') + usd(t.net), t.net >= 0 ? '#2E5472' : '#B5544A') +
        kpi('Entries', String(t.count), '#6E8FA3', months.length + ' month' + (months.length === 1 ? '' : 's')) +
      '</div>' +
      monthSections +
      (cats.length ? '<section class="cats"><h2>By category</h2><table><thead><tr><th>Category</th><th class="num">Money in</th><th class="num">Money out</th><th class="num">Net change</th></tr></thead><tbody>' + catRows + '</tbody></table></section>' : '') +
      '<p class="fineprint">Category columns show each entry’s effect on that category: + money in, − money out. Net = added − subtracted − card payments; transfers move money between categories without changing the total. Exported from Arko Finance.</p>' +
      '</div></body></html>';
  }

  var preview = null;
  function openPrintPreview(rows) {
    if (!preview) {
      preview = document.createElement('div');
      preview.className = 'log-print-preview';
      preview.setAttribute('role', 'dialog');
      preview.setAttribute('aria-modal', 'true');
      preview.setAttribute('aria-label', 'Print preview');
      preview.innerHTML =
        '<div class="log-print-bar">' +
          '<div class="log-print-bar-text"><span class="log-print-title">Print preview</span><span class="log-print-sub" id="log-print-sub"></span></div>' +
          '<div class="log-print-actions">' +
            '<button type="button" class="log-print-close" id="log-print-close">Close</button>' +
            '<button type="button" class="log-print-go" id="log-print-go"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"></path><rect x="3" y="9" width="18" height="9" rx="2"></rect><path d="M6 14h12v7H6z"></path></svg>Print or save as PDF</button>' +
          '</div>' +
        '</div>' +
        '<iframe class="log-print-frame" id="log-print-frame" title="Printable log"></iframe>';
      document.body.appendChild(preview);
      document.getElementById('log-print-close').addEventListener('click', closePrintPreview);
      document.getElementById('log-print-go').addEventListener('click', function () {
        var f = document.getElementById('log-print-frame');
        try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { console.error(e); }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && preview && preview.classList.contains('open')) { e.stopPropagation(); closePrintPreview(); }
      }, true);
    }
    var t = totals(rows);
    document.getElementById('log-print-sub').textContent = t.count + ' ' + (t.count === 1 ? 'entry' : 'entries') + ' · ' + byMonth(rows).length + ' month' + (byMonth(rows).length === 1 ? '' : 's');
    var frame = document.getElementById('log-print-frame');
    frame.srcdoc = documentHtml(rows);
    preview.style.display = 'flex';
    document.documentElement.style.overflow = 'hidden';
    requestAnimationFrame(function () { preview.classList.add('open'); });
    setTimeout(function () { document.getElementById('log-print-go').focus({ preventScroll: true }); }, 80);
  }
  function closePrintPreview() {
    if (!preview) return;
    preview.classList.remove('open');
    document.documentElement.style.overflow = '';
    setTimeout(function () { if (!preview.classList.contains('open')) { preview.style.display = 'none'; document.getElementById('log-print-frame').srcdoc = ''; } }, 250);
  }

  // ---------- menu ----------
  function setup() {
    var btn = document.getElementById('export-btn');
    var menu = document.getElementById('export-menu');
    if (!btn || !menu) return;

    function refreshHint() {
      var ids = selectedIds();
      var n = ids.length || getFilteredLogRows().length;
      document.getElementById('export-menu-hint').textContent = ids.length
        ? 'Exporting the ' + n + ' selected ' + (n === 1 ? 'entry' : 'entries')
        : 'Exporting ' + n + ' ' + (n === 1 ? 'entry' : 'entries') + ' · ' + logMonthLabel().toLowerCase().replace(/^all time$/, 'all time');
    }
    function toggle(open) {
      menu.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) refreshHint();
    }
    btn.addEventListener('click', function (e) { e.stopPropagation(); toggle(!menu.classList.contains('open')); });
    document.addEventListener('click', function (e) { if (!menu.contains(e.target)) toggle(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu.classList.contains('open')) toggle(false); });

    menu.addEventListener('click', async function (e) {
      var item = e.target.closest('[data-export]');
      if (!item) return;
      e.stopPropagation();
      var rows = rowsToExport();
      toggle(false);
      if (!rows.length) { await arkoAlert('No entries to export.'); return; }
      var kind = item.dataset.export;
      if (kind === 'csv') { exportCsv(rows); return; }
      if (kind === 'print') { openPrintPreview(rows); return; }
      if (kind === 'xlsx') {
        var label = btn.querySelector('.export-btn-label');
        var prev = label.textContent;
        btn.disabled = true; label.textContent = 'Building…';
        try {
          download(await exportXlsx(rows), 'arko-log-' + fileStamp() + '.xlsx');
        } catch (err) {
          console.error('Spreadsheet export failed:', err);
          await arkoAlert('Couldn’t build the spreadsheet just now. ' + (err.message || ''));
        } finally {
          btn.disabled = false; label.textContent = prev;
        }
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();

  window.ArkoLogExport = { buildXlsx: function () { return exportXlsx(rowsToExport()); }, documentHtml: function () { return documentHtml(rowsToExport()); }, openPrintPreview: function () { openPrintPreview(rowsToExport()); } };
})();
