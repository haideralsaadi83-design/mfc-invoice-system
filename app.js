/* =========================================================================
   MFC Invoice System — AP eConnect Multi-Upload Builder
   Pure client-side (no backend). All state lives in the browser (localStorage).
   ========================================================================= */

/* ---------------------- Constants: Nokia Submit template ---------------------- */
const HDR_LABELS = [
  "Document Type (Invoice/Credit Note)", "Invoice Reference", "Supplier ID", "Supplier Name",
  "Supplier VAT ID", "Company Code", "Customer Name", "Customer VAT ID",
  "Invoice Date (use YYYY-MM-DD format)", "Currency", "Payment Reference", "Bank Account",
  "Original Invoice Number (Credit Notes)", "Target System", "Payment Terms"
];
const LINE_LABELS = [
  "Purchase Order Number", "PO Line Item Number", "Description", "Unit", "Quantity",
  "Net Unit Price", "PO Currency", "Net Unit Price Per", "Net Amount", "VAT %",
  "VAT Amount (Fill only % or amount)", "Calculated VAT Amount", "Gross Amount",
  "Delivery Note", "Buyer Material Code", "Material/Service", "PO Target System",
  "PO Payment Terms", "Shipped from Country", "Shipped to Country"
];

// How close Net × (1 + VAT%/100) must land to the Step 2 target Invoice Amount
// to be considered "matched" (in currency units, e.g. IQD). Small tolerance to
// absorb rounding from quantity/price decimals.
const TARGET_TOLERANCE = 1;

/* ---------------------- App state ---------------------- */
let state = {
  dumpRows: [],       // parsed+filtered available line items
  dumpRawCount: 0,
  excludedCount: 0,
  invoiceMap: {},      // normalizedPO -> {site, invoiceNumber, invoiceAmount}
  mapRawCount: 0,
  invoices: [],        // built invoice objects
};

/* View-only state for the Step 4 list. Deliberately separate from `state`:
   filtering and sorting must never influence what gets built or exported. */
let invView = { q:'', sort:'default' };

/* ---------------------- Utilities ---------------------- */
function toast(msg, isError){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>t.classList.remove('show'), 3200);
}

function normPO(po){
  if(po===undefined||po===null) return '';
  let s = String(po).trim();
  let digits = s.replace(/[^0-9]/g,'');
  if(digits.length) return String(parseInt(digits,10));
  return s.toUpperCase();
}

function parseNum(v){
  if(v===undefined||v===null||v==='') return 0;
  if(typeof v === 'number') return v;
  let s = String(v).replace(/,/g,'').trim();
  let n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Like parseNum, but tolerant of currency text such as "IQD 394,515" or
// "394,515 IQD". Strips everything except digits/dot/minus. Returns null
// (not 0) when there's nothing usable, so callers can distinguish
// "no target given" from "target is zero".
function parseCurrency(v){
  if(v===undefined||v===null) return null;
  let s = String(v).trim();
  if(s==='') return null;
  s = s.replace(/[^0-9.\-]/g,'');
  if(s===''||s==='-') return null;
  let n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseBool(v){
  if(typeof v === 'boolean') return v;
  return String(v).trim().toUpperCase() === 'TRUE';
}

function todayISO(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

function fmtNum(n){
  if(n===undefined||n===null||isNaN(n)) return '0';
  return n.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2});
}

function escHtml(s){
  if(s===undefined||s===null) return '';
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Splits `total` across `weights` (proportional to each weight's share of
// the sum), rounded to 2 decimals, with the rounding remainder dumped on the
// last entry so the parts always sum EXACTLY to `total`. Falls back to an
// even split if all weights are zero/negative.
function distributeAmount(total, weights){
  const n = weights.length;
  if(n===0) return [];
  const sumW = weights.reduce((a,b)=>a+b,0);
  let arr;
  if(sumW<=0){
    const base = total/n;
    arr = weights.map(()=> Math.round(base*100)/100);
  } else {
    arr = weights.map(w=> Math.round((total*(w/sumW))*100)/100);
  }
  const diff = Math.round((total - arr.reduce((a,b)=>a+b,0))*100)/100;
  arr[n-1] = Math.round((arr[n-1]+diff)*100)/100;
  return arr;
}

/* ---------------------- Generic table parsing (paste or file) ---------------------- */
function parseDelimitedText(text){
  const lines = text.replace(/\r/g,'').split('\n').filter(l=>l.trim().length>0);
  if(lines.length===0) return {headers:[], rows:[]};
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const rawHeaders = lines[0].split(delim).map(h=>h.trim());
  const headers = dedupeHeaders(rawHeaders);
  const rows = lines.slice(1).map(line=>{
    const cells = line.split(delim);
    const obj = {};
    headers.forEach((h,i)=> obj[h] = (cells[i]!==undefined? cells[i].trim() : ''));
    return obj;
  });
  return {headers, rows};
}

// Turn blank/duplicate header names into unique, stable keys (Col_2, Name_2, ...)
function dedupeHeaders(rawHeaders){
  const seen = {};
  return rawHeaders.map((h, idx)=>{
    let name = (h===undefined || h===null || String(h).trim()==='') ? ('Col'+(idx+1)) : String(h).trim();
    if(seen[name] === undefined){
      seen[name] = 0;
      return name;
    } else {
      seen[name]++;
      return name + '_' + seen[name];
    }
  });
}

// Reads an uploaded workbook fully client-side using SheetJS.
// Scans ALL sheets and picks the one that looks most like a PO/mapping export
// (falls back to the first sheet). Headers are taken from row 1 (array form)
// so we fully control dedupe/blank-header handling ourselves.
function parseWorkbookFile(file, callback, scoreFn){
  if(typeof XLSX === 'undefined'){
    toast('Could not load the Excel engine (no internet connection to the CDN). Try pasting the data instead, or check your internet connection.', true);
    return;
  }
  const reader = new FileReader();
  reader.onload = function(e){
    try{
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, {type:'array'});
      let best = null;
      wb.SheetNames.forEach(name=>{
        const sheet = wb.Sheets[name];
        const aoa = XLSX.utils.sheet_to_json(sheet, {header:1, defval:'', raw:false, blankrows:false});
        if(!aoa.length) return;
        const rawHeaders = (aoa[0]||[]).map(h=> h===undefined||h===null? '' : String(h));
        const headers = dedupeHeaders(rawHeaders);
        const rows = aoa.slice(1).map(arr=>{
          const obj = {};
          headers.forEach((h,i)=> obj[h] = (arr[i]!==undefined ? String(arr[i]).trim() : ''));
          return obj;
        });
        const score = scoreFn ? scoreFn(headers) : rows.length;
        if(!best || score > best.score){
          best = {headers, rows, score, sheetName:name};
        }
      });
      if(!best){
        toast('The uploaded file appears to be empty.', true);
        return;
      }
      callback(best);
    }catch(err){
      toast('Could not read the file: '+err.message, true);
    }
  };
  reader.onerror = function(){
    toast('Error while reading the file from disk.', true);
  };
  reader.readAsArrayBuffer(file);
}

function findKey(headers, candidates){
  for(const cand of candidates){
    const hit = headers.find(h => h.trim().toLowerCase() === cand.toLowerCase());
    if(hit) return hit;
  }
  for(const cand of candidates){
    const hit = headers.find(h => h.trim().toLowerCase().includes(cand.toLowerCase()));
    if(hit) return hit;
  }
  return null;
}

/* ---------------------- Step 1: PO Dump parsing ---------------------- */
const DUMP_PO_CANDS = ['Purchase Order Number','PO Number','PO#'];
const DUMP_ITEM_CANDS = ['Item No','PO Line Item Number','Item Number'];

function dumpScore(headers){
  let s = 0;
  if(findKey(headers, DUMP_PO_CANDS)) s += 5;
  if(findKey(headers, DUMP_ITEM_CANDS)) s += 5;
  if(findKey(headers, ['Quantity Open'])) s += 3;
  if(findKey(headers, ['Net Unit Price'])) s += 2;
  return s;
}

function processDump(headers, rows){
  const key = {
    po: findKey(headers, DUMP_PO_CANDS),
    item: findKey(headers, DUMP_ITEM_CANDS),
    desc: findKey(headers, ['Item Description','Description']),
    unit: findKey(headers, ['Unit']),
    qtyOpen: findKey(headers, ['Quantity Open']),
    qty: findKey(headers, ['Quantity']),
    price: findKey(headers, ['Net Unit Price']),
    priceUnit: findKey(headers, ['Net Unit Price Per']),
    currency: findKey(headers, ['Currency']),
    selfBilling: findKey(headers, ['Is Self Billing']),
    deletedBlocked: findKey(headers, ['Deleted/Blocked','Deleted or Blocked']),
    supplierId: findKey(headers, ['Supplier P20/BP Id','Supplier ID']),
    supplierName: findKey(headers, ['Supplier','Supplier Name']),
    customer: findKey(headers, ['Customer','Customer Name']),
    customerVat: findKey(headers, ['Customer VAT','Customer VAT ID']),
    paymentTerms: findKey(headers, ['Payment Terms']),
    targetSystem: findKey(headers, ['Target System']),
    buyerMatCode: findKey(headers, ['Buyer Material Code']),
  };

  if(!key.po || !key.item){
    const diag = document.getElementById('dumpDiag');
    diag.innerHTML = `<div class="warn-list danger"><b>Could not detect the required columns (PO Number / Item No).</b>Columns found in the file: ${escHtml(headers.join(', '))}</div>`;
    return null;
  }
  document.getElementById('dumpDiag').innerHTML = '';

  let available = [];
  let excluded = 0;

  rows.forEach(r=>{
    const po = r[key.po];
    if(po===undefined || po===null || String(po).trim()==='') return;
    const selfBilling = key.selfBilling ? parseBool(r[key.selfBilling]) : false;
    const deletedBlocked = key.deletedBlocked ? parseBool(r[key.deletedBlocked]) : false;
    const qtyOpen = key.qtyOpen ? parseNum(r[key.qtyOpen]) : 0;
    const qty = key.qty ? parseNum(r[key.qty]) : qtyOpen;

    if(selfBilling || deletedBlocked || qtyOpen<=0){
  excluded++;
  return;
}

    available.push({
      poRaw: po,
      poNorm: normPO(po),
      itemNo: key.item ? r[key.item] : '',
      description: key.desc ? r[key.desc] : '',
      unit: key.unit ? r[key.unit] : 'PCE',
      quantityOpen: qtyOpen,
      quantity: qty,
      netUnitPrice: key.price ? parseNum(r[key.price]) : 0,
      netUnitPricePer: key.priceUnit ? (parseNum(r[key.priceUnit]) || 1) : 1,
      currency: key.currency ? r[key.currency] : 'IQD',
      supplierId: key.supplierId ? r[key.supplierId] : '',
      supplierName: key.supplierName ? r[key.supplierName] : '',
      customer: key.customer ? r[key.customer] : '',
      customerVat: key.customerVat ? r[key.customerVat] : '',
      paymentTerms: key.paymentTerms ? r[key.paymentTerms] : '',
      targetSystem: key.targetSystem ? r[key.targetSystem] : '',
      buyerMaterialCode: key.buyerMatCode ? r[key.buyerMatCode] : '',
    });
  });

  return {available, excluded, totalRows: rows.length};
}

function finishDumpParse(headers, rows){
  const result = processDump(headers, rows);
  if(!result) { toast('Could not parse the PO data — check the diagnostic message.', true); return; }
  state.dumpRows = result.available;
  state.dumpRawCount = result.totalRows;
  state.excludedCount = result.excluded;
  renderDumpStats();
  // If invoices were already built earlier, this PO data just changed under
  // them — rebuild silently so the preview never shows a stale calculation.
  if(state.invoices.length) buildInvoices({silent:true});
  autoSave();
  toast('PO data analyzed successfully ✓');
}

function handleDumpParse(){
  const text = document.getElementById('dumpText').value.trim();
  const fileInput = document.getElementById('dumpFile');

  if(fileInput.files && fileInput.files[0]){
    parseWorkbookFile(fileInput.files[0], ({headers, rows})=> finishDumpParse(headers, rows), dumpScore);
  } else if(text){
    const {headers, rows} = parseDelimitedText(text);
    finishDumpParse(headers, rows);
  } else {
    toast('Paste the data or upload a file first', true);
  }
}

function renderDumpStats(){
  const poSet = new Set(state.dumpRows.map(r=>r.poNorm));
  document.getElementById('dumpStats').style.display='grid';
  document.getElementById('stRows').textContent = state.dumpRawCount;
  document.getElementById('stAvail').textContent = state.dumpRows.length;
  document.getElementById('stExcluded').textContent = state.excludedCount;
  document.getElementById('stPOs').textContent = poSet.size;
  const badge = document.getElementById('dumpBadge');
  if(state.dumpRows.length){
    badge.textContent = poSet.size + ' PO(s) available';
    badge.className = 'badge good';
    markStepDone(1);
  } else {
    badge.textContent = 'No invoiceable line items found';
    badge.className = 'badge bad';
  }
}

/* ---------------------- Step 2: Invoice reference mapping ---------------------- */
const MAP_PO_CANDS = ['PO#','PO Number','Purchase Order Number'];
const MAP_INV_CANDS = ['Invoice Number','Invoice Reference'];
const MAP_AMOUNT_CANDS = ['Invoice Amount','Amount','Target Amount','Invoice Amt'];

function mapScore(headers){
  let s = 0;
  if(findKey(headers, MAP_PO_CANDS)) s += 5;
  if(findKey(headers, MAP_INV_CANDS)) s += 5;
  if(findKey(headers, ['Site'])) s += 1;
  if(findKey(headers, MAP_AMOUNT_CANDS)) s += 1;
  return s;
}

function processMap(headers, rows){
  const key = {
    po: findKey(headers, MAP_PO_CANDS),
    site: findKey(headers, ['Site']),
    invNum: findKey(headers, MAP_INV_CANDS),
    amount: findKey(headers, MAP_AMOUNT_CANDS),
  };
  if(!key.po || !key.invNum){
    const diag = document.getElementById('mapDiag');
    diag.innerHTML = `<div class="warn-list danger"><b>Could not detect the required columns (PO# / Invoice Number).</b>Columns found in the file: ${escHtml(headers.join(', '))}</div>`;
    return null;
  }
  document.getElementById('mapDiag').innerHTML = '';
  const map = {};
  rows.forEach(r=>{
    const po = r[key.po];
    if(po===undefined || String(po).trim()==='') return;
    map[normPO(po)] = {
      site: key.site ? r[key.site] : '',
      invoiceNumber: r[key.invNum],
      invoiceAmount: key.amount ? parseCurrency(r[key.amount]) : null,
    };
  });
  return {map, count: rows.length};
}

function finishMapParse(headers, rows){
  const result = processMap(headers, rows);
  if(!result) { toast('Could not parse the invoice table — check the diagnostic message.', true); return; }
  state.invoiceMap = result.map;
  state.mapRawCount = result.count;
  renderMapStats();
  // If invoices were already built earlier, the invoice numbers / target
  // amounts just changed under them — rebuild silently so the preview never
  // shows a stale calculation (e.g. missing a newly-added Invoice Amount).
  if(state.invoices.length) buildInvoices({silent:true});
  autoSave();
  toast('Invoice number table analyzed successfully ✓');
}

function handleMapParse(){
  const text = document.getElementById('mapText').value.trim();
  const fileInput = document.getElementById('mapFile');

  if(fileInput.files && fileInput.files[0]){
    parseWorkbookFile(fileInput.files[0], ({headers, rows})=> finishMapParse(headers, rows), mapScore);
  } else if(text){
    const {headers, rows} = parseDelimitedText(text);
    finishMapParse(headers, rows);
  } else {
    toast('Paste the table or upload a file first', true);
  }
}

function renderMapStats(){
  document.getElementById('mapStats').style.display='grid';
  const poSet = new Set(state.dumpRows.map(r=>r.poNorm));
  const mapKeys = Object.keys(state.invoiceMap);
  const matched = mapKeys.filter(k=>poSet.has(k)).length;
  const withTarget = mapKeys.filter(k=>{
    const a = state.invoiceMap[k].invoiceAmount;
    return a!==null && a!==undefined;
  }).length;
  document.getElementById('stMapRows').textContent = state.mapRawCount;
  document.getElementById('stMapMatched').textContent = matched;
  document.getElementById('stMapUnmatched').textContent = mapKeys.length - matched;
  document.getElementById('stMapTarget').textContent = withTarget;
  const badge = document.getElementById('mapBadge');
  if(mapKeys.length){
    badge.textContent = matched + ' matched';
    badge.className = 'badge good';
    markStepDone(2);
  }
}

/* ---------------------- Step 3->4: Build invoices ---------------------- */
function buildInvoices(opts){
  opts = opts || {};
  if(!state.dumpRows.length){
    if(!opts.silent) toast('Import the PO data first (Step 1)', true);
    return;
  }
  if(!Object.keys(state.invoiceMap).length){
    if(!opts.silent) toast('Import the invoice reference table first (Step 2)', true);
    return;
  }
  const vatPercent = parseNum(document.getElementById('vatPercent').value);
  const bankAccount = document.getElementById('bankAccount').value.trim();
  const companyCode = document.getElementById('companyCode').value.trim();
  const invoiceDate = todayISO();
  document.getElementById('invoiceDateDisplay').value = invoiceDate;

  // group by PO
  const groups = {};
  state.dumpRows.forEach(r=>{
    if(!groups[r.poNorm]) groups[r.poNorm] = [];
    groups[r.poNorm].push(r);
  });

  // Only build invoices for PO's that were explicitly listed in the
  // Step 2 invoice-reference table. A PO present in the dump but absent
  // from that table is intentionally skipped (not every PO in the raw
  // export is necessarily meant to be invoiced in this batch).
  const requestedPOs = Object.keys(groups).filter(poNorm=>{
    const mapEntry = state.invoiceMap[poNorm];
    return mapEntry && String(mapEntry.invoiceNumber||'').trim() !== '';
  });

  // PO's requested in Step 2 but missing entirely from the Step 1 dump
  const missingFromDump = Object.keys(state.invoiceMap).filter(poNorm => !groups[poNorm]);

  const invoices = requestedPOs.map(poNorm=>{
    const items = groups[poNorm];
    const first = items[0];
    const mapEntry = state.invoiceMap[poNorm];
    const targetAmount = (mapEntry.invoiceAmount!==undefined && mapEntry.invoiceAmount!==null)
      ? mapEntry.invoiceAmount : null;

    // Pass 1: Net amounts only (independent of VAT).
    const netAmounts = items.map(it => it.quantity * it.netUnitPrice * it.netUnitPricePer);
    const totalNetRaw = netAmounts.reduce((s,x)=>s+x, 0);

    // Does the Net Amount (from the PO's available quantity) already cover
    // the Step 2 target invoice amount? If yes, VAT applies normally (old
    // behaviour) — Gross naturally ends up at or above the target. If the
    // Net Amount alone falls short of the target, there's no legitimate VAT%
    // that fixes it, so this invoice is overridden instead (see below).
    let targetMatched = true;
    if(targetAmount!==null){
      targetMatched = (totalNetRaw + TARGET_TOLERANCE) >= targetAmount;
    }
    const targetOverridden = (targetAmount!==null) && !targetMatched;

    // Pass 2: build each line item's VAT/Gross figures.
    let calcVatArr;
    if(targetOverridden){
      // Net Amount doesn't cover the requested Nokia invoice amount — the
      // available quantity is short. Per instruction: VAT % -> 0% for this
      // invoice, and the Calculated VAT Amount is forced to the exact
      // target amount from Step 2 (split across this PO's line items,
      // proportional to each line's net amount, if there's more than one).
      calcVatArr = distributeAmount(targetAmount, netAmounts);
    } else {
      calcVatArr = netAmounts.map(net => net * (vatPercent/100));
    }

    const lineItems = items.map((it, i)=>{
      const netAmount = netAmounts[i];
      const lineVatPercent = targetOverridden ? 0 : vatPercent;
      const calcVat = calcVatArr[i];
      const gross = netAmount + calcVat;
      return {
        po: it.poRaw, itemNo: it.itemNo, description: it.description, unit: it.unit,
        quantity: it.quantity, netUnitPrice: it.netUnitPrice, currency: it.currency,
        netUnitPricePer: it.netUnitPricePer, netAmount, vatPercent: lineVatPercent, vatAmount: 0,
        calcVat, gross, buyerMaterialCode: it.buyerMaterialCode,
        materialService: 'Material', targetSystem: it.targetSystem, paymentTerms: it.paymentTerms,
        shipFrom: 'IQ', shipTo: 'IQ',
      };
    });
    const totalNet = lineItems.reduce((s,x)=>s+x.netAmount,0);
    const totalVat = lineItems.reduce((s,x)=>s+x.calcVat,0);
    const totalGross = lineItems.reduce((s,x)=>s+x.gross,0);
    return {
      poNorm, poDisplay: first.poRaw,
      invoiceReference: mapEntry.invoiceNumber,
      site: mapEntry.site || '',
      invoiceDate, bankAccount, companyCode,
      supplierId: first.supplierId, supplierName: first.supplierName,
      customer: first.customer, customerVat: first.customerVat,
      currency: first.currency, targetSystem: first.targetSystem, paymentTerms: first.paymentTerms,
      vatPercent: targetOverridden ? 0 : vatPercent, lineItems, totalNet, totalVat, totalGross,
      targetAmount, targetMatched, targetOverridden,
    };
  });

  state.invoices = invoices;
  state.missingFromDump = missingFromDump;
  renderInvoices();
  autoSave();
  if(!opts.silent){
    if(invoices.length){
      toast(`Built ${invoices.length} invoice(s) from the matched PO list ✓`);
    } else {
      toast('No PO numbers matched between Step 1 and Step 2 — nothing to build.', true);
    }
  }
}

function renderInvoices(){
  const list = document.getElementById('invoiceList');
  const empty = document.getElementById('emptyInvoices');
  list.innerHTML = '';
  if(!state.invoices.length){
    empty.style.display='block';
    document.getElementById('invBadge').textContent = '0 invoices';
    document.getElementById('sumInvoices').textContent = '0';
    document.getElementById('sumLines').textContent = '0';
    document.getElementById('sumNet').textContent = '0';
    document.getElementById('sumVat').textContent = '0';
    document.getElementById('sumGross').textContent = '0';
    renderMissingWarning();
    renderOverrideWarning();
    return;
  }
  empty.style.display='none';
  document.getElementById('invBadge').textContent = state.invoices.length + ' invoices';
  document.getElementById('invBadge').className = 'badge good';

  // Totals always cover EVERY invoice, never the filtered view. A filtered
  // subtotal misread as the batch total is how a wrong invoice ships.
  let sumLines=0, sumNet=0, sumVat=0, sumGross=0;
  state.invoices.forEach(inv=>{
    sumLines += inv.lineItems.length;
    sumNet += inv.totalNet; sumVat += inv.totalVat; sumGross += inv.totalGross;
  });

  const view = invoiceView();
  document.getElementById('invToolbar').style.display =
    state.invoices.length > 1 ? 'flex' : 'none';

  const showing = document.getElementById('invShowing');
  if(view.length !== state.invoices.length){
    showing.style.display = 'block';
    showing.innerHTML = 'Showing <b>' + view.length + '</b> of <b>' +
      state.invoices.length + '</b> invoices — the totals above still cover all ' +
      state.invoices.length + '.';
  } else {
    showing.style.display = 'none';
  }
  if(!view.length){
    list.innerHTML = '<div class="empty-state"><div class="icon">🔍</div>No invoices match this search.</div>';
  }

  view.forEach((inv, idx)=>{
    const div = document.createElement('div');
    div.className = 'invoice';
    div.innerHTML = `
      <div class="invoice-head" onclick="toggleInvoice(${idx})">
        <div class="left">
          <span class="po">PO ${escHtml(inv.poDisplay)}</span>
          <span class="ref">📄 ${escHtml(inv.invoiceReference)}</span>
          <span class="badge neutral">${inv.lineItems.length} line(s)</span>
          ${targetBadge(inv)}
        </div>
        <div class="breakdown">
          <span>Net: <b>${fmtNum(inv.totalNet)}</b></span>
          <span>× VAT ${inv.vatPercent}%: <b>${fmtNum(inv.totalVat)}</b></span>
          <span class="gross">= Gross: ${fmtNum(inv.totalGross)} ${escHtml(inv.currency)}</span>
          ${inv.targetAmount!==null ? `<span>Target: <b>${fmtNum(inv.targetAmount)}</b></span>` : ''}
          <span class="chev">▾</span>
        </div>
      </div>
      <div class="invoice-body">
        <div class="hdr-fact">
          <span>Supplier ID: <b>${escHtml(inv.supplierId)}</b></span>
          <span>Customer: <b>${escHtml(inv.customer)}</b></span>
          <span>Invoice Date: <b>${inv.invoiceDate}</b></span>
          <span>Bank Account: <b>${escHtml(inv.bankAccount)}</b></span>
          <span>Target System: <b>${escHtml(inv.targetSystem)}</b></span>
          <span>Payment Terms: <b>${escHtml(inv.paymentTerms)}</b></span>
        </div>
        ${inv.targetOverridden ? `<div class="warn-list"><b>VAT overridden for this invoice:</b> Net Amount (${fmtNum(inv.totalNet)}) doesn't cover the target amount (${fmtNum(inv.targetAmount)}), so VAT % was set to 0% and Calculated VAT Amount was forced to that exact target instead.</div>` : ''}
        <table class="mini">
          <thead><tr>
            <th>Item</th><th>Description</th><th>Qty</th><th>Unit Price</th>
            <th>Net Amount</th><th>VAT %</th><th>Net × VAT%</th><th>Gross</th>
          </tr></thead>
          <tbody>
            ${inv.lineItems.map(li=>`
              <tr>
                <td>${escHtml(li.itemNo)}</td>
                <td>${escHtml(li.description)}</td>
                <td>${fmtNum(li.quantity)}</td>
                <td>${fmtNum(li.netUnitPrice)}</td>
                <td>${fmtNum(li.netAmount)}</td>
                <td>${li.vatPercent}%</td>
                <td>${fmtNum(li.netAmount)} × ${li.vatPercent}% = <b>${fmtNum(li.calcVat)}</b></td>
                <td><b>${fmtNum(li.gross)}</b></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
    list.appendChild(div);
  });

  document.getElementById('sumInvoices').textContent = state.invoices.length;
  document.getElementById('sumLines').textContent = sumLines;
  document.getElementById('sumNet').textContent = fmtNum(sumNet);
  document.getElementById('sumVat').textContent = fmtNum(sumVat);
  document.getElementById('sumGross').textContent = fmtNum(sumGross);

  renderMissingWarning();
  renderOverrideWarning();
  markStepDone(4);
}

// Badge shown next to each invoice header describing its target-amount status.
function targetBadge(inv){
  if(inv.targetAmount===null || inv.targetAmount===undefined) return '';
  if(inv.targetOverridden){
    return `<span class="badge gold" title="Net Amount doesn't cover the target — VAT set to 0% and Calculated VAT Amount forced to the Step 2 target amount.">⚠ VAT→0%, target forced</span>`;
  }
  return `<span class="badge good" title="Net Amount covers the target invoice amount from Step 2 — VAT % applied normally.">✓ Net covers target</span>`;
}

// The VAT % that was actually TESTED against this invoice's target (i.e. the
// Step 3 global rate), even when the invoice ended up overridden to 0%.
function vatPercentOf(inv){
  const el = document.getElementById('vatPercent');
  return el ? parseNum(el.value) : inv.vatPercent;
}

function renderMissingWarning(){
  const warnDiv = document.getElementById('unmatchedWarning');
  const missing = state.missingFromDump || [];
  if(missing.length>0){
    warnDiv.innerHTML = `<div class="warn-list"><b>Heads up:</b> ${missing.length} PO number(s) from your Step 2 invoice table were not found in the Step 1 PO data, so no invoice could be built for them: ${escHtml(missing.join(', '))}</div>`;
  } else {
    warnDiv.innerHTML = '';
  }
}

function renderOverrideWarning(){
  const box = document.getElementById('overrideWarning');
  if(!box) return;
  const overridden = (state.invoices||[]).filter(inv=>inv.targetOverridden);
  if(overridden.length>0){
    box.innerHTML = `<div class="warn-list"><b>VAT forced to 0% for ${overridden.length} invoice(s):</b> the available quantity keeps Net Amount below the Step 2 target amount, so VAT % was set to 0% and Calculated VAT Amount was set to the exact target amount instead for: ${escHtml(overridden.map(i=>i.poDisplay).join(', '))}.</div>`;
  } else {
    box.innerHTML = '';
  }
}

function toggleInvoice(idx){
  const nodes = document.querySelectorAll('#invoiceList .invoice');
  nodes[idx].classList.toggle('open');
}

/* ---------------------- Step 5: Export styled Excel ---------------------- */
async function exportExcel(){
  if(!state.invoices.length){
    toast('No invoices to export — build the invoices first.', true);
    return;
  }
  if(typeof ExcelJS === 'undefined'){
    toast('Could not load the Excel export engine (no internet connection to the CDN).', true);
    return;
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Submit');

  const NAVY_LABEL_BG = 'FFB9D0EE';   // blue header label row
  const GREEN_LABEL_BG = 'FFC9E4CC';  // green line-item label row
  const YELLOW_BG = 'FFFFF6C9';       // mandatory-ish highlight

  function setRow(rowNum, values, bgHex, boldLabels){
    values.forEach((val, i)=>{
      const cell = ws.getCell(rowNum, i+1);
      cell.value = val;
      if(bgHex){
        cell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:bgHex}};
      }
      if(boldLabels) cell.font = {bold:true, size:10};
      cell.alignment = {vertical:'middle'};
      cell.border = {bottom:{style:'thin', color:{argb:'FFE0E6EF'}}};
    });
  }

  let r = 1;
  state.invoices.forEach(inv=>{
    setRow(r, HDR_LABELS, NAVY_LABEL_BG, true);
    const hdrRow = r+1;
    const hdrVals = [
      'Invoice', inv.invoiceReference || '', inv.supplierId, inv.supplierName,
      '', inv.companyCode, inv.customer, inv.customerVat,
      inv.invoiceDate, inv.currency, '', inv.bankAccount,
      '', inv.targetSystem, inv.paymentTerms
    ];
        setRow(hdrRow, hdrVals, null, false);
    [2,9,12].forEach(colIdx=>{
      ws.getCell(hdrRow, colIdx).fill = {type:'pattern', pattern:'solid', fgColor:{argb:YELLOW_BG}};
    });
    // Write Invoice Date as a REAL Excel date cell (not text) — Nokia's importer
    // validates the cell's actual date type, not just the displayed text.
    const dateParts = String(inv.invoiceDate).split('-');
    if(dateParts.length === 3){
      const dCell = ws.getCell(hdrRow, 9);
      dCell.value = new Date(Date.UTC(parseInt(dateParts[0],10), parseInt(dateParts[1],10)-1, parseInt(dateParts[2],10)));
      dCell.numFmt = 'yyyy-mm-dd';
    }
    const lineLabelRow = hdrRow+1;
    setRow(lineLabelRow, LINE_LABELS, GREEN_LABEL_BG, true);

    let lr = lineLabelRow+1;
    inv.lineItems.forEach(li=>{
      const vals = [
        li.po, li.itemNo, li.description, li.unit, li.quantity,
        li.netUnitPrice, li.currency, li.netUnitPricePer, li.netAmount, li.vatPercent,
        0, li.calcVat, li.gross, '', li.buyerMaterialCode,
        li.materialService, li.targetSystem, li.paymentTerms, li.shipFrom, li.shipTo
      ];
      setRow(lr, vals, null, false);
      lr++;
    });
    r = lr + 1; // blank separator row
  });

  const widths = [14,16,12,26,12,10,26,12,20,10,14,14,20,14,14,14,16,12,14,20,10,14,14,14,12,16,14,20,16,16];
  widths.forEach((w,i)=> ws.getColumn(i+1).width = w);

  try{
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {type:'application/octet-stream'});
    const fname = (document.getElementById('exportFileName').value.trim() || 'Multi-upload_PO_Invoices') + '.xlsx';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);

    document.getElementById('exportMsg').innerHTML = `<span class="badge good">✓ Downloaded ${escHtml(fname)}</span>`;
    toast('File exported successfully ✓');
  }catch(err){
    document.getElementById('exportMsg').innerHTML = `<span class="badge bad">✗ Export failed: ${escHtml(err.message)}</span>`;
    toast('Export failed: '+err.message, true);
  }
}

/* ---------------------- Sessions (localStorage) ---------------------- */
const SESS_KEY = 'mfc_invoice_sessions_v1';
const AUTOSAVE_KEY = 'mfc_invoice_autosave_v1';

function storageAvailable(){
  try{
    const k = '__mfc_test__';
    localStorage.setItem(k,'1');
    localStorage.removeItem(k);
    return true;
  }catch(e){
    return false;
  }
}

function currentSnapshot(){
  return {
    dumpText: document.getElementById('dumpText').value,
    mapText: document.getElementById('mapText').value,
    vatPercent: document.getElementById('vatPercent').value,
    bankAccount: document.getElementById('bankAccount').value,
    companyCode: document.getElementById('companyCode').value,
    dumpRows: state.dumpRows,
    dumpRawCount: state.dumpRawCount,
    excludedCount: state.excludedCount,
    invoiceMap: state.invoiceMap,
    mapRawCount: state.mapRawCount,
    invoices: state.invoices,
    missingFromDump: state.missingFromDump || [],
  };
}

function applySnapshot(snap){
  document.getElementById('dumpText').value = snap.dumpText || '';
  document.getElementById('mapText').value = snap.mapText || '';
  document.getElementById('vatPercent').value = (snap.vatPercent!==undefined && snap.vatPercent!==null) ? snap.vatPercent : 30;
  document.getElementById('bankAccount').value = snap.bankAccount || '005673917711';
  document.getElementById('companyCode').value = snap.companyCode || 'FIIX';
  state.dumpRows = snap.dumpRows || [];
  state.dumpRawCount = snap.dumpRawCount || 0;
  state.excludedCount = snap.excludedCount || 0;
  state.invoiceMap = snap.invoiceMap || {};
  state.mapRawCount = snap.mapRawCount || 0;
  state.invoices = snap.invoices || [];
  state.missingFromDump = snap.missingFromDump || [];
  if(state.dumpRows.length) renderDumpStats();
  if(Object.keys(state.invoiceMap).length) renderMapStats();
  renderInvoices();
}

let __storageOK = null;
function autoSave(){
  if(__storageOK === null) __storageOK = storageAvailable();
  if(!__storageOK) return;
  try{
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(currentSnapshot()));
  }catch(e){
    console.warn('Autosave failed:', e);
  }
}

function restoreAutoSave(showToast){
  if(__storageOK === null) __storageOK = storageAvailable();
  if(!__storageOK){
    if(showToast) toast('Browser storage is not available (private/incognito mode may block it).', true);
    return;
  }
  const raw = localStorage.getItem(AUTOSAVE_KEY);
  if(!raw) { if(showToast) toast('No previous session found'); return; }
  try{
    applySnapshot(JSON.parse(raw));
    if(showToast) toast('Last working session restored ✓');
  }catch(e){
    if(showToast) toast('Could not restore the last session (corrupted data).', true);
  }
}

function getSessions(){
  try{ return JSON.parse(localStorage.getItem(SESS_KEY)) || []; }catch(e){ return []; }
}
function saveSessions(list){
  localStorage.setItem(SESS_KEY, JSON.stringify(list));
}

function doSaveSession(name){
  if(__storageOK === null) __storageOK = storageAvailable();
  if(!__storageOK){
    toast('Cannot save: browser storage is unavailable (try leaving private/incognito mode).', true);
    return false;
  }
  const finalName = (name && name.trim()) ? name.trim() : ('Session ' + new Date().toLocaleString());
  try{
    const sessions = getSessions();
    sessions.unshift({
      id: 'sess_'+Date.now(),
      name: finalName,
      savedAt: new Date().toLocaleString(),
      snapshot: currentSnapshot(),
    });
    saveSessions(sessions);
    return true;
  }catch(e){
    toast('Save failed: '+e.message, true);
    return false;
  }
}

function saveNamedSession(){
  const nameInput = document.getElementById('sessionName');
  const ok = doSaveSession(nameInput.value);
  if(ok){
    nameInput.value='';
    renderSessions();
    toast('Session saved ✓');
  }
}

function saveSessionFromTopBar(){
  const suggested = 'Session ' + new Date().toLocaleString();
  const name = window.prompt('Name this session:', suggested);
  if(name === null) return; // user cancelled
  const ok = doSaveSession(name);
  if(ok){
    toast('Session saved ✓');
    if(document.getElementById('sec6').classList.contains('active')) renderSessions();
  }
}

function loadSession(id){
  const sessions = getSessions();
  const s = sessions.find(x=>x.id===id);
  if(!s) return;
  applySnapshot(s.snapshot);
  autoSave();
  toast('Session loaded: '+s.name);
  goStep(4);
}

function deleteSession(id){
  let sessions = getSessions();
  sessions = sessions.filter(x=>x.id!==id);
  saveSessions(sessions);
  renderSessions();
  toast('Session deleted');
}

function renderSessions(){
  const sessions = getSessions();
  const list = document.getElementById('sessionsList');
  const empty = document.getElementById('emptySessions');
  list.innerHTML='';
  if(!sessions.length){ empty.style.display='block'; return; }
  empty.style.display='none';
  sessions.forEach(s=>{
    const nInv = (s.snapshot.invoices||[]).length;
    const div = document.createElement('div');
    div.className='session-item';
    div.innerHTML = `
      <div>
        <div><b>${escHtml(s.name)}</b></div>
        <div class="meta">${escHtml(s.savedAt)} · ${nInv} invoice(s)</div>
      </div>
      <div class="actions">
        <button class="btn-secondary" onclick="loadSession('${s.id}')">Open</button>
        <button class="btn-danger" onclick="deleteSession('${s.id}')">Delete</button>
      </div>`;
    list.appendChild(div);
  });
}

/* ---------------------- Navigation ---------------------- */
function goStep(n){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.getElementById('sec'+n).classList.add('active');
  document.querySelectorAll('.step').forEach(s=>s.classList.remove('active'));
  document.querySelector(`.step[data-step="${n}"]`).classList.add('active');
  const titles = {
    1:['Import Purchase Order Data','Paste or upload the raw PO export file from AP eConnect (All Items export)'],
    2:['Import Invoice Numbers','Link each PO to its invoice number via the Site / PO# / Invoice Number table'],
    3:['Settings & Tax','Fixed values applied to every invoice: bank account, company code, and VAT %'],
    4:['Invoice Preview','Review each invoice before exporting — totals update instantly when VAT % changes'],
    5:['Export Excel','Download a Multi-Upload file ready to import into AP eConnect'],
    6:['Saved Sessions','Save your current work or reopen a previous import'],
    7:['Team Ledger','Every invoice your team has recorded in the shared cloud database'],
  };
  document.getElementById('pageTitle').textContent = titles[n][0];
  document.getElementById('pageSub').textContent = titles[n][1];
  if(n===6) renderSessions();
  window.scrollTo({top:0, behavior:'smooth'});
}

function markStepDone(n){
  const el = document.querySelector(`.step[data-step="${n}"]`);
  if(el) el.classList.add('done');
}

/* ---------------------- Wire up events ---------------------- */
document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('yearNow').textContent = new Date().getFullYear();
  document.getElementById('invoiceDateDisplay').value = todayISO();

  document.querySelectorAll('.step').forEach(el=>{
    el.addEventListener('click', ()=> goStep(el.dataset.step));
  });

  document.getElementById('btnParseDump').addEventListener('click', handleDumpParse);
  // Auto-parse as soon as a file is chosen, in addition to the explicit button.
  document.getElementById('dumpFile').addEventListener('change', function(){
    if(this.files && this.files[0]) handleDumpParse();
  });
  document.getElementById('btnClearDump').addEventListener('click', ()=>{
    document.getElementById('dumpText').value='';
    document.getElementById('dumpFile').value='';
    state.dumpRows=[]; state.dumpRawCount=0; state.excludedCount=0;
    state.invoices=[]; state.missingFromDump=[];
    document.getElementById('dumpStats').style.display='none';
    document.getElementById('dumpDiag').innerHTML='';
    document.getElementById('dumpBadge').textContent='Not imported yet';
    document.getElementById('dumpBadge').className='badge neutral';
    renderInvoices();
    autoSave();
  });

  document.getElementById('btnParseMap').addEventListener('click', handleMapParse);
  document.getElementById('mapFile').addEventListener('change', function(){
    if(this.files && this.files[0]) handleMapParse();
  });
  document.getElementById('btnClearMap').addEventListener('click', ()=>{
    document.getElementById('mapText').value='';
    document.getElementById('mapFile').value='';
    state.invoiceMap={}; state.mapRawCount=0;
    state.invoices=[]; state.missingFromDump=[];
    document.getElementById('mapStats').style.display='none';
    document.getElementById('mapDiag').innerHTML='';
    document.getElementById('mapBadge').textContent='Not imported yet';
    document.getElementById('mapBadge').className='badge neutral';
    renderInvoices();
    autoSave();
  });

  // VAT % changes: if invoices were already built, silently rebuild them so
  // the per-invoice target-amount match/override logic re-runs against the
  // new rate (it can't be a lightweight "recalc" anymore — matching depends
  // on the rate itself).
  document.getElementById('vatPercent').addEventListener('input', ()=>{
    if(state.invoices.length) buildInvoices({silent:true});
  });
  document.getElementById('bankAccount').addEventListener('input', autoSave);
  document.getElementById('companyCode').addEventListener('input', autoSave);

  document.getElementById('btnExportExcel').addEventListener('click', exportExcel);

  document.getElementById('btnSaveSession').addEventListener('click', saveNamedSession);
  document.getElementById('btnSaveSessionTop').addEventListener('click', saveSessionFromTopBar);
  document.getElementById('btnAutoRestoreInfo').addEventListener('click', ()=> restoreAutoSave(true));

  // ---- Step 4 toolbar ----
  document.getElementById('invFilter').addEventListener('input', function(){
    invView.q = this.value; renderInvoices();
  });
  document.getElementById('invSort').addEventListener('change', function(){
    invView.sort = this.value; renderInvoices();
  });
  document.getElementById('btnExpandAll').addEventListener('click', ()=>
    document.querySelectorAll('#invoiceList .invoice').forEach(n=> n.classList.add('open')));
  document.getElementById('btnCollapseAll').addEventListener('click', ()=>
    document.querySelectorAll('#invoiceList .invoice').forEach(n=> n.classList.remove('open')));

  // ---- Drag & drop onto the two import cards ----
  wireDrop(document.querySelector('#sec1 .card'), document.getElementById('dumpFile'), handleDumpParse);
  wireDrop(document.querySelector('#sec2 .card'), document.getElementById('mapFile'), handleMapParse);

  // ---- Cloud sync (optional; no-ops when unconfigured) ----
  Cloud.onChange(renderCloudStatus);
  Cloud.onLedger(receiveLedger);
  document.getElementById('btnCloudAuth').addEventListener('click', ()=>{
    const s = Cloud.state();
    (s.signedIn ? Cloud.signOut() : Cloud.signIn())
      .catch(e=> toast('Sign-in failed: '+e.message, true));
  });
  document.getElementById('btnPushCloud').addEventListener('click', handleCloudPush);
  document.getElementById('ledgerFilter').addEventListener('input', renderLedger);
  document.getElementById('ledgerScope').addEventListener('change', renderLedger);
  Cloud.init();

  // silent restore of last working state on load
  restoreAutoSave(false);
  renderSessions();
});


/* ---------------------- Cloud: status, ledger, push ----------------------
   All of this is inert when firebase-config.js still holds placeholders —
   the app stays a fully working offline tool. */

let __ledgerRows = [];

function renderCloudStatus(s){
  const pill = document.getElementById('cloudPill');
  if(!pill) return;
  const btn      = document.getElementById('btnCloudAuth');
  const badge    = document.getElementById('ledgerBadge');
  const setup    = document.getElementById('cloudSetup');
  const controls = document.getElementById('ledgerControls');

  if(!s.available){
    pill.textContent = '☁ Off';
    pill.className = 'cloud-pill';
    pill.title = s.reason;
    btn.style.display = 'none';
    badge.textContent = 'Not connected';
    badge.className = 'badge neutral';
    controls.style.display = 'none';
    setup.style.display = 'block';
    setup.innerHTML = '<b>Cloud sync is switched off — ' + escHtml(s.reason) + '</b>' +
      'The app works normally without it; invoices just stay on this device. ' +
      'To turn on shared tracking, follow the setup steps at the top of ' +
      '<code class="inline">firebase-config.js</code>, then reload this page.';
    return;
  }

  setup.style.display = 'none';

  if(!s.signedIn){
    pill.textContent = '☁ Sign in';
    pill.className = 'cloud-pill warn';
    pill.title = 'Cloud sync is configured — sign in to use it';
    btn.style.display = '';
    btn.textContent = 'Sign in';
    badge.textContent = 'Signed out';
    badge.className = 'badge neutral';
    controls.style.display = 'none';
    return;
  }

  if(!s.allowed){
    pill.textContent = '☁ No access';
    pill.className = 'cloud-pill err';
    pill.title = s.email + ' is not on the team allowlist';
    btn.style.display = '';
    btn.textContent = 'Sign out';
    badge.textContent = 'Not authorised';
    badge.className = 'badge bad';
    controls.style.display = 'none';
    setup.style.display = 'block';
    setup.innerHTML = '<b>' + escHtml(s.email) + ' is not on the team allowlist.</b>' +
      'Ask whoever owns the Firebase project to add this address to the allowlist in ' +
      '<code class="inline">firestore.rules</code> and republish the rules.';
    return;
  }

  pill.textContent = '☁ ' + escHtml(s.name);
  pill.className = 'cloud-pill on';
  pill.title = 'Signed in as ' + s.email;
  btn.style.display = '';
  btn.textContent = 'Sign out';
  badge.textContent = 'Live';
  badge.className = 'badge good';
  controls.style.display = 'flex';
}

function receiveLedger(rows, err){
  if(err){
    document.getElementById('ledgerBadge').textContent = 'Read failed';
    document.getElementById('ledgerBadge').className = 'badge bad';
    const setup = document.getElementById('cloudSetup');
    setup.style.display = 'block';
    setup.innerHTML = '<b>Could not read the ledger.</b>' + escHtml(err.message || String(err)) +
      '<br><br>This is usually the security rules: check that your email is in the allowlist in ' +
      '<code class="inline">firestore.rules</code> and that the rules are published.';
    __ledgerRows = [];
  } else {
    __ledgerRows = rows || [];
  }
  renderLedger();
}

function renderLedger(){
  const list  = document.getElementById('ledgerList');
  const empty = document.getElementById('emptyLedger');
  const stats = document.getElementById('ledgerStats');
  if(!list) return;

  const q     = (document.getElementById('ledgerFilter').value || '').trim().toLowerCase();
  const scope = document.getElementById('ledgerScope').value;
  const me    = Cloud.state().email.toLowerCase();

  const rows = __ledgerRows.filter(r=>{
    if(scope === 'mine' && String(r.createdBy||'').toLowerCase() !== me) return false;
    if(scope === 'overridden' && !r.targetOverridden) return false;
    if(!q) return true;
    return [r.invoiceReference, r.poNumber, r.supplierName, r.customer, r.createdBy, r.site]
      .map(v=> String(v||'').toLowerCase()).some(v=> v.includes(q));
  });

  list.innerHTML = '';
  if(!rows.length){
    empty.style.display = 'block';
    empty.innerHTML = '<div class="icon">☁</div>' +
      (__ledgerRows.length ? 'No invoices match this filter.' : 'Nothing saved to the ledger yet.');
    stats.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  stats.style.display = 'grid';

  document.getElementById('ldCount').textContent    = rows.length;
  document.getElementById('ldGross').textContent    = fmtNum(rows.reduce((s,r)=> s + (Number(r.totalGross)||0), 0));
  document.getElementById('ldPeople').textContent   = new Set(rows.map(r=> r.createdBy)).size;
  document.getElementById('ldOverride').textContent = rows.filter(r=> r.targetOverridden).length;

  rows.forEach(r=>{
    const when = r.updatedAt && r.updatedAt.toDate
      ? r.updatedAt.toDate().toLocaleString() : '—';
    const div = document.createElement('div');
    div.className = 'ledger-row';
    div.innerHTML = `
      <div>
        <div><span class="ref">${escHtml(r.invoiceReference)}</span>
             <span class="badge neutral">PO ${escHtml(r.poNumber)}</span>
             ${r.targetOverridden ? '<span class="badge gold">VAT→0%</span>' : ''}</div>
        <div class="meta">${escHtml(r.supplierName||'—')} · ${r.lineItemCount||0} line(s) · by ${escHtml(r.createdBy)} · ${escHtml(when)}</div>
      </div>
      <div class="amt">
        Net <b>${fmtNum(r.totalNet)}</b> · VAT <b>${fmtNum(r.totalVat)}</b> ·
        Gross <b>${fmtNum(r.totalGross)}</b> ${escHtml(r.currency||'')}
      </div>`;
    list.appendChild(div);
  });
}

function handleCloudPush(){
  if(!state.invoices.length){ toast('Build the invoices first (Step 3).', true); return; }
  const s = Cloud.state();
  if(!s.available){ toast(Cloud.reason(), true); return; }
  if(!s.signedIn){ toast('Sign in before saving to the team ledger.', true); return; }

  const btn = document.getElementById('btnPushCloud');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '☁ Saving…';

  Cloud.push(state.invoices)
    .then(res=>{
      toast('Saved ' + res.saved + ' invoice(s) to the team ledger ✓');
      document.getElementById('exportMsg').innerHTML =
        '<span class="badge good">☁ ' + res.saved + ' invoice(s) recorded in the team ledger</span>';
      goStep(7);
    })
    .catch(e=> toast('Cloud save failed: ' + e.message, true))
    .then(()=>{ btn.disabled = false; btn.textContent = original; });
}


/* ---------------------- Step 4 view helpers ----------------------
   Filtering and sorting are presentation only. They never touch
   state.invoices, so what gets exported is unaffected by what is on screen. */

function invoiceView(){
  const q = (invView.q || '').trim().toLowerCase();
  let rows = state.invoices.filter(inv=>{
    if(!q) return true;
    return [inv.poDisplay, inv.invoiceReference, inv.supplierName, inv.customer, inv.site]
      .map(v=> String(v||'').toLowerCase())
      .some(v=> v.indexOf(q) !== -1);
  });
  const cmpText = (a,b)=> String(a).localeCompare(String(b), undefined, {numeric:true});
  switch(invView.sort){
    case 'po':         return rows.slice().sort((a,b)=> cmpText(a.poDisplay, b.poDisplay));
    case 'ref':        return rows.slice().sort((a,b)=> cmpText(a.invoiceReference, b.invoiceReference));
    case 'gross-desc': return rows.slice().sort((a,b)=> b.totalGross - a.totalGross);
    case 'gross-asc':  return rows.slice().sort((a,b)=> a.totalGross - b.totalGross);
    case 'override':   return rows.slice().sort((a,b)=> (b.targetOverridden?1:0) - (a.targetOverridden?1:0));
    default:           return rows;
  }
}

/* Makes a whole card a drop target for a spreadsheet. The dropped file is
   assigned to the existing <input type="file"> so the normal parse path runs
   unchanged — drag & drop is a second doorway, not a second pipeline. */
function wireDrop(card, input, onFile){
  if(!card || !input) return;
  let depth = 0;
  card.addEventListener('dragenter', e=>{
    e.preventDefault(); depth++; card.classList.add('dragover');
  });
  card.addEventListener('dragover', e=>{ e.preventDefault(); });
  card.addEventListener('dragleave', e=>{
    e.preventDefault();
    if(--depth <= 0){ depth = 0; card.classList.remove('dragover'); }
  });
  card.addEventListener('drop', e=>{
    e.preventDefault();
    depth = 0; card.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if(!file) return;
    try{
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    }catch(err){
      toast('This browser blocked the dropped file — use the Choose File button.', true);
      return;
    }
    onFile();
  });
}
