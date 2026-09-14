# MFC Invoice System

A browser-based invoice builder for the **AP eConnect multi-upload** workflow. It takes a purchase-order export plus a table of invoice numbers, computes the net/VAT/gross figures for every line, and produces a styled `.xlsx` in the exact layout the AP eConnect importer expects.

There is no backend and no build step. Open `index.html` and it runs. An optional Firebase layer adds a shared ledger so a team can track invoices together.

---

## Quick start

```bash
git clone https://github.com/haideralsaadi83-design/mfc-invoice-system.git
cd mfc-invoice-system
```

Open `index.html` in a browser. That's it — no install, no server, no internet required.

Invoice data never leaves the machine unless you deliberately turn on cloud sync.

---

## The workflow

| Step | What it does |
|------|--------------|
| **1. Import PO Data** | Paste or upload the AP eConnect "All Items" export. Rows that are self-billing, deleted/blocked, or have `Quantity Open <= 0` are filtered out. |
| **2. Import Invoice Numbers** | A `Site / PO# / Invoice Number` table, optionally with a target `Invoice Amount`. **Only POs listed here get built** — anything in Step 1 but not here is skipped. |
| **3. Settings & Tax** | VAT %, bank account, company code. Invoice date is always today. |
| **4. Preview Invoices** | Every invoice with its per-line arithmetic shown explicitly, so the figures can be audited before export. |
| **5. Export Excel** | Downloads the multi-upload `.xlsx`, and optionally saves the batch to the team ledger. |
| **6. Saved Sessions** | Named snapshots in `localStorage` so you can reopen a batch without re-pasting. |
| **7. Team Ledger** | Live view of every invoice the team has recorded in the cloud. Requires setup below. |

Both import steps accept a clipboard paste (tab- or comma-separated) or an `.xlsx`/`.csv` upload. Column names are matched loosely — exact match first, then substring — so minor variations between exports are tolerated.

---

## How invoices are calculated

```
Net Amount   = Quantity × Net Unit Price × Net Unit Price Per
Calculated VAT = Net Amount × (VAT% / 100)
Gross Amount = Net Amount + Calculated VAT
```

VAT starts at **0** and is entered by hand in Step 3 for each run. Changing it recalculates the whole preview immediately.

### The target-amount override

If a PO carries a target `Invoice Amount` in Step 2, that target is compared against the invoice's **Calculated VAT Amount** (Net Amount × the Step 3 VAT %):

- **Calculated VAT covers the target** → VAT % applies normally.
- **Calculated VAT falls short of the target** → that invoice's **VAT % is forced to 0**, and its **Calculated VAT Amount is forced to the exact target**, split across the line items proportionally to their net amounts. The remainder from rounding lands on the last line so the parts always sum back to the target exactly.

Because the comparison is against Net × VAT %, leaving VAT at 0 means the calculated VAT is always 0 and can never reach a target — every targeted invoice would be forced. Step 3 flags that case explicitly rather than reporting it as a quantity shortfall.

Worked example, target `394,515` at 30% VAT (break-even net is `394,515 / 0.30` = `1,315,050`):

| | Net = 500,000 (VAT below target) | Net = 2,000,000 (VAT above target) |
|---|---|---|
| Calculated VAT at 30% | 150,000 — short | 600,000 — covers |
| Overridden | **yes** | no |
| VAT % | **0** | 30 |
| VAT amount | **394,515** | 600,000 |
| Gross | 894,515 | 2,600,000 |

Overridden invoices are flagged in the preview with a badge and a warning banner listing every affected PO.

---

## Cloud sync (optional)

Without setup the app is a self-contained offline tool. Turning on sync adds a shared Firestore ledger that several people can write to at once, with live updates — invoices appear for everyone without refreshing.

### Setup (~5 minutes)

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. **Build → Firestore Database → Create database →** Production mode.
3. **Build → Authentication → Sign-in method →** enable **Google**.
4. **Project Settings → Your apps → Web (`</>`)** → register the app, then copy the `firebaseConfig` values into `firebase-config.js`.
5. **Firestore → Rules** → paste the contents of `firestore.rules`, **add your team's email addresses to the allowlist inside it**, and publish.

Reload the page, click **Sign in**, and Step 7 goes live.

### About the security model

The Firebase config in `firebase-config.js` is **not a secret** — a web config is a public identifier and is designed to ship in client code. What protects the data is `firestore.rules`, which permits reads and writes only to email addresses on the allowlist. Anyone can see the project ID in this public repo and still get nothing.

Two further guarantees are enforced server-side by those rules:

- A client cannot write someone else's name onto a record — `createdBy` must equal the signed-in user's email.
- Invoice records cannot be deleted from the app at all.

Invoices are keyed by **invoice reference**, so re-saving the same batch updates those records instead of creating duplicates.

---

## Project structure

```
index.html          markup, embedded CSS design system, all seven steps
app.js              parsing, invoice building, Excel export, persistence
cloud.js            optional Firebase layer (auth, writes, live ledger)
firebase-config.js  your Firebase project config — edit this
firestore.rules     security rules — paste into the Firebase console
test.js             dependency-free self-check (node test.js)
vendor/
  xlsx.full.min.js  SheetJS, reads uploaded workbooks
  exceljs.min.js    ExcelJS, writes the styled export
```

SheetJS and ExcelJS are vendored rather than loaded from a CDN so the tool keeps working behind restrictive corporate firewalls. Firebase is loaded from Google's CDN instead, since cloud sync needs the network regardless.

---

## Tests

```bash
node test.js
```

No framework and no dependencies. It loads the real `app.js` into a stubbed DOM and exercises the shipped functions rather than re-implementing the formulas — a test that reimplements the logic only proves the copy works.

Covers the VAT calculation, both sides of the target-amount override, and the Step 4 filter/sort, including the guarantee that filtering never changes what gets exported.

---

## Known limitations

Documented deliberately — these are current behaviours, not surprises to discover later.

- **`Net Unit Price Per` is multiplied, not divided.** In SAP terms a "per" value means *price per N units*, which would normally divide. This is currently a deliberate choice; it only matters if an export ever carries a `Per` value other than `1`, where amounts would be off by that factor.
- **Billing uses `Quantity`, not `Quantity Open`,** when an export contains both columns. Rows are *filtered* on `Quantity Open > 0` but *billed* on `Quantity`.
- **Amounts are not rounded before export.** Floating-point residue such as `39451.50000000001` can reach a cell, which an importer doing an exact-amount match may reject.
- **A duplicate PO in the Step 2 table silently overwrites** the earlier row — last one wins, with no warning.
- **`normPO` strips all non-digits,** so `51337869-A` and `51337869-B` collapse to the same PO.
- **Boolean columns are only recognised as `TRUE`.** Exports using `X`, `Y` or `1` for self-billing or deleted/blocked will not be filtered out.

---

## Browser support

Any current Chrome, Edge, Firefox or Safari. Requires `localStorage`, which private/incognito windows may block — the app detects this and says so rather than failing silently.
