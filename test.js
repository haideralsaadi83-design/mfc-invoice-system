/* =========================================================================
   Self-check for the money logic and the Step 4 view.

   Run with:  node test.js

   No framework, no dependencies. It loads the real app.js into a stubbed
   DOM and exercises the shipped functions — deliberately NOT a
   re-implementation of the formulas, because a test that reimplements the
   logic only proves the copy works.
   ========================================================================= */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

const el = () => ({
  value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  appendChild() {},
});
const els = {};
const sandbox = {
  document: {
    addEventListener() {},
    createElement: el,
    getElementById: (id) => (els[id] ||= el()),
    querySelector: el,
    querySelectorAll: () => [],
    body: { appendChild() {}, removeChild() {} },
  },
  console,
  window: {},
  localStorage: { setItem() {}, getItem() { return null; }, removeItem() {} },
  setTimeout, clearTimeout, Date, Math, JSON, Set, Object, String, Number,
  isNaN, parseFloat, parseInt,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// `let state` / `let invView` live in the declarative record, not on the
// sandbox object, so reach them through a bridge appended to the source.
vm.runInContext(src + `
;globalThis.__t = {
  state: () => state,
  setView: (v) => { invView = v; },
  buildInvoices: (o) => buildInvoices(o),
  invoiceView: () => invoiceView(),
};`, sandbox);
const t = sandbox.__t;

let failed = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        got  ${JSON.stringify(got)}`);
    console.log(`        want ${JSON.stringify(want)}`);
    failed++;
  }
}

/* ---------------- 1. Invoice maths and the target override -------------- */

console.log('\nInvoice calculation');

els.vatPercent = el(); els.vatPercent.value = '30';
els.bankAccount = el(); els.bankAccount.value = '005673917711';
els.companyCode = el(); els.companyCode.value = 'FIIX';

const TARGET = 394515;
function build(netTotal) {
  t.state().dumpRows = [{
    poRaw: '51337869', poNorm: '51337869', itemNo: '10', description: 'Test line',
    unit: 'PCE', quantityOpen: 1, quantity: 1, netUnitPrice: netTotal,
    netUnitPricePer: 1, currency: 'IQD', supplierId: 'S1', supplierName: 'Supplier',
    customer: 'Cust', customerVat: '', paymentTerms: 'NT30', targetSystem: 'SAP',
    buyerMaterialCode: '',
  }];
  t.state().invoiceMap = {
    '51337869': { site: '448', invoiceNumber: 'INV-0269', invoiceAmount: TARGET },
  };
  t.state().invoices = [];
  t.buildInvoices({ silent: true });
  return t.state().invoices[0];
}

// Net BELOW target -> override: VAT 0%, VAT amount pinned to the target.
const below = build(300000);
check('net below target overrides', below.targetOverridden, true);
check('overridden invoice reports 0%', below.vatPercent, 0);
check('overridden VAT equals the target', Math.round(below.totalVat), TARGET);
check('overridden line also reports 0%', below.lineItems[0].vatPercent, 0);

// Net ABOVE target -> normal VAT.
const above = build(500000);
check('net above target does not override', above.targetOverridden, false);
check('normal invoice keeps 30%', above.vatPercent, 30);
check('normal VAT is 30% of net', Math.round(above.totalVat), 150000);
check('gross is net plus VAT', Math.round(above.totalGross), 650000);

/* ---------------- 2. Step 4 filtering and sorting ----------------------- */

console.log('\nStep 4 view (filter / sort)');

const inv = (po, ref, supplier, gross, overridden) => ({
  poDisplay: po, invoiceReference: ref, supplierName: supplier, customer: 'Cust',
  site: '448', totalGross: gross, totalNet: gross, totalVat: 0,
  targetOverridden: overridden, lineItems: [{}],
});
t.state().invoices = [
  inv('51337869', 'INV-0269', 'Alpha Trading', 650000, false),
  inv('51337870', 'INV-0270', 'Beta Supplies', 120000, true),
  inv('51337871', 'INV-0271', 'Gamma Logistics', 990000, false),
];
const refs = () => t.invoiceView().map((r) => r.invoiceReference);

t.setView({ q: '', sort: 'default' });
check('no filter returns all', refs(), ['INV-0269', 'INV-0270', 'INV-0271']);

t.setView({ q: 'beta', sort: 'default' });
check('filters by supplier, case-insensitive', refs(), ['INV-0270']);

t.setView({ q: '51337871', sort: 'default' });
check('filters by PO number', refs(), ['INV-0271']);

t.setView({ q: 'no-such-thing', sort: 'default' });
check('no match returns empty', refs(), []);

t.setView({ q: '', sort: 'gross-desc' });
check('sorts gross high to low', refs(), ['INV-0271', 'INV-0269', 'INV-0270']);

t.setView({ q: '', sort: 'override' });
check('puts overridden first', refs()[0], 'INV-0270');

// The guarantee that matters: the view must never change what gets exported.
t.setView({ q: 'beta', sort: 'gross-desc' });
t.invoiceView();
t.setView({ q: '', sort: 'default' });
check('filtering never mutates the batch', refs(), ['INV-0269', 'INV-0270', 'INV-0271']);

console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nAll checks passed.\n');
process.exitCode = failed ? 1 : 0;
