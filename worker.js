/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  /* WIRED: Xero (14 Oct 2026). Read-only, P&L report only. */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: 'offline_access accounting.reports.profitandloss.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'
    },
    async status(env, h) {
      const tokens = await h.getTokens();
      if (!tokens || !tokens.access_token) return { connected: false };
      const t = await xeroTenant(env, h);
      return { connected: true, org: t.name, sandbox: /demo company/i.test(t.name || '') };
    },
    async fetchRange(env, h, q) {
      const t = await xeroTenant(env, h);
      /* Before LABOUR_CUTOVER labour comes from Xero (pre rule); a range that
         crosses it is read as two segments and added together. */
      const tot = { revenue: 0, cogs: 0, rent: 0, labourPre: 0, labourInterim: 0, overheads: 0 };
      for (const sg of splitAtCutover(q.from, q.to)) {
        const rep = await xeroPnl(h, t.id, { fromDate: sg.from, toDate: sg.to });
        const f = segFigures(parseXeroPnl(rep, 1)[0], sg.pre);
        for (const k of Object.keys(tot)) tot[k] += f[k];
      }
      const c = { revenue: tot.revenue / 100, cogs: tot.cogs / 100, wagesSuper: tot.labourInterim / 100, labourXeroPre: tot.labourPre / 100 };
      let overheads = (tot.overheads - tot.rent + rentShareCents(daysInclusive(q.from, q.to))) / 100;
      /* OWNER DECISION 14 Oct 2026: most overhead bills land in the last week of the
         month, so for ranges shorter than a whole month, overheads = average daily
         overheads of the previous 3 full months x days in the range. Whole months
         and longer use the actual books (with rent spread evenly). */
      if (!isWholeMonths(q.from, q.to)) {
        const avg = await xeroAvgDailyOverheads(h, t.id, q.from);
        if (avg != null) overheads = Math.round(avg * daysInclusive(q.from, q.to) * 100) / 100;
      }
      return { revenue: c.revenue, cogs: c.cogs, wagesSuper: c.wagesSuper, labourXeroPre: c.labourXeroPre, overheads: overheads };
    },
    async fetchMonthly(env, h, q) {
      const t = await xeroTenant(env, h);
      const months = monthList(q.fromMonth, q.toMonth);
      const out = { months: months, revenue: [], cogs: [], wagesSuper: [], labourXeroPre: [], overheads: [] };
      const byMonth = {};
      /* Xero caps comparative periods at 12 per call: walk back from the newest
         month in chunks of up to 12 months. Columns come newest first. */
      let end = months.length - 1;
      while (end >= 0) {
        const n = Math.min(12, end + 1);
        const endMonth = months[end];
        const [y, m] = endMonth.split('-').map(Number);
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const params = { fromDate: endMonth + '-01', toDate: endMonth + '-' + String(last).padStart(2, '0') };
        if (n > 1) { params.periods = String(n - 1); params.timeframe = 'MONTH'; }
        const rep = await xeroPnl(h, t.id, params);
        const cols = parseXeroPnl(rep, n);
        for (let i = 0; i < n; i++) {
          const mo = months[end - i];
          const [yy, mm] = mo.split('-').map(Number);
          const dim = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
          const first = mo + '-01', lastD = mo + '-' + String(dim).padStart(2, '0');
          let f;
          if (lastD < LABOUR_CUTOVER) f = segFigures(cols[i], true);
          else if (first >= LABOUR_CUTOVER) f = segFigures(cols[i], false);
          else {
            /* the cutover month: read the two parts separately */
            f = { revenue: 0, cogs: 0, rent: 0, labourPre: 0, labourInterim: 0, overheads: 0 };
            for (const sg of splitAtCutover(first, lastD)) {
              const r2 = await xeroPnl(h, t.id, { fromDate: sg.from, toDate: sg.to });
              const g = segFigures(parseXeroPnl(r2, 1)[0], sg.pre);
              for (const k of Object.keys(f)) f[k] += g[k];
            }
          }
          byMonth[mo] = {
            revenue: f.revenue / 100, cogs: f.cogs / 100, wagesSuper: f.labourInterim / 100, labourXeroPre: f.labourPre / 100,
            overheads: (f.overheads - f.rent + rentShareCents(dim)) / 100
          };
        }
        end -= n;
      }
      months.forEach((mo) => {
        const c = byMonth[mo];
        out.revenue.push(c ? c.revenue : null);
        out.cogs.push(c ? c.cogs : null);
        out.wagesSuper.push(c ? c.wagesSuper : null);
        out.labourXeroPre.push(c ? c.labourXeroPre : null);
        out.overheads.push(c ? c.overheads : null);
      });
      return out;
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  /* WIRED: Square (14 Oct 2026). Read-only; counts completed, paid orders only
     (no dollar figures). Square has no aggregate count endpoint, so daily counts
     are cached in KV month blobs and back-filled by the cron (wrangler.toml). */
  pos: {
    configured: true,
    auth: 'token',
    oauth: {},
    async status(env, h) {
      if (!env.POS_API_TOKEN) return { connected: false };
      const locs = await sqLocations(env);
      const biz = locs[0] && (locs[0].business_name || locs[0].name);
      const names = locs.map((l) => l.name).join(', ');
      return { connected: true, org: biz + (names && names !== biz ? ' · ' + names : ''), sandbox: false };
    },
    async fetchRange(env, h, q) {
      await sqSaveCfg(env, q.tz, q.rollover);
      const r = await sqCountRange(env, q.from, q.to, q.tz, q.rollover);
      return r == null ? null : { count: r.count, sales: r.sales };
    },
    async fetchMonthly(env, h, q) {
      const months = monthList(q.fromMonth, q.toMonth);
      const out = { months: months, count: [], sales: [] };
      for (const mo of months) {
        const r = await sqCountMonth(env, mo, q.tz, q.rollover);
        out.count.push(r ? r.count : null);
        out.sales.push(r ? r.sales : null);
      }
      return out;
    },
    async scheduledPull(env, h) { await sqBackfill(env); }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  /* WIRED: Connecteam (14 Oct 2026). Read-only: timesheet totals (totalPay per
     pay item - owner set pay rates to include super). OWNER DECISION: this is the
     MAIN labour figure (hours actually worked), not a projection - see apiMetrics. */
  rostering: {
    configured: true,
    auth: 'token',
    oauth: {},
    async status(env, h) {
      if (!env.ROSTERING_API_TOKEN) return { connected: false };
      const clocks = await ctClocks(env);
      const live = clocks.filter((c) => !c.isArchived).map((c) => c.name);
      return { connected: true, org: 'Time clocks: ' + (live.join(', ') || '(none)'), sandbox: false };
    },
    async fetchRange(env, h, q) {
      if (q.to < LABOUR_CUTOVER) return { cost: 0, kitchen: 0, foh: 0 };
      const from = q.from < LABOUR_CUTOVER ? LABOUR_CUTOVER : q.from;
      const r = await ctCostRange(env, from, q.to, { calls: 4 });
      return r == null ? null : { cost: r.cost, kitchen: r.kitchen, foh: r.foh };
    },
    async fetchMonthly(env, h, q) {
      const months = monthList(q.fromMonth, q.toMonth);
      const out = { months: months, cost: [] };
      for (const mo of months) { const v = await ctMonthCached(env, mo); out.cost.push(v ? v.cost : null); }
      return out;
    },
    async scheduledPull(env, h) { await ctBackfill(env); }
  }
};

/* ----------------------------------------------------------------------------
   Xero helpers (accounting adapter)
---------------------------------------------------------------------------- */

/* Which Operating Expenses lines count as wages + super.
   Keyword match PROPOSES; the owner CONFIRMS at reconciliation. If the owner's
   confirmed list differs, put the exact account names in WAGE_ACCOUNTS (it then
   replaces the keyword match entirely). Account names only - nothing secret. */
const WAGE_ACCOUNTS = [];
const WAGE_KEYWORDS = /wage|salar|superannuation|\bsuper\b|payroll|annual leave|long service|workcover|workers comp/i;

/* OWNER'S VIEW (owner decision, 14 Oct 2026 - deviates from kit kpi-spec and is
   labelled as such on the dashboard; the kit-definition "books view" stays on
   /check/xero for reconciliation):
     - Floor + kitchen labour = FLOOR_WAGES + the part of SUPER not belonging to
       Operational Wages. Once Connecteam is connected, labour comes from
       Connecteam timesheets instead (super already included there) and these
       Xero lines are not used for labour at all.
     - Overheads = Operating Expenses - all wage/super lines
                   + Operational Wages x (1 + OPS_SUPER_RATE)
     - Profit still ties to the Xero P&L (labour + overheads = opex). */
const OWNER_VIEW = {
  floorWages: ['Wages and Salaries'],
  superLine: 'Superannuation',
  opsWages: 'Operational Wages',
  opsSuperRate: 0.12,
  /* Rent spread evenly (owner, 14 Oct 2026): the actual rent bill is removed from
     overheads and replaced by an even daily share of monthly x 12 / 364
     (= monthly x 12 / 52 per week), so the monthly bill never spikes one week. */
  rentLine: /\brent\b/i,
  rentMonthly: 6258.75
};
/* Connecteam replaced Deputy on 21 Sep 2026; before that, labour comes from Xero. */
const LABOUR_CUTOVER = '2026-09-21';
/* Split a date range at the cutover: [{from, to, pre}] */
function splitAtCutover(from, to) {
  if (to < LABOUR_CUTOVER) return [{ from, to, pre: true }];
  if (from >= LABOUR_CUTOVER) return [{ from, to, pre: false }];
  return [{ from, to: addDay(LABOUR_CUTOVER, -1), pre: true }, { from: LABOUR_CUTOVER, to, pre: false }];
}
/* Owner's-view figures for one parsed P&L column covering a whole segment. */
function segFigures(c, pre) {
  const cents = (x) => Math.round(x * 100);
  return {
    revenue: cents(c.revenue), cogs: cents(c.cogs), rent: c.rentCents,
    labourPre: pre ? c.pre.labourCents : 0,
    labourInterim: pre ? c.pre.labourCents : cents(c.wagesSuper),
    overheads: pre ? c.pre.overheadsCents : cents(c.overheads)
  };
}
function rentShareCents(days) { return Math.round(OWNER_VIEW.rentMonthly * 12 / 364 * days * 100); }
function isWholeMonths(from, to) {
  if (from.slice(8) !== '01') return false;
  const d = new Date(to + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
  return d.getUTCDate() === 1;
}
/* Average daily overheads (owner's view, rent spread evenly) over the 3 full
   calendar months before the month containing `from`. One Xero call. */
async function xeroAvgDailyOverheads(h, tenantId, from) {
  const f = new Date(from.slice(0, 7) + '-01T12:00:00Z');
  const last = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 0));      /* end of previous month */
  const lastMo = last.toISOString().slice(0, 7);
  const rep = await xeroPnl(h, tenantId, { fromDate: lastMo + '-01', toDate: last.toISOString().slice(0, 10), periods: '2', timeframe: 'MONTH' });
  const cols = parseXeroPnl(rep, 3);
  let cents = 0, days = 0;
  for (let i = 0; i < 3; i++) {
    const m = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - i + 1, 0));
    const dim = m.getUTCDate();
    cents += Math.round(cols[i].overheads * 100) - cols[i].rentCents + rentShareCents(dim);
    days += dim;
  }
  return days ? cents / 100 / days : null;
}
function daysInclusive(from, to) { return Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000) + 1; }

function isWageLine(label) {
  const l = String(label || '').trim().toLowerCase();
  if (WAGE_ACCOUNTS.length) return WAGE_ACCOUNTS.some((a) => a.trim().toLowerCase() === l);
  return WAGE_KEYWORDS.test(l);
}

/* Classify a P&L section by its title. Order matters ("Less Cost of Sales"
   contains "sales"). Other Income is never revenue. */
function xeroSectionKind(title) {
  const t = String(title || '').toLowerCase();
  if (!t) return 'other';
  if (/other income/.test(t)) return 'otherIncome';
  if (/cost of sales|cost of goods|direct cost/.test(t)) return 'cogs';
  if (/operating expense/.test(t)) return 'opex';
  if (/expense/.test(t) && !/other/.test(t)) return 'opex';
  if (/income|revenue|sales/.test(t)) return 'revenue';
  return 'other';
}

function xeroAmount(v) {
  if (v == null || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? Math.round(n * 100) : 0;   /* cents, to avoid float drift */
}

/* Parse a (multi-period) P&L into per-column figures in dollars.
   Column 0 = the requested period (or newest month), then older months. */
function parseXeroPnl(report, nCols) {
  const rep = report && report.Reports && report.Reports[0];
  if (!rep || !Array.isArray(rep.Rows)) throw Object.assign(new Error('bad P&L'), { status: 500 });
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const cols = [];
  for (let i = 0; i < nCols; i++) cols.push({ revenue: 0, cogs: 0, opex: 0, wages: 0, floor: 0, sup: 0, ops: 0, rent: 0 });
  for (const sec of rep.Rows) {
    if (sec.RowType !== 'Section' || !Array.isArray(sec.Rows)) continue;
    const kind = xeroSectionKind(sec.Title);
    if (kind === 'other' || kind === 'otherIncome') continue;
    const summary = sec.Rows.find((r) => r.RowType === 'SummaryRow');
    const lines = sec.Rows.filter((r) => r.RowType === 'Row');
    for (let i = 0; i < nCols; i++) {
      let total;
      if (summary && summary.Cells && summary.Cells[i + 1]) total = xeroAmount(summary.Cells[i + 1].Value);
      else total = lines.reduce((s, r) => s + xeroAmount(r.Cells && r.Cells[i + 1] && r.Cells[i + 1].Value), 0);
      cols[i][kind] += total;
      if (kind === 'opex') {
        for (const r of lines) {
          const label = r.Cells && r.Cells[0] && r.Cells[0].Value;
          const amt = xeroAmount(r.Cells[i + 1] && r.Cells[i + 1].Value);
          if (isWageLine(label)) cols[i].wages += amt;
          if (OWNER_VIEW.floorWages.some((n) => same(n, label))) cols[i].floor += amt;
          if (same(OWNER_VIEW.superLine, label)) cols[i].sup += amt;
          if (same(OWNER_VIEW.opsWages, label)) cols[i].ops += amt;
          if (OWNER_VIEW.rentLine.test(String(label || ''))) cols[i].rent += amt;
        }
      }
    }
  }
  return cols.map((c) => {
    /* owner's view (cents): operational super estimated at the agreed rate */
    const opsSuper = Math.round(c.ops * OWNER_VIEW.opsSuperRate);
    const labour = c.floor + c.sup - opsSuper;
    const overheads = c.opex - c.floor - c.sup - c.ops + c.ops + opsSuper;
    return {
      revenue: c.revenue / 100,
      cogs: c.cogs / 100,
      wagesSuper: labour / 100,
      overheads: overheads / 100,
      books: { wagesSuper: c.wages / 100, overheads: (c.opex - c.wages) / 100 },
      rentCents: c.rent,
      /* pre-cutover rule (before Connecteam): labour = floor wages + ALL super;
         Operational Wages stays in overheads with no extra 12% */
      pre: { labourCents: c.floor + c.sup, overheadsCents: c.opex - c.floor - c.sup },
      lines: { floor: c.floor / 100, super: c.sup / 100, ops: c.ops / 100, opsSuper: opsSuper / 100, opex: c.opex / 100, rent: c.rent / 100 }
    };
  });
}

async function xeroPnl(h, tenantId, params) {
  /* standardLayout: read the standard sections, not a custom layout; accrual
     basis (Xero's default P&L). Amounts on the P&L are always ex-GST. */
  const p = new URLSearchParams({ standardLayout: 'true', paymentsOnly: 'false', ...params });
  return h.fetchJson('https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?' + p.toString(), {
    headers: { 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' }
  });
}

/* The connected organisation. Cached in KV per authorisation; refreshed after
   every new Allow (tokens.obtained_at changes). */
async function xeroTenant(env, h) {
  const tokens = await h.getTokens();
  const cachedRaw = await env.TOKENS.get('xero:tenant');
  if (cachedRaw) {
    try {
      const c = JSON.parse(cachedRaw);
      if (c && c.id && tokens && c.forAuth === tokens.obtained_at) return c;
    } catch (e) {}
  }
  const list = await h.fetchJson('https://api.xero.com/connections', { headers: { 'Accept': 'application/json' } });
  const orgs = (Array.isArray(list) ? list : []).filter((c) => (c.tenantType || 'ORGANISATION') === 'ORGANISATION');
  if (!orgs.length) throw Object.assign(new Error('no organisation'), { status: 403 });
  const real = orgs.filter((c) => !/demo company/i.test(c.tenantName || ''));
  const pick = (real.length ? real : orgs).sort((a, b) => String(b.updatedDateUtc || '').localeCompare(String(a.updatedDateUtc || '')))[0];
  const t = { id: pick.tenantId, name: pick.tenantName, all: orgs.map((o) => o.tenantName), forAuth: tokens && tokens.obtained_at };
  await env.TOKENS.put('xero:tenant', JSON.stringify(t));
  return t;
}

/* A plain read-only page listing the P&L lines and how each was counted, so the
   owner can confirm the wages/super list at reconciliation. Session-protected. */
async function xeroCheckPage(env, url) {
  const h = makeHelpers(env, 'accounting');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    from = first.toISOString().slice(0, 10); to = last.toISOString().slice(0, 10);
  }
  let body;
  try {
    const t = await xeroTenant(env, h);
    const rep = await xeroPnl(h, t.id, { fromDate: from, toDate: to });
    const c = parseXeroPnl(rep, 1)[0];
    const rentShare = rentShareCents(daysInclusive(from, to)) / 100;
    c.overheads = (Math.round(c.overheads * 100) - c.rentCents) / 100 + rentShare;
    const money = (n) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const names = { revenue: 'Revenue', cogs: 'Cost of goods', opex: 'Operating expenses', otherIncome: 'Not counted (other income)', other: 'Not counted' };
    let rows = '';
    for (const sec of rep.Reports[0].Rows) {
      if (sec.RowType !== 'Section' || !Array.isArray(sec.Rows) || !sec.Title) continue;
      const kind = xeroSectionKind(sec.Title);
      rows += '<tr class="sec"><td colspan="3">' + esc(sec.Title) + ' <span>· ' + esc(names[kind]) + '</span></td></tr>';
      for (const r of sec.Rows) {
        if (r.RowType !== 'Row') continue;
        const label = r.Cells[0] && r.Cells[0].Value;
        const amt = xeroAmount(r.Cells[1] && r.Cells[1].Value) / 100;
        const is = (n) => String(label || '').trim().toLowerCase() === String(n).trim().toLowerCase();
        let tag = '';
        if (kind === 'opex') {
          if (OWNER_VIEW.floorWages.some(is)) tag = '<b class="w">Floor &amp; kitchen wages</b>';
          else if (is(OWNER_VIEW.superLine)) tag = '<b class="w">Super: floor share to wages, ' + Math.round(OWNER_VIEW.opsSuperRate * 100) + '% of Operational Wages to overheads</b>';
          else if (is(OWNER_VIEW.opsWages)) tag = 'Overheads (+' + Math.round(OWNER_VIEW.opsSuperRate * 100) + '% super)';
          else if (OWNER_VIEW.rentLine.test(String(label || ''))) tag = '<b class="w">Rent: replaced by an even daily share</b>';
          else if (isWageLine(label)) tag = '<b class="q">Looks like wages - not set up yet, counted in overheads</b>';
          else tag = 'Overheads';
        } else if (kind === 'cogs' && WAGE_KEYWORDS.test(label || '')) tag = '<b class="q">Looks like wages - check</b>';
        rows += '<tr><td>' + esc(label) + '</td><td class="n">' + money(amt) + '</td><td>' + tag + '</td></tr>';
      }
    }
    const L = c.lines;
    body = '<h1>How your Xero lines are counted</h1><p>' + esc(t.name) + ' · ' + esc(from) + ' to ' + esc(to) + ' · ex-GST · accrual</p>'
      + '<h2>Your view (what the dashboard shows)</h2>'
      + '<div class="sum"><div>Revenue<b>' + money(c.revenue) + '</b></div><div>Cost of goods<b>' + money(c.cogs) + '</b></div>'
      + '<div>Floor &amp; kitchen wages + super<b>' + money(c.wagesSuper) + '</b></div><div>Overheads<b>' + money(c.overheads) + '</b></div>'
      + '<div>Profit<b>' + money(c.revenue - c.cogs - c.wagesSuper - c.overheads) + '</b></div></div>'
      + '<p class="m">Wages = Wages and Salaries ' + money(L.floor) + ' + Superannuation ' + money(L.super) + ' − super on Operational Wages ' + money(L.opsSuper)
      + '. Overheads = operating expenses ' + money(L.opex) + ' − Wages and Salaries − Superannuation + super on Operational Wages − rent billed ' + money(L.rent) + ' + rent spread evenly ' + money(rentShare) + ' (' + daysInclusive(from, to) + ' days × $' + (OWNER_VIEW.rentMonthly * 12 / 364).toFixed(2) + '). Once Connecteam is connected, the wages figure comes from Connecteam timesheets instead.</p>'
      + '<h2>Books view (your Xero P&amp;L as-is)</h2>'
      + '<div class="sum"><div>All wage &amp; super lines<b>' + money(c.books.wagesSuper) + '</b></div><div>Operating expenses less those<b>' + money(c.books.overheads) + '</b></div></div>'
      + '<table>' + rows + '</table>';
  } catch (e) {
    body = '<h1>Not connected yet</h1><p>Connect Xero on the dashboard’s Connections screen first.</p>';
  }
  return htmlResponse('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Xero lines</title>'
    + '<style>body{margin:0;padding:1.5rem;background:#FDF7EE;font-family:system-ui,sans-serif;color:#2A2420}h1{font-size:22px;margin:0 0 .3rem}p{color:#8C8075;font-size:14px}'
    + '.sum{display:flex;gap:10px;flex-wrap:wrap;margin:1rem 0}.sum div{background:#fffdf9;border:1px solid rgba(13,13,13,.08);border-radius:10px;padding:.6rem .9rem;font-size:12px;color:#8C8075}.sum b{display:block;font-size:18px;color:#0D0D0D}'
    + 'table{border-collapse:collapse;width:100%;max-width:760px;font-size:14px}td{padding:6px 8px;border-bottom:1px solid rgba(13,13,13,.06)}td.n{text-align:right;white-space:nowrap}'
    + 'h2{font-size:16px;margin:1.4rem 0 .2rem}.m{font-size:13px;max-width:760px;line-height:1.6}tr.sec td{font-weight:600;padding-top:14px}tr.sec span{font-weight:400;color:#8C8075}.w{color:#1A5FB4}.q{color:#C04B28}</style></head><body>' + body + '</body></html>');
}

/* ----------------------------------------------------------------------------
   Square helpers (POS adapter) - transaction COUNT only, never dollars
---------------------------------------------------------------------------- */
const SQ_API = 'https://connect.squareup.com/v2';      /* production host only */
const SQ_VERSION = '2026-09-16';
const SQ_HISTORY_MONTHS = 26;      /* how far back the cron back-fills */
const SQ_LOCATION_IDS = [];        /* empty = all active locations (owner-confirmed) */
const SQ_PAGES_PER_RUN = 36;       /* calls per catch-up pass; + Connecteam's 10 stays under the free plan's 50 */

async function sqFetch(env, path, body) {
  const res = await fetch(SQ_API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Authorization': 'Bearer ' + env.POS_API_TOKEN, 'Square-Version': SQ_VERSION, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) { const e = new Error('Square HTTP ' + res.status); e.status = res.status; throw e; }
  return res.json();
}

async function sqLocations(env) {
  const raw = await env.TOKENS.get('sq:locs');
  if (raw) {
    try { const c = JSON.parse(raw); if (c.at > Date.now() - 86400000 && c.locs.length) return c.locs; } catch (e) {}
  }
  const j = await sqFetch(env, '/locations');
  const locs = (j.locations || []).filter((l) => l.status === 'ACTIVE')
    .map((l) => ({ id: l.id, name: l.name, business_name: l.business_name }));
  if (!locs.length) throw Object.assign(new Error('no locations'), { status: 403 });
  await env.TOKENS.put('sq:locs', JSON.stringify({ at: Date.now(), locs: locs }));
  return locs;
}

/* OWNER DECISION 14 Oct 2026 (deviates from kit: revenue from the POS, labelled).
   Everything is built from Square PAYMENTS - the same thing the Square app's
   Sales Report counts:
   - transactions = completed payments ("Sales" in the Square app); failed and
     cancelled payments excluded; refunds never reduce the count.
   - sales = the order's amounts after discounts, minus GST, minus tips, minus
     GIFT CARD SALES (Square treats a gift card as money held, not a sale - it
     sits under "Deferred sales", outside Net Sales); a split order is shared
     across its payments in proportion to each payment, so it is never counted
     twice. Then REFUNDS are subtracted on the day the refund was made (ex-GST),
     exactly like the "Returns" line in the Square app. Together this equals the
     Square app's "Net Sales". (Fixed 16 Oct 2026: Sep 2026 was $264.72 high =
     $165 gift card sales + $99.82 returns.)
   - fees = Square processing fees on the payments, ex-GST (fee / 1.1), deducted
     from revenue because Square deposits takings net of fees (fees never hit Xero). */
const SQ_FEE_GST_DIVISOR = 1.1;
function sqMoney(m) { return (m && typeof m.amount === 'number') ? m.amount : 0; }
/* Gift card loads/sales on an order (no GST on gift cards). */
function sqOrderGiftCards(o) {
  return (Array.isArray(o.line_items) ? o.line_items : [])
    .filter((li) => li.item_type === 'GIFT_CARD')
    .reduce((s, li) => s + sqMoney(li.total_money), 0);
}
/* The sale as rung up (before any later refund - refunds are counted on their
   own day), ex-GST, ex-tips. Returns [salesExGiftCards, giftCards]. */
function sqOrderSaleExGst(o) {
  const gross = sqMoney(o.total_money) - sqMoney(o.total_tax_money) - sqMoney(o.total_tip_money);
  const gc = sqOrderGiftCards(o);
  return [gross - gc, gc];
}
/* A refund's value ex-GST: from its return order when there is one (itemised
   return), else refund amount / 1.1. Gift card refunds are never revenue. */
function sqRefundExGst(r, ro) {
  if (ro && ro.return_amounts && ro.return_amounts.total_money) {
    const ra = ro.return_amounts;
    let gc = 0;
    for (const ret of (Array.isArray(ro.returns) ? ro.returns : [])) {
      for (const li of (Array.isArray(ret.return_line_items) ? ret.return_line_items : [])) {
        if (li.item_type === 'GIFT_CARD') gc += sqMoney(li.total_money);
      }
    }
    return sqMoney(ra.total_money) - sqMoney(ra.tax_money) - sqMoney(ra.tip_money) - gc;
  }
  return Math.round(sqMoney(r.amount_money) / SQ_FEE_GST_DIVISOR);
}
function sqPaymentFee(p) {
  const f = (Array.isArray(p.processing_fee) ? p.processing_fee : []).reduce((s, x) => s + sqMoney(x.amount_money), 0);
  return Math.round(f / SQ_FEE_GST_DIVISOR);
}

/* --- trading-day maths in the venue's timezone, with rollover --- */
function sqTzKey(tz) {
  /* these zones share identical rules; one cache serves them all */
  return /^Australia\/(Sydney|Melbourne|Hobart|Canberra|ACT|NSW|Victoria)$/.test(tz || '') ? 'Australia/Melbourne' : (tz || 'Australia/Melbourne');
}
function tzParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const p = {};
  f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  if (p.hour === '24') p.hour = '00';
  return p;
}
function tzOffsetMs(ms, tz) {
  const p = tzParts(ms, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function localToUtcMs(dateStr, hour, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  let ms = guess - tzOffsetMs(guess, tz);
  ms = guess - tzOffsetMs(ms, tz);
  return ms;
}
function tradingDay(ms, tz, roll) {
  const p = tzParts(ms - roll * 3600000, tz);
  return p.year + '-' + p.month + '-' + p.day;
}
function addDay(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* Totals for trading days d1..d2 (inclusive) straight from Square payments.
   Each payments page (100) costs one call plus one call to fetch its orders.
   order 'ASC': if the call budget runs out, days BEFORE lastDay are complete;
   order 'DESC': days AFTER lastDay are complete.
   byDay[d] = [count, net sales c (after refunds), fee c, gift card sales c, refunds c].
   Refunds are read FIRST for the whole window (usually one or two calls), so
   any partially-finished window still has its refunds complete. */
async function sqCountDays(env, d1, d2, tz, roll, budget, order) {
  const byDay = {};
  for (let d = d1; d <= d2; d = addDay(d, 1)) byDay[d] = [0, 0, 0, 0, 0];
  const startIso = new Date(localToUtcMs(d1, roll, tz)).toISOString();
  const endIso = new Date(localToUtcMs(addDay(d2, 1), roll, tz)).toISOString();
  const orders = {};
  let cursor = null, pages = 0, lastDay = null;

  /* 1) refunds made in the window, booked on the day of the refund */
  do {
    if (pages + 2 > budget) return { byDay, complete: false, lastDay: null, pages };
    const q = new URLSearchParams({ begin_time: startIso, end_time: endIso, sort_order: 'ASC', limit: '100' });
    if (SQ_LOCATION_IDS.length === 1) q.set('location_id', SQ_LOCATION_IDS[0]);
    if (cursor) q.set('cursor', cursor);
    const j = await sqFetch(env, '/refunds?' + q.toString());
    pages++;
    const refs = (j.refunds || []).filter((r) => r.status === 'COMPLETED' && r.created_at
      && (SQ_LOCATION_IDS.length <= 1 || SQ_LOCATION_IDS.includes(r.location_id)));
    const need = Array.from(new Set(refs.filter((r) => r.order_id && !orders[r.order_id]).map((r) => r.order_id)));
    if (need.length) {
      const oj = await sqFetch(env, '/orders/batch-retrieve', { order_ids: need });
      pages++;
      for (const o of (oj.orders || [])) orders[o.id] = o;
    }
    for (const r of refs) {
      const day = tradingDay(Date.parse(r.created_at), tz, roll);
      if (!(day in byDay)) continue;
      const b = byDay[day];
      const v = sqRefundExGst(r, r.order_id && orders[r.order_id]);
      b[1] -= v;
      b[4] += v;
      /* any processing fee Square hands back on a refund comes through negative */
      b[2] += Math.round((Array.isArray(r.processing_fee) ? r.processing_fee : []).reduce((s, x) => s + sqMoney(x.amount_money), 0) / SQ_FEE_GST_DIVISOR);
    }
    cursor = j.cursor || null;
  } while (cursor);

  /* 2) completed payments: count, sales, fees */
  do {
    if (pages + 2 > budget) return { byDay, complete: false, lastDay, pages };
    const q = new URLSearchParams({ begin_time: startIso, end_time: endIso, sort_order: order || 'ASC', limit: '100' });
    if (SQ_LOCATION_IDS.length === 1) q.set('location_id', SQ_LOCATION_IDS[0]);
    if (cursor) q.set('cursor', cursor);
    const j = await sqFetch(env, '/payments?' + q.toString());
    pages++;
    const pays = j.payments || [];
    const need = Array.from(new Set(pays.filter((p) => p.status === 'COMPLETED' && p.order_id && !orders[p.order_id]).map((p) => p.order_id)));
    if (need.length) {
      const oj = await sqFetch(env, '/orders/batch-retrieve', { order_ids: need });
      pages++;
      for (const o of (oj.orders || [])) orders[o.id] = o;
    }
    for (const p of pays) {
      if (!p.created_at) continue;
      if (SQ_LOCATION_IDS.length > 1 && !SQ_LOCATION_IDS.includes(p.location_id)) continue;
      const day = tradingDay(Date.parse(p.created_at), tz, roll);
      lastDay = day;
      if (p.status !== 'COMPLETED' || !(day in byDay)) continue;
      const b = byDay[day];
      b[0] += 1;
      b[2] += sqPaymentFee(p);
      const o = p.order_id && orders[p.order_id];
      if (!o) { b[1] += Math.round(sqMoney(p.amount_money) / SQ_FEE_GST_DIVISOR); continue; }
      const tTotal = (Array.isArray(o.tenders) ? o.tenders : []).reduce((s2, t) => s2 + sqMoney(t.amount_money), 0);
      const pTotal = sqMoney(p.total_money) || (sqMoney(p.amount_money) + sqMoney(p.tip_money));
      const share = tTotal > 0 ? Math.min(1, pTotal / tTotal) : 1;
      const [sale, gc] = sqOrderSaleExGst(o);
      b[1] += Math.round(sale * share);
      b[3] += Math.round(gc * share);
    }
    cursor = j.cursor || null;
  } while (cursor);
  return { byDay, complete: true, lastDay, pages };
}


/* --- KV cache: one blob per month: [[count, sales c, fee c, gift c, refunds c] per day | null], keyed by tz+rollover.
   sq4 = 16 Oct 2026 rules (gift cards out, refunds on their own day); sq3 days are recomputed. --- */
function sqMonthKey(tz, roll, mo) { return 'sq4:' + sqTzKey(tz) + ':' + roll + ':mo:' + mo; }
async function sqReadMonth(env, tz, roll, mo, cache) {
  const k = sqMonthKey(tz, roll, mo);
  if (cache[k]) return cache[k];
  const [y, m] = mo.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let arr = null;
  try { const raw = await env.TOKENS.get(k); arr = raw ? JSON.parse(raw) : null; } catch (e) { arr = null; }
  if (!Array.isArray(arr) || arr.length !== n) arr = new Array(n).fill(null);
  cache[k] = arr;
  return arr;
}
/* Store finished days only (never today or later - today is always live). */
async function sqStoreDays(env, tz, roll, days, today, cache) {
  const touched = {};
  for (const [d, v] of days) {
    if (d >= today) continue;
    const mo = d.slice(0, 7);
    const arr = await sqReadMonth(env, tz, roll, mo, cache);
    arr[+d.slice(8) - 1] = v;
    touched[mo] = arr;
  }
  for (const mo of Object.keys(touched)) await env.TOKENS.put(sqMonthKey(tz, roll, mo), JSON.stringify(touched[mo]));
}

/* Count for a date range: cached days + live for today / a few missing days.
   Returns null while older history is still being back-filled (honest "—"). */
async function sqCountRange(env, from, to, tz, roll) {
  const today = tradingDay(Date.now(), tz, roll);
  const cache = {};
  const total = [0, 0, 0, 0, 0];
  const add = (v) => { for (let i = 0; i < 5; i++) total[i] += (v[i] || 0); };
  const result = () => ({ count: total[0], sales: (total[1] - total[2]) / 100, grossExGst: total[1] / 100, fees: total[2] / 100,
    giftCards: total[3] / 100, refunds: total[4] / 100, beforeRefunds: (total[1] + total[4]) / 100 });
  const missing = [];
  for (let d = from; d <= to; d = addDay(d, 1)) {
    if (d > today) break;
    if (d === today) { missing.push(d); continue; }
    const arr = await sqReadMonth(env, tz, roll, d.slice(0, 7), cache);
    const v = arr[+d.slice(8) - 1];
    if (!Array.isArray(v)) missing.push(d); else add(v);
  }
  if (!missing.length) return result();
  if (missing.length > 2) return null;   /* older days come from the cron cache */
  const runs = [];
  for (const d of missing) {
    const last = runs[runs.length - 1];
    if (last && addDay(last[1], 1) === d) last[1] = d; else runs.push([d, d]);
  }
  for (const [a, b] of runs) {
    const r = await sqCountDays(env, a, b, tz, roll, 14, 'ASC');
    if (!r.complete) return null;
    for (const d of Object.keys(r.byDay)) add(r.byDay[d]);
    await sqStoreDays(env, tz, roll, Object.entries(r.byDay), today, cache);
  }
  return result();
}

async function sqCountMonth(env, mo, tz, roll) {
  const today = tradingDay(Date.now(), tz, roll);
  const first = mo + '-01';
  if (first > today) return null;
  const [y, m] = mo.split('-').map(Number);
  const last = mo + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
  return sqCountRange(env, first, last < today ? last : today, tz, roll);
}

/* The dashboard's timezone/rollover, remembered so the cron fills the right days. */
async function sqSaveCfg(env, tz, roll) {
  const want = JSON.stringify({ tz: tz || 'Australia/Melbourne', roll: +roll || 0 });
  const have = await env.TOKENS.get('sq:cfg');
  if (have !== want) await env.TOKENS.put('sq:cfg', want);
}
async function sqCfg(env) {
  try { const c = JSON.parse(await env.TOKENS.get('sq:cfg')); if (c && c.tz) return c; } catch (e) {}
  return { tz: 'Australia/Melbourne', roll: 0 };
}

/* Cron: fill new days forward, then back-fill history newest-first, within a
   page budget. Progress lives in sq:<tz>:<roll>:state = { newest, oldest }. */
async function sqBackfill(env) {
  if (!env.POS_API_TOKEN) return;
  const cfg = await sqCfg(env);
  const tz = cfg.tz, roll = +cfg.roll || 0;
  const today = tradingDay(Date.now(), tz, roll);
  const yesterday = addDay(today, -1);
  const t = new Date(today + 'T12:00:00Z');
  const start = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - SQ_HISTORY_MONTHS, 1)).toISOString().slice(0, 10);
  const stateKey = 'sq4:' + sqTzKey(tz) + ':' + roll + ':state';
  let st = { newest: null, oldest: null };
  try { st = JSON.parse(await env.TOKENS.get(stateKey)) || st; } catch (e) {}
  const cache = {};
  let budget = SQ_PAGES_PER_RUN;

  /* forward: days since the last run */
  while (st.newest && st.newest < yesterday && budget > 0) {
    const a = addDay(st.newest, 1);
    let b = addDay(a, 6); if (b > yesterday) b = yesterday;
    const r = await sqCountDays(env, a, b, tz, roll, budget, 'ASC');
    budget -= r.pages;
    const done = Object.entries(r.byDay).filter(([d]) => r.complete || (r.lastDay && d < r.lastDay));
    await sqStoreDays(env, tz, roll, done, today, cache);
    if (!done.length) break;
    st.newest = done[done.length - 1][0];
    await env.TOKENS.put(stateKey, JSON.stringify(st));
  }

  /* backward: history, newest first, 7 days at a time */
  while (budget > 0 && (st.oldest == null || st.oldest > start)) {
    const b = st.oldest ? addDay(st.oldest, -1) : yesterday;
    let a = addDay(b, -6); if (a < start) a = start;
    const r = await sqCountDays(env, a, b, tz, roll, budget, 'DESC');
    budget -= r.pages;
    const done = Object.entries(r.byDay).filter(([d]) => r.complete || (r.lastDay && d > r.lastDay));
    await sqStoreDays(env, tz, roll, done, today, cache);
    if (!done.length) break;
    done.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    st.oldest = done[0][0];
    if (!st.newest) st.newest = done[done.length - 1][0];
    await env.TOKENS.put(stateKey, JSON.stringify(st));
  }
}

/* One on-demand catch-up pass (replaces the cron). Returns { behind } - true while
   Square still has days up to yesterday left to fetch. */
async function sqBehind(env) {
  const cfg = await sqCfg(env);
  const roll = +cfg.roll || 0;
  const yesterday = addDay(tradingDay(Date.now(), cfg.tz, roll), -1);
  let st = null;
  try { st = JSON.parse(await env.TOKENS.get('sq4:' + sqTzKey(cfg.tz) + ':' + roll + ':state')); } catch (e) {}
  return !st || !st.newest || st.newest < yesterday;
}
async function apiCatchup(env) {
  const errors = {};
  for (const source of ['pos', 'rostering']) {
    const a = ADAPTERS[source];
    if (!a || typeof a.scheduledPull !== 'function') continue;
    try {
      await a.scheduledPull(env, makeHelpers(env, source));
      await noteSync(env, source);
    } catch (e) { errors[source] = (e && e.message) || 'failed'; }
  }
  let behind = false;
  try { behind = env.POS_API_TOKEN ? await sqBehind(env) : false; } catch (e) {}
  return json({ behind, errors });
}

/* Check page: the dashboard's Square figures for a date range, laid out like the
   Square app's Sales Report so the owner can compare line by line. Read-only. */
async function squareCheckPage(env, url) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cfg = await sqCfg(env);
  const tz = cfg.tz, roll = +cfg.roll || 0;
  const today = tradingDay(Date.now(), tz, roll);
  let from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) from = today.slice(0, 8) + '01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to || '')) to = today;
  const money = (n) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let body;
  try {
    const r = await sqCountRange(env, from, to, tz, roll);
    if (!r) {
      const st = await env.TOKENS.get('sq4:' + sqTzKey(tz) + ':' + roll + ':state');
      body = '<h1>Still loading</h1><p>The dashboard is still counting your Square history for these dates (it catches up each time you open or refresh the dashboard). Open the dashboard, then try again.</p><p class="m">Progress: ' + esc(st || 'starting') + '</p>';
    } else {
      body = '<h1>Square check</h1><p>' + esc(from) + ' to ' + esc(to) + ' · compare with the Square app\u2019s Sales Report for the same dates</p>'
        + '<table><tr><td>Sales (completed payments)</td><td class="n"><b>' + r.count + '</b></td><td>= "Sales" in Square</td></tr>'
        + '<tr><td>Sales, without GST, tips and gift cards</td><td class="n">' + money(r.beforeRefunds) + '</td><td></td></tr>'
        + '<tr><td>Refunds (on the day refunded)</td><td class="n">\u2212 ' + money(r.refunds) + '</td><td>= "Returns" in Square</td></tr>'
        + '<tr><td>Net sales, without GST and tips</td><td class="n"><b>' + money(r.grossExGst) + '</b></td><td>= "Net Sales" in Square</td></tr>'
        + '<tr><td>Card fees, without GST</td><td class="n">\u2212 ' + money(r.fees) + '</td><td></td></tr>'
        + '<tr class="t"><td>Revenue on the dashboard</td><td class="n"><b>' + money(r.sales) + '</b></td><td></td></tr></table>'
        + '<p class="m">Not counted as revenue: gift card sales ' + money(r.giftCards) + ' (Square lists these under "Deferred sales"). Gift cards are counted when they are spent.</p>';
    }
  } catch (e) {
    body = '<h1>Couldn\u2019t reach Square</h1><p>' + esc(e.message) + '</p>';
  }
  return htmlResponse('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Square check</title>'
    + '<style>body{margin:0;padding:1.5rem;background:#FDF7EE;font-family:system-ui,sans-serif;color:#2A2420;max-width:760px}h1{font-size:22px;margin:0 0 .3rem}p{font-size:14px;line-height:1.6;color:#8C8075}.m{font-size:12px}'
    + 'table{border-collapse:collapse;width:100%;font-size:15px;margin-top:1rem}td{padding:9px 6px;border-bottom:1px solid rgba(13,13,13,.07)}td.n{text-align:right;white-space:nowrap}td:last-child{color:#8C8075;font-size:13px}tr.t td{border-top:2px solid #2A2420}</style></head><body>' + body + '</body></html>');
}

/* ----------------------------------------------------------------------------
   Connecteam helpers (rostering adapter) - labour cost from timesheets
---------------------------------------------------------------------------- */
const CT_BASES = ['https://api-au.connecteam.com', 'https://api.connecteam.com'];   /* AU account first */
const CT_EXCLUDE_USER_IDS = [];   /* people whose pay is NOT floor/kitchen labour (owner-confirmed) */
/* Kitchen team by name (owner, 14 Oct 2026) - everyone else is front of house.
   Grouped by PERSON because some shifts in Connecteam have no job assigned. */
const CT_KITCHEN_NAMES = ['Michael Kaufman', 'Rebecca', 'Daniel', 'Lakkhana Dissanayake', 'Lakkhana'];
function ctIsKitchen(name) {
  const n = String(name || '').trim().toLowerCase();
  return !!n && CT_KITCHEN_NAMES.some((k) => { k = k.toLowerCase(); return n === k || n.startsWith(k + ' ') || k.startsWith(n + ' '); });
}
const CT_HISTORY_MONTHS = 26;
const CT_CALLS_PER_RUN = 10;

async function ctFetch(env, path) {
  const pref = await env.TOKENS.get('ct:base');
  const bases = pref ? [pref].concat(CT_BASES.filter((b) => b !== pref)) : CT_BASES;
  let lastErr = null;
  for (const base of bases) {
    const res = await fetch(base + path, { headers: { 'X-API-KEY': env.ROSTERING_API_TOKEN, 'Accept': 'application/json' } });
    if (res.ok) {
      if (base !== pref) await env.TOKENS.put('ct:base', base);
      return res.json();
    }
    lastErr = Object.assign(new Error('Connecteam HTTP ' + res.status), { status: res.status });
    if (![401, 403, 404].includes(res.status)) break;
  }
  throw lastErr;
}

async function ctClocks(env) {
  const raw = await env.TOKENS.get('ct:clocks');
  if (raw) { try { const c = JSON.parse(raw); if (c.at > Date.now() - 86400000) return c.clocks; } catch (e) {} }
  const j = await ctFetch(env, '/time-clock/v1/time-clocks');
  const clocks = ((j.data && j.data.timeClocks) || []).map((c) => ({ id: c.id, name: c.name, isArchived: !!c.isArchived }));
  await env.TOKENS.put('ct:clocks', JSON.stringify({ at: Date.now(), clocks: clocks }));
  return clocks;
}

/* userId -> name, cached a day (names decide kitchen vs front of house). */
async function ctUserNames(env) {
  const raw = await env.TOKENS.get('ct:users');
  if (raw) { try { const c = JSON.parse(raw); if (c.at > Date.now() - 86400000) return c.names; } catch (e) {} }
  const names = {};
  for (const q of ['?limit=500&userStatus=all', '?limit=500&userStatus=archived', '?limit=500']) {
    try {
      const uj = await ctFetch(env, '/users/v1/users' + q);
      for (const u of ((uj.data && uj.data.users) || [])) names[u.userId || u.id] = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '';
    } catch (e) {}
  }
  await env.TOKENS.put('ct:users', JSON.stringify({ at: Date.now(), names: names }));
  return names;
}

/* Labour cost straight from Connecteam for a..b (<= 45 days per call, per clock).
   Returns { cost, byUser } or throws { budget: true } when out of calls. */
async function ctLive(env, a, b, budget, wantUsers) {
  const clocks = await ctClocks(env);
  const names = await ctUserNames(env);
  let cost = 0, kitchen = 0;
  const byUser = {};
  for (let s = a; s <= b; s = addDay(s, 45)) {
    let e = addDay(s, 44); if (e > b) e = b;
    for (const c of clocks) {
      if (budget.calls <= 0) throw Object.assign(new Error('budget'), { budget: true });
      budget.calls--;
      const j = await ctFetch(env, '/time-clock/v1/time-clocks/' + c.id + '/timesheet?startDate=' + s + '&endDate=' + e);
      for (const u of ((j.data && j.data.users) || [])) {
        if (CT_EXCLUDE_USER_IDS.includes(u.userId)) continue;
        for (const d of (u.dailyRecords || [])) {
          for (const it of (d.payItems || [])) {
            const v = typeof it.totalPay === 'number' ? it.totalPay : 0;
            cost += v;
            if (ctIsKitchen(names[u.userId])) kitchen += v;
            if (wantUsers) {
              const k = u.userId;
              byUser[k] = byUser[k] || { pay: 0, hours: 0 };
              byUser[k].pay += v;
              byUser[k].hours += typeof it.hours === 'number' ? it.hours : 0;
            }
          }
        }
      }
    }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { cost: r2(cost), kitchen: r2(kitchen), foh: r2(cost - kitchen), byUser: byUser };
}

/* Month totals cached in KV. Recent months (timesheets still being edited and
   approved) expire after an hour; older months are kept. */
function ctMonthBounds(mo) {
  const [y, m] = mo.split('-').map(Number);
  return [mo + '-01', mo + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')];
}
function ctTodayMel() { return tzParts(Date.now(), 'Australia/Melbourne').year + '-' + tzParts(Date.now(), 'Australia/Melbourne').month + '-' + tzParts(Date.now(), 'Australia/Melbourne').day; }
async function ctMonthCached(env, mo) {
  const raw = await env.TOKENS.get('ct2:mo:' + mo);
  if (raw == null) return null;
  try { const v = JSON.parse(raw); return (v && typeof v.cost === 'number') ? v : null; } catch (e) { return null; }
}
async function ctMonth(env, mo, budget) {
  const cached = await ctMonthCached(env, mo);
  if (cached != null) return cached;
  const [a, b] = ctMonthBounds(mo);
  const today = ctTodayMel();
  if (a > today) return null;
  const r = await ctLive(env, a, b < today ? b : today, budget, false);
  const v = { cost: r.cost, kitchen: r.kitchen, foh: r.foh };
  const recent = addDay(b, 60) >= today;
  await env.TOKENS.put('ct2:mo:' + mo, JSON.stringify(v), recent ? { expirationTtl: 3600 } : undefined);
  return v;
}

/* Cost for any date range: whole months from the month cache, partial months live.
   Returns null when it would take more calls than this request can afford
   (the cron fills the month cache, so it appears shortly). */
async function ctCostRange(env, from, to, budget) {
  try {
    const t = { cost: 0, kitchen: 0, foh: 0 };
    let d = from;
    while (d <= to) {
      const mo = d.slice(0, 7);
      const [ma, mb] = ctMonthBounds(mo);
      const segEnd = mb < to ? mb : to;
      const r = (d === ma && segEnd === mb) ? await ctMonth(env, mo, budget) : await ctLive(env, d, segEnd, budget, false);
      if (r) { t.cost += r.cost; t.kitchen += r.kitchen; t.foh += r.foh; }
      d = addDay(segEnd, 1);
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    return { cost: r2(t.cost), kitchen: r2(t.kitchen), foh: r2(t.foh) };
  } catch (e) {
    if (e && e.budget) return null;
    throw e;
  }
}

async function ctBackfill(env) {
  if (!env.ROSTERING_API_TOKEN) return;
  const budget = { calls: CT_CALLS_PER_RUN };
  const today = ctTodayMel();
  const t = new Date(today + 'T12:00:00Z');
  for (let i = 0; i <= CT_HISTORY_MONTHS && budget.calls > 0; i++) {
    const mo = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
    try { await ctMonth(env, mo, budget); } catch (e) { if (e && e.budget) break; throw e; }
  }
}

/* Check page: labour cost per person for a range, so the owner can confirm who
   counts as floor/kitchen labour. Read-only, session-protected. */
async function connecteamCheckPage(env, url) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const today = ctTodayMel();
  let from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '')) from = addDay(today, -6);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to || '')) to = today;
  if (to > addDay(from, 44)) to = addDay(from, 44);
  const money = (n) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let body;
  try {
    const all = { calls: 6 };
    const clocks = await ctClocks(env);
    const saved = CT_EXCLUDE_USER_IDS.slice(); CT_EXCLUDE_USER_IDS.length = 0;   /* show everyone */
    let r;
    try { r = await ctLive(env, from, to, all, true); } finally { saved.forEach((x) => CT_EXCLUDE_USER_IDS.push(x)); }
    const names = await ctUserNames(env);
    const ids = Object.keys(r.byUser).sort((a, b) => r.byUser[b].pay - r.byUser[a].pay);
    let rows = '', counted = 0, kitchen = 0, foh = 0;
    const group = (id) => CT_EXCLUDE_USER_IDS.includes(+id) ? 'ex' : (ctIsKitchen(names[id]) ? 'k' : 'f');
    const label = { k: 'Kitchen', f: 'Front of house', ex: 'Not counted (overheads)' };
    for (const g of ['k', 'f', 'ex']) {
      for (const id of ids.filter((i) => group(i) === g)) {
        const x = r.byUser[id];
        if (g !== 'ex') counted += x.pay;
        if (g === 'k') kitchen += x.pay;
        if (g === 'f') foh += x.pay;
        rows += '<tr><td>' + esc(names[id] || ('Person ' + id)) + '</td><td class="n">' + x.hours.toFixed(2) + ' h</td><td class="n">' + money(x.pay) + '</td><td>' + label[g] + '</td></tr>';
      }
    }
    body = '<h1>Connecteam labour check</h1><p>' + esc(from) + ' to ' + esc(to) + ' · time clocks: ' + esc(clocks.filter((c) => !c.isArchived).map((c) => c.name).join(', ')) + '</p>'
      + '<p class="big">' + money(counted) + ' <span>counted as floor &amp; kitchen labour</span></p>'
      + '<p>Kitchen: <b>' + money(kitchen) + '</b> · Front of house: <b>' + money(foh) + '</b></p>'
      + (rows ? '<table><tr class="h"><td>Person</td><td class="n">Hours</td><td class="n">Pay</td><td></td></tr>' + rows + '</table>' : '<p>No timesheet entries with pay for these dates. Check pay rates are set up in Connecteam.</p>');
  } catch (e) {
    body = '<h1>Couldn’t reach Connecteam</h1><p>' + esc(e.message) + '</p>';
  }
  return htmlResponse('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connecteam check</title>'
    + '<style>body{margin:0;padding:1.5rem;background:#FDF7EE;font-family:system-ui,sans-serif;color:#2A2420;max-width:760px}h1{font-size:22px;margin:0 0 .3rem}p{font-size:14px;line-height:1.6;color:#8C8075}.big{font-size:26px;font-weight:700;color:#0D0D0D}.big span{font-size:14px;font-weight:400;color:#8C8075}'
    + 'table{border-collapse:collapse;width:100%;font-size:14px;margin-top:1rem}td{padding:8px 6px;border-bottom:1px solid rgba(13,13,13,.07)}td.n{text-align:right;white-space:nowrap}tr.h td{font-weight:600}</style></head><body>' + body + '</body></html>');
}

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FDF7EE;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#FFFBF5;border:1px solid rgba(107,26,26,0.12);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#6B1A1A;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#6B1A1A}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#FDF7EE;background:#6B1A1A;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FDF7EE;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#FFFBF5;border:1px solid rgba(107,26,26,0.12);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#6B1A1A;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#6B1A1A}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#FDF7EE;background:#6B1A1A;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You’ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (adapter && adapter.auth === 'token') {
    /* pasted-token sources have no Allow screen: just go back and re-check status */
    return Response.redirect(url.origin + '/', 302);
  }
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    /* Surface the provider's short error code (e.g. invalid_client, invalid_grant)
       so the owner can read it out - it never contains a secret. */
    let code = '';
    try { const b = await res.json(); code = String((b && (b.error || b.Title)) || '').replace(/[^\w .-]/g, '').slice(0, 60); } catch (e) {}
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + (code ? ' / ' + code : '') + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn’t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn’t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it’s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn’t be read. Check it’s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  for (const source of ['accounting', 'pos', 'rostering']) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    periods.cur = await fetchSlot(env, { ...base, ...cur });
    periods.prev = prev ? await fetchSlot(env, { ...base, ...prev }) : null;
    periods.yoy = yoy ? await fetchSlot(env, { ...base, ...yoy }) : null;

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of ['accounting', 'pos']) {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    /* OWNER DECISION 14 Oct 2026: Revenue = Square sales ex-GST after card fees
       (daily, as it happens). Xero revenue kept as revenueBooks for checking.
       If Square isn't available for a period, Revenue shows "—" (never Xero
       swapped in silently). */
    for (const k of ['cur', 'prev', 'yoy']) {
      const sl = periods[k];
      if (sl && sl.accounting) {
        sl.accounting.revenueBooks = sl.accounting.revenue;
        sl.accounting.revenue = (sl.pos && typeof sl.pos.sales === 'number') ? sl.pos.sales : null;
      }
    }
    /* OWNER DECISION 14 Oct 2026: labour (Wage %) = Connecteam timesheet pay for
       hours actually worked (super included in her Connecteam pay rates). Xero's
       interim labour figure is kept as wagesSuperBooks; never mixed. The rostering
       slot is cleared so the card doesn't also show it as a "projected" figure. */
    if (ADAPTERS.rostering.configured && env.ROSTERING_API_TOKEN) {
      for (const k of ['cur', 'prev', 'yoy']) {
        const sl = periods[k];
        if (sl && sl.accounting) {
          sl.accounting.wagesSuperBooks = sl.accounting.wagesSuper;
          const ros = sl.rostering;
          const xPre = sl.accounting.labourXeroPre || 0;   /* Xero labour before the Connecteam cutover */
          sl.accounting.wagesSuper = (ros && typeof ros.cost === 'number') ? xPre + ros.cost : null;
          /* kitchen / front-of-house split only exists for Connecteam days */
          const splitOk = ros && !xPre && typeof ros.kitchen === 'number';
          sl.accounting.wagesKitchen = splitOk ? ros.kitchen : null;
          sl.accounting.wagesFoh = splitOk ? ros.foh : null;
          sl.rostering = null;
        }
      }
      if (trendOut && trendOut.accounting) {
        trendOut.accounting.wagesSuperBooks = trendOut.accounting.wagesSuper;
        const ct = [];
        const xPre = trendOut.accounting.labourXeroPre || [];
        for (let i = 0; i < trendOut.months.length; i++) {
          const mo = trendOut.months[i];
          const pre = typeof xPre[i] === 'number' ? xPre[i] : null;
          if (mo + '-31' < LABOUR_CUTOVER) { ct.push(pre); continue; }   /* whole month before Connecteam */
          const v = await ctMonthCached(env, mo);
          ct.push(v ? (pre || 0) + v.cost : null);
        }
        trendOut.accounting.wagesSuper = ct;
      }
    }
    if (trendOut && trendOut.accounting) {
      trendOut.accounting.revenueBooks = trendOut.accounting.revenue;
      trendOut.accounting.revenue = (trendOut.pos && trendOut.pos.sales) ? trendOut.pos.sales : trendOut.months.map(() => null);
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  return json({
    generatedAt: data.generatedAt,
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: data.periods,
    trend: data.trend
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    /* OWNER DECISION 21 Oct 2026: no cron. The dashboard calls this when it is
       opened or Refresh is pressed; each call is one catch-up pass (same work the
       old 5-minute cron did) and says whether Square is still behind, so the page
       can call again. Nothing runs in the background. */
    if (path === '/api/catchup' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiCatchup(env);
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/check/connecteam' && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return connecteamCheckPage(env, url);
    }
    if (path === '/check/square' && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return squareCheckPage(env, url);
    }
    if (path === '/check/xero' && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return xeroCheckPage(env, url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
