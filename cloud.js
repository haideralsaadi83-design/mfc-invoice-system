/* =========================================================================
   cloud.js — optional Firebase sync layer for shared invoice tracking.

   Design rule: the app must work exactly as before when this is switched
   off. Every entry point below no-ops safely if firebase-config.js still
   holds placeholders, or if the Firebase SDK failed to load (offline, or
   behind a firewall that blocks gstatic.com). Nothing here may throw into
   the invoice pipeline.
   ========================================================================= */

const Cloud = (function () {
  let db = null, auth = null, user = null;
  let started = false, liveUnsub = null;
  const watchers = [];

  // ---- availability ------------------------------------------------------

  function configured() {
    const c = window.FIREBASE_CONFIG;
    return !!(c && c.apiKey && !String(c.apiKey).startsWith('YOUR_'));
  }

  function sdkLoaded() {
    return typeof firebase !== 'undefined' && !!firebase.initializeApp;
  }

  function available() {
    return configured() && sdkLoaded();
  }

  // Human-readable reason cloud sync is off, for the status pill.
  function reason() {
    if (!configured()) return 'Not configured — see firebase-config.js';
    if (!sdkLoaded()) return 'Firebase SDK could not load (offline?)';
    return '';
  }

  // ---- lifecycle ---------------------------------------------------------

  function init() {
    if (started || !available()) { notify(); return; }
    try {
      firebase.initializeApp(window.FIREBASE_CONFIG);
      auth = firebase.auth();
      db = firebase.firestore();
      auth.onAuthStateChanged(function (u) {
        user = u || null;
        if (user) startLive(); else stopLive();
        notify();
      });
      started = true;
    } catch (e) {
      console.warn('[cloud] init failed:', e);
      db = auth = null;
    }
    notify();
  }

  function onChange(fn) { watchers.push(fn); }
  function notify() { watchers.forEach(function (f) { try { f(state()); } catch (e) { console.warn(e); } }); }

  function state() {
    return {
      available: available(),
      reason: reason(),
      signedIn: !!user,
      email: user ? user.email : '',
      name: user ? (user.displayName || user.email) : '',
      allowed: isAllowed(),
    };
  }

  // Client-side hint only. Real enforcement is in firestore.rules.
  function isAllowed() {
    if (!user) return false;
    const list = window.ALLOWED_EMAILS || [];
    if (!list.length) return true;
    return list.map(String).map(function (s) { return s.toLowerCase(); })
               .indexOf(String(user.email).toLowerCase()) !== -1;
  }

  // ---- auth --------------------------------------------------------------

  function signIn() {
    if (!available()) return Promise.reject(new Error(reason()));
    const provider = new firebase.auth.GoogleAuthProvider();
    return auth.signInWithPopup(provider);
  }

  function signOut() {
    if (!auth) return Promise.resolve();
    return auth.signOut();
  }

  // ---- writes ------------------------------------------------------------

  /* Saves a whole build to Firestore. Document ID is the invoice reference,
     so re-pushing the same batch UPDATES those invoices rather than creating
     duplicates — double-recording an invoice is the failure mode that
     actually matters in AP, so it is designed out here rather than guarded
     against later. */
  function push(invoices) {
    if (!available()) return Promise.reject(new Error(reason()));
    if (!user) return Promise.reject(new Error('Sign in first.'));
    if (!invoices || !invoices.length) return Promise.reject(new Error('Nothing to save.'));

    const batchId = 'batch_' + Date.now();
    const stamp = firebase.firestore.FieldValue.serverTimestamp();
    const email = user.email;

    // Firestore caps a write batch at 500 operations; chunk to stay under it.
    const ops = invoices.map(function (inv) {
      const ref = String(inv.invoiceReference || '').trim();
      if (!ref) return null;
      return {
        id: ref,
        data: {
          invoiceReference: ref,
          poNumber: String(inv.poDisplay || ''),
          site: String(inv.site || ''),
          supplierId: String(inv.supplierId || ''),
          supplierName: String(inv.supplierName || ''),
          customer: String(inv.customer || ''),
          currency: String(inv.currency || ''),
          invoiceDate: String(inv.invoiceDate || ''),
          companyCode: String(inv.companyCode || ''),
          vatPercent: Number(inv.vatPercent) || 0,
          totalNet: round2(inv.totalNet),
          totalVat: round2(inv.totalVat),
          totalGross: round2(inv.totalGross),
          targetAmount: inv.targetAmount === null || inv.targetAmount === undefined
            ? null : round2(inv.targetAmount),
          targetOverridden: !!inv.targetOverridden,
          lineItemCount: (inv.lineItems || []).length,
          lineItems: (inv.lineItems || []).map(function (li) {
            return {
              itemNo: String(li.itemNo || ''),
              description: String(li.description || ''),
              quantity: Number(li.quantity) || 0,
              netUnitPrice: Number(li.netUnitPrice) || 0,
              netAmount: round2(li.netAmount),
              vatPercent: Number(li.vatPercent) || 0,
              calcVat: round2(li.calcVat),
              gross: round2(li.gross),
            };
          }),
          batchId: batchId,
          createdBy: email,      // must match auth email or the rules reject it
          updatedAt: stamp,
        },
      };
    }).filter(Boolean);

    if (!ops.length) return Promise.reject(new Error('No invoice had a reference number.'));

    const chunks = [];
    for (let i = 0; i < ops.length; i += 400) chunks.push(ops.slice(i, i + 400));

    return chunks.reduce(function (chain, chunk) {
      return chain.then(function () {
        const wb = db.batch();
        chunk.forEach(function (op) {
          wb.set(db.collection('invoices').doc(op.id), op.data, { merge: true });
        });
        return wb.commit();
      });
    }, Promise.resolve())
      .then(function () {
        return db.collection('batches').doc(batchId).set({
          batchId: batchId,
          invoiceCount: ops.length,
          totalGross: round2(ops.reduce(function (s, o) { return s + (o.data.totalGross || 0); }, 0)),
          createdBy: email,
          createdAt: stamp,
        });
      })
      .then(function () { return { saved: ops.length, batchId: batchId }; });
  }

  // ---- live ledger -------------------------------------------------------

  /* Live subscription so several people see each other's invoices appear
     without refreshing — this is what makes it genuinely multi-user rather
     than just "stored remotely". */
  const ledgerWatchers = [];
  function onLedger(fn) { ledgerWatchers.push(fn); }

  function startLive() {
    if (!db || liveUnsub) return;
    liveUnsub = db.collection('invoices')
      .orderBy('updatedAt', 'desc')
      .limit(500)
      .onSnapshot(
        function (snap) {
          const rows = [];
          snap.forEach(function (d) { rows.push(Object.assign({ _id: d.id }, d.data())); });
          ledgerWatchers.forEach(function (f) { try { f(rows, null); } catch (e) { console.warn(e); } });
        },
        function (err) {
          console.warn('[cloud] ledger listen failed:', err);
          ledgerWatchers.forEach(function (f) { try { f([], err); } catch (e) { console.warn(e); } });
        }
      );
  }

  function stopLive() {
    if (liveUnsub) { liveUnsub(); liveUnsub = null; }
    ledgerWatchers.forEach(function (f) { try { f([], null); } catch (e) { console.warn(e); } });
  }

  function round2(n) {
    const v = Number(n);
    return isNaN(v) ? 0 : Math.round(v * 100) / 100;
  }

  return {
    available: available, reason: reason, init: init, state: state,
    onChange: onChange, onLedger: onLedger,
    signIn: signIn, signOut: signOut, push: push,
  };
})();
