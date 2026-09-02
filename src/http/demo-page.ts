/** Zero-build demo console, served at `/`. Plain HTML + fetch — a reviewer
 *  can read every line and run it against `npm run dev` with no toolchain. */
export const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ledger-ts · demo console</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background:#0b0e14; color:#d6deeb; margin:0; padding:24px; }
  h1 { font-size:18px; margin:0 0 4px; } .sub { color:#7a869a; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:20px; }
  .card { background:#11161f; border:1px solid #1e2634; border-radius:8px; padding:16px; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#7a869a; margin:0 0 12px; }
  button { background:#2b59ff; border:0; color:#fff; border-radius:6px; padding:8px 14px; font:inherit; cursor:pointer; }
  button.secondary { background:#243044; }
  button:hover { filter:brightness(1.1); }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  td,th { text-align:left; padding:4px 8px; border-bottom:1px solid #1c2430; font-size:13px; }
  th { color:#7a869a; font-weight:normal; }
  .pos { color:#7ee787; } .neg { color:#ff7b72; }
  pre { background:#0d1117; padding:10px; border-radius:6px; overflow:auto; max-height:220px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
</style>
</head>
<body>
  <h1>ledger-ts <span class="sub">double-entry ledger · the log is the truth</span></h1>
  <div class="sub">tenant: <code>demo</code> · currency: <code>USD</code> · every invariant below is enforced in the database</div>
  <div class="row">
    <button onclick="seed()">① Seed accounts + sample flow</button>
    <button class="secondary" onclick="refresh()">Refresh projections</button>
    <button class="secondary" onclick="reversal()">② Reverse last transfer</button>
  </div>
  <div class="grid">
    <div class="card"><h2>Balances (projection)</h2><table id="balances"><tr><td>press ① to seed</td></tr></table></div>
    <div class="card"><h2>Trial balance (Σ must be 0)</h2><div id="trial">—</div></div>
    <div class="card"><h2>Append-only log · wallet:user:1</h2><table id="entries"><tr><td>—</td></tr></table></div>
    <div class="card"><h2>Reconciler report</h2><pre id="recon">—</pre></div>
  </div>
<script>
const T = 'demo';
const H = { 'content-type':'application/json', 'x-tenant-id': T };
const j = (r) => r.json();
const fmt = (s) => (s/1e8).toFixed(2);
async function api(p, body) {
  const res = await fetch(p, body ? { method:'POST', headers:H, body: JSON.stringify(body) } : { headers:H });
  const out = await j(res);
  if (!res.ok) throw new Error(out.error.code + ': ' + out.error.message);
  return out;
}
async function seed() {
  const accounts = [
    ['wallet:user:1',  'User wallet',      'asset','DEBIT'],
    ['settlement:acme','Acme payable',     'liability','CREDIT'],
    ['revenue:fees',   'Fee revenue',      'revenue','CREDIT'],
    ['float:bank',     'Bank float',       'asset','DEBIT'],
  ];
  for (const [id,name,type,side] of accounts)
    await api('/v1/accounts', { account_id:id, name, account_type:type, normal_side:side, currency:'USD' });
  const now = new Date().toISOString();
  // fund the wallet: bank float → user wallet (500.00)
  await api('/v1/transfers', { idempotency_key:'seed-fund-0001', transaction_type:'TRANSFER', currency:'USD', occurred_at: now, lines:[
    { account_id:'float:bank',   amount:'-500.00' },
    { account_id:'wallet:user:1', amount:'500.00' } ]});
  // user pays 100.00, platform keeps 1.50 fee — the doc's §4 example
  await api('/v1/transfers', { idempotency_key:'seed-pay-00002', transaction_type:'TRANSFER', currency:'USD', occurred_at: now, lines:[
    { account_id:'wallet:user:1', amount:'-100.00' },
    { account_id:'settlement:acme', amount:'98.50' },
    { account_id:'revenue:fees',    amount:'1.50' } ]});
  await refresh();
}
let lastTx = null;
async function refresh() {
  const accts = (await api('/v1/accounts')).accounts;
  let rows = '';
  for (const a of accts) {
    const d = await api('/v1/accounts/' + encodeURIComponent(a.account_id));
    const cls = Number(d.balance.amount) < 0 ? 'neg' : '';
    rows += '<tr><td>' + a.account_id + '</td><td>' + a.account_type + '</td><td class="' + cls + '">' + fmt(d.balance.amount) + '</td><td>' + d.balance.seq + '</td></tr>';
  }
  document.getElementById('balances').innerHTML =
    '<tr><th>account</th><th>type</th><th>balance</th><th>seq</th></tr>' + (rows || '<tr><td>press ① to seed</td></tr>');
  const t = await api('/v1/trial-balance');
  document.getElementById('trial').innerHTML =
    '<table><tr><th>account</th><th>net</th></tr>' +
    t.rows.map(r => '<tr><td>'+r.accountId+'</td><td class="'+(Number(r.net)<0?'neg':'pos')+'">'+fmt(r.net)+'</td></tr>').join('') +
    '</table><div>Σ = <b>'+t.total+'</b> — conserved: <b>'+(t.conserved?'✅ yes':'❌ NO')+'</b></div>';
  const e = await api('/v1/accounts/wallet%3Auser%3A1/entries?limit=50');
  document.getElementById('entries').innerHTML = '<tr><th>seq</th><th>amount</th><th>tx</th></tr>' +
    e.entries.map(x => { lastTx = x.transaction_id;
      return '<tr><td>'+x.seq+'</td><td class="'+(Number(x.amount)<0?'neg':'pos')+'">'+fmt(x.amount)+'</td><td>'+x.transaction_id.slice(0,8)+'…</td></tr>'; }).join('');
  const r = await api('/v1/reconcile');
  document.getElementById('recon').textContent = JSON.stringify(r, null, 2);
}
async function reversal() {
  if (!lastTx) return alert('seed first');
  await api('/v1/transactions/'+lastTx+'/reversal', { reason:'demo reversal', idempotency_key:'rev-'+Math.random().toString(36).slice(2,10) });
  await refresh();
}
refresh().catch(()=>{});
</script>
</body>
</html>`;
