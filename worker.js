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
import rosterHtml from './roster.html';
import refundsHtml from './refunds.html';
import forecastFile from './forecast.js';
import onboardHtml from './onboard.html';
import staffHtml from './staff.html';
import hubHtml from './hub.html';
import brandAssets from './brand.js';

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
  /* WIRED: Xero (14 Oct 2026). P&L report read-only.
     OWNER DECISION 28 Oct 2026: the same Xero connection may also ADD new
     employees (payroll.employees) and read pay settings / add a super fund by
     USI (payroll.settings), for the new starter form (/join). That is the only
     thing it writes; the books and pay runs are never touched. */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: 'offline_access accounting.reports.profitandloss.read payroll.employees payroll.settings',
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

  /* Google (hello@bainz.au Workspace, 28 Oct 2026): onboarding only.
     drive.file = only files and folders this app creates, nothing else in the
     Drive; gmail.send = send the new starter their link from hello@bainz.au
     (cannot read the inbox). Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
     Not part of the dashboard metrics (never in the source loops). */
  drive: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.send',
      authParams: { access_type: 'offline', prompt: 'consent' },
      clientIdSecret: 'GOOGLE_CLIENT_ID',
      clientSecretSecret: 'GOOGLE_CLIENT_SECRET',
      tokenAuth: 'post'
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
const CT_KITCHEN_NAMES = ['Michael Kaufman', 'Rebecca', 'Daniel', 'Lakkhana Dissanayake', 'Lakkhana', 'Jack Welter'];   /* Jack Welter added 23 Oct 2026 (new chef) */
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

/* ----------------------------------------------------------------------------
   Surcharge refunds (27 Oct 2026). OWNER DECISION: on Wed 21 Oct 2026 a 20%
   public holiday surcharge was charged in error (not a public holiday). This
   one-off tool refunds the surcharge on every CARD payment for a chosen day.
   It is the ONLY part of the dashboard that changes anything in Square, and it
   only acts when the owner presses "Refund" on /refunds after checking the list.
   - Surcharge per payment, in order of preference:
       1. 'service': the order's surcharge service charge / line item (name has
          "surcharge" or "holiday"), incl. GST - the exact amount charged
       2. 'estimate': (payment - tip) / 6  (20% on top = 1/6 of the final price)
     A split bill gets its share in proportion to each payment (tips excluded).
   - Card payments only; cash can't be refunded through Square.
   - Payments already part-refunded are SKIPPED (staff may have refunded by hand).
   - Each refund's idempotency key is fixed per payment ('hs-' + payment id), so
     a double-tap or re-run can never refund the same payment twice.
   - The plan lives in KV (refund:plan:<date>); amounts come from the plan, never
     from the page. Refunds go in batches of 20 (Cloudflare's 50-call limit).
   Needs PAYMENTS_WRITE on the Square token (a personal access token has it).
---------------------------------------------------------------------------- */
const RF_MATCH = /surcharge|holiday/i;
const RF_BATCH = 20;
function rfKey(date) { return 'refund:plan:' + date; }

async function rfPreview(env, date) {
  const cfg = await sqCfg(env);
  const tz = cfg.tz, roll = +cfg.roll || 0;
  const beginIso = new Date(localToUtcMs(date, roll, tz)).toISOString();
  const endIso = new Date(localToUtcMs(addDay(date, 1), roll, tz)).toISOString();
  const payments = [];
  let cursor = null, calls = 0;
  do {
    const q = new URLSearchParams({ begin_time: beginIso, end_time: endIso, sort_order: 'ASC', limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const j = await sqFetch(env, '/payments?' + q.toString());
    (j.payments || []).forEach((p) => payments.push(p));
    cursor = j.cursor; calls++;
  } while (cursor && calls < 15);
  const done = payments.filter((p) => p.status === 'COMPLETED');
  const card = done.filter((p) => p.source_type === 'CARD' || p.source_type === 'WALLET');

  /* orders, 100 per call */
  const other = done.filter((p) => !(p.source_type === 'CARD' || p.source_type === 'WALLET'));
  const ids = [...new Set(done.map((p) => p.order_id).filter(Boolean))];
  const orders = {};
  for (let i = 0; i < ids.length; i += 100) {
    const j = await sqFetch(env, '/orders/batch-retrieve', { order_ids: ids.slice(i, i + 100) });
    (j.orders || []).forEach((o) => { orders[o.id] = o; });
  }

  const surOf = (p) => {
    const amt = sqMoney(p.amount_money), tip = sqMoney(p.tip_money);
    const o = orders[p.order_id];
    if (o) {
      const sc = (Array.isArray(o.service_charges) ? o.service_charges : []).filter((s) => RF_MATCH.test(s.name || ''));
      const li = (Array.isArray(o.line_items) ? o.line_items : []).filter((x) => RF_MATCH.test(x.name || ''));
      const orderSur = sc.reduce((s, x) => s + sqMoney(x.total_money), 0) + li.reduce((s, x) => s + sqMoney(x.total_money), 0);
      if (orderSur > 0) {
        const orderBase = sqMoney(o.total_money) - sqMoney(o.total_tip_money);
        const share = orderBase > 0 ? Math.min(1, (amt - tip) / orderBase) : 1;
        return { sur: Math.round(orderSur * share), method: 'service', label: (sc[0] || li[0]).name || '' };
      }
    }
    return { sur: Math.round((amt - tip) / 6), method: 'estimate', label: '' };
  };
  /* cash and other payments: listed only (time + what was ordered), never refunded here */
  const itemsOf = (p) => {
    const o = orders[p.order_id] || {};
    return (Array.isArray(o.line_items) ? o.line_items : []).filter((x) => !RF_MATCH.test(x.name || ''))
      .map((x) => ({ name: [x.name, x.variation_name && x.variation_name !== 'Regular' ? x.variation_name : ''].filter(Boolean).join(' \u2013 ') || 'Custom amount',
        qty: x.quantity || '1', mods: (Array.isArray(x.modifiers) ? x.modifiers : []).map((m) => m.name).filter(Boolean), total: sqMoney(x.total_money) }));
  };
  const others = other.map((p) => {
    const items = itemsOf(p);
    const s = surOf(p);
    return { id: p.id, at: p.created_at, amt: sqMoney(p.amount_money), tip: sqMoney(p.tip_money), type: (p.source_type || '').replace(/_/g, ' ').toLowerCase(),
      sur: s.sur, method: s.method, items, refunded: sqMoney(p.refunded_money) };
  });

  const rows = [];
  for (const p of card) {
    const amt = sqMoney(p.amount_money), tip = sqMoney(p.tip_money);
    const already = sqMoney(p.refunded_money);
    let { sur, method, label } = surOf(p);
    sur = Math.max(0, Math.min(sur, amt - already));
    const c = (p.card_details && p.card_details.card) || {};
    rows.push({
      id: p.id, at: p.created_at, amt, tip, sur, method, label, items: itemsOf(p),
      card: (c.card_brand || p.source_type || '').replace(/_/g, ' ') + (c.last_4 ? ' •' + c.last_4 : ''),
      cur: (p.amount_money && p.amount_money.currency) || 'AUD',
      status: already > 0 ? 'skipped' : (sur > 0 ? 'pending' : 'nothing'),
      note: already > 0 ? 'Already refunded $' + (already / 100).toFixed(2) + ' – check by hand' : ''
    });
  }

  /* keep results of any refunds already made for this day */
  let prev = null;
  try { prev = JSON.parse((await env.TOKENS.get(rfKey(date))) || 'null'); } catch (e) {}
  if (prev && prev.rows) {
    const old = {}; prev.rows.forEach((r) => { old[r.id] = r; });
    rows.forEach((r) => { const o = old[r.id]; if (o && (o.status === 'refunded' || o.status === 'error')) Object.assign(r, { status: o.status, note: o.note, refundId: o.refundId, sur: o.sur, tries: o.tries || (o.status === 'error' ? 1 : 0) }); });
  }
  const plan = {
    v: 2, date, tz, built: new Date().toISOString(), rows, others,
    counts: { all: done.length, card: card.length, other: done.length - card.length }
  };
  await env.TOKENS.put(rfKey(date), JSON.stringify(plan), { expirationTtl: 60 * 86400 });
  return plan;
}

/* RETRY (27 Oct 2026): a failed row can be retried. First re-read the payment:
   if Square already shows the refund (e.g. the first try went through but the
   answer was lost), it is marked refunded and NOT sent again. Otherwise it is
   resent with a fresh key per attempt (hs-<id>-r1, -r2...). */
async function rfRefundOne(env, row, date) {
  if (row.tries) {
    const pj = await sqFetch(env, '/payments/' + encodeURIComponent(row.id));
    const got = sqMoney(pj.payment && pj.payment.refunded_money);
    if (got >= row.sur) return { id: '', status: 'already in Square' };
  }
  row.tries = (row.tries || 0) + 1;
  const res = await fetch(SQ_API + '/refunds', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.POS_API_TOKEN, 'Square-Version': SQ_VERSION, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      idempotency_key: 'hs-' + row.id + (row.tries > 1 ? '-r' + (row.tries - 1) : ''),
      payment_id: row.id,
      amount_money: { amount: row.sur, currency: row.cur || 'AUD' },
      reason: 'Public holiday surcharge charged in error on ' + date
    })
  });
  let j = {}; try { j = await res.json(); } catch (e) {}
  if (!res.ok) {
    const er = (j.errors && j.errors[0]) || {};
    const e = new Error(er.detail || er.code || ('Square HTTP ' + res.status));
    e.status = res.status; e.code = er.code;
    throw e;
  }
  return j.refund || {};
}

async function rfRun(env, date, selected) {
  let plan; try { plan = JSON.parse((await env.TOKENS.get(rfKey(date))) || 'null'); } catch (e) {}
  if (!plan) return { error: 'no_plan' };
  const want = new Set(Array.isArray(selected) ? selected : []);
  const open = (r) => (r.status === 'pending' || r.status === 'error') && want.has(r.id);
  const todo = plan.rows.filter((r) => open(r) && r.status === 'error').concat(plan.rows.filter((r) => open(r) && r.status === 'pending')).slice(0, RF_BATCH);
  todo.forEach((r) => { if (r.status === 'error') r.tries = Math.max(r.tries || 0, 1); });
  let stop = null;
  for (const r of todo) {
    try {
      const rf = await rfRefundOne(env, r, date);
      r.status = 'refunded'; r.refundId = rf.id || ''; r.note = (rf.status || '').toLowerCase();
    } catch (e) {
      if (e.status === 401 || e.status === 403) { stop = 'permission'; break; }
      if (e.status === 429) { stop = 'busy'; break; }
      r.status = 'error'; r.note = e.message;
    }
  }
  await env.TOKENS.put(rfKey(date), JSON.stringify(plan), { expirationTtl: 60 * 86400 });
  const left = plan.rows.filter((r) => r.status === 'pending' && want.has(r.id)).length;
  return { plan, left, stop };
}

async function rfRoute(env, request, url, path) {
  const date = url.searchParams.get('date') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date' }, 400);
  if (!env.POS_API_TOKEN) return json({ error: 'square_not_connected' }, 400);
  try {
    if (path === '/api/refunds/plan' && request.method === 'GET') {
      let plan = null; try { plan = JSON.parse((await env.TOKENS.get(rfKey(date))) || 'null'); } catch (e) {}
      return json({ plan });
    }
    if (path === '/api/refunds/preview' && request.method === 'POST') return json({ plan: await rfPreview(env, date) });
    if (path === '/api/refunds/run' && request.method === 'POST') {
      let body = {}; try { body = await request.json(); } catch (e) {}
      const r = await rfRun(env, date, body.ids);
      return json(r, r.error ? 400 : 200);
    }
  } catch (e) {
    return json({ error: (e.status === 401 || e.status === 403) ? 'permission' : (e.message || 'error') }, 500);
  }
  return json({ error: 'not found' }, 404);
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
async function makeSession(env, role) {
  const payload = (role || 'v1') + '.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token, role) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!payload.startsWith((role || 'v1') + '.')) return false;   /* owner 'v1' vs manager 'r1' */
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
  for (const k of Object.keys(cfg.authParams || {})) p.set(k, cfg.authParams[k]);
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
    obtained_at: new Date().toISOString(),
    scope: t.scope || cfg.scopes || ''
  });
  if (source === 'drive') return Response.redirect(url.origin + '/staff', 302);
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

/* ============================================================================
   ROSTERING TOOL (built 21 Oct 2026)
   A separate page (/roster) for the café manager: half-hourly Square sales next
   to who was actually clocked in (Connecteam), so over- and under-rostering is
   easy to see. The staffing rules themselves live in roster.html (owner's rules,
   21 Oct 2026); this part only gathers the numbers, one Mon-Sun week at a time,
   and keeps them in KV so nothing is fetched twice. Nothing runs in the
   background - weeks are fetched only when someone opens the page.

   Per day we keep 15-minute slots from 06:00 to 16:30 (42 slots):
     sales[i] = net sales ex-GST, ex-tips, in cents, rung up in that slot
     foh[i] / kit[i] = average number of front-of-house / kitchen staff clocked
                       in during that slot (2.5 = two people, plus one for half)
   Square sales per payment are (amount ex-tip) / 1.1, then scaled so each day
   matches the dashboard's own Net Sales figure for that day when it has one.
   The manager sees hours and totals, never individual pay.
============================================================================ */
const RO_TZ = 'Australia/Melbourne';
const RO_FIRST_WEEK = '2026-09-21';      /* Connecteam timesheets start here */
const RO_SLOT0_HOUR = 6;                  /* slot 0 starts 06:00 */
const RO_SLOTS = 42;                      /* 15-min slots to 16:30 */
const RO_SLOT_MS = 15 * 60000;
const RO_SQ_MAX_PAGES = 40;               /* free plan allows 50 calls a request */

function roWeekDays(mon) { const a = []; for (let i = 0; i < 7; i++) a.push(addDay(mon, i)); return a; }
function roMs(t) {
  const v = (t && typeof t === 'object') ? (t.timestamp ?? t.time ?? t.value) : t;
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return null;
  return v < 1e12 ? v * 1000 : v;
}
/* Add the minutes of [a,b) (ms) that fall into each day's slots; returns hours outside the window. */
function roAddSpan(days, field, a, b, sign) {
  if (!(b > a)) return 0;
  let inside = 0;
  for (const d of Object.keys(days)) {
    const base = days[d]._base;
    const arr = days[d][field];
    for (let i = 0; i < RO_SLOTS; i++) {
      const s0 = base + i * RO_SLOT_MS, s1 = s0 + RO_SLOT_MS;
      const ov = Math.min(b, s1) - Math.max(a, s0);
      if (ov > 0) { arr[i] += sign * ov / RO_SLOT_MS; inside += ov; }
    }
  }
  return (b - a - inside) / 3600000;
}

async function roSquareWeek(env, mon, days) {
  if (!env.POS_API_TOKEN) return { ok: false, why: 'Square not connected' };
  const startIso = new Date(localToUtcMs(mon, 0, RO_TZ)).toISOString();
  const endIso = new Date(localToUtcMs(addDay(mon, 7), 0, RO_TZ)).toISOString();
  let cursor = null, pages = 0;
  const est = {};
  do {
    if (pages >= RO_SQ_MAX_PAGES) return { ok: false, why: 'Too many Square sales in one week to fetch in one go' };
    const q = new URLSearchParams({ begin_time: startIso, end_time: endIso, sort_order: 'ASC', limit: '100' });
    if (SQ_LOCATION_IDS.length === 1) q.set('location_id', SQ_LOCATION_IDS[0]);
    if (cursor) q.set('cursor', cursor);
    const j = await sqFetch(env, '/payments?' + q.toString());
    pages++;
    for (const p of (j.payments || [])) {
      if (p.status !== 'COMPLETED' || !p.created_at) continue;
      if (SQ_LOCATION_IDS.length > 1 && !SQ_LOCATION_IDS.includes(p.location_id)) continue;
      const ms = Date.parse(p.created_at);
      const pp = tzParts(ms, RO_TZ);
      const d = pp.year + '-' + pp.month + '-' + pp.day;
      if (!days[d]) continue;
      const c = Math.round(sqMoney(p.amount_money) / SQ_FEE_GST_DIVISOR);
      est[d] = (est[d] || 0) + c;
      const i = Math.floor((ms - days[d]._base) / RO_SLOT_MS);
      if (i >= 0 && i < RO_SLOTS) days[d].sales[i] += c; else days[d].salesOutside += c;
    }
    cursor = j.cursor || null;
  } while (cursor);
  /* line each day up with the dashboard's Net Sales (gift cards out, tips out) when it has that day */
  try {
    const cfg = await sqCfg(env);
    if (sqTzKey(cfg.tz) === RO_TZ && !(+cfg.roll)) {
      const cache = {};
      for (const d of Object.keys(days)) {
        const arr = await sqReadMonth(env, cfg.tz, 0, d.slice(0, 7), cache);
        const v = arr && arr[+d.slice(8) - 1];
        if (!Array.isArray(v) || !est[d]) continue;
        const target = (v[1] || 0) + (v[4] || 0);   /* as rung up, before refunds */
        const f = target / est[d];
        if (f > 0.8 && f < 1.25) {
          days[d].sales = days[d].sales.map((x) => Math.round(x * f));
          days[d].salesOutside = Math.round(days[d].salesOutside * f);
        }
      }
    }
  } catch (e) {}
  return { ok: true, pages };
}

/* Connecteam: who was clocked in when (time activities) + pay and hours per day (timesheet). */
async function roConnecteamWeek(env, mon, days) {
  if (!env.ROSTERING_API_TOKEN) return { ok: false, why: 'Connecteam not connected' };
  const sun = addDay(mon, 6);
  const clocks = (await ctClocks(env)).filter((c) => !c.isArchived);
  const names = await ctUserNames(env);
  const group = (uid) => (ctIsKitchen(names[uid]) ? 'kit' : 'foh');
  const diag = { clocks: clocks.length, users: 0, shifts: 0, breaks: 0, skipped: [], sample: null };
  const pay = { foh: 0, kit: 0, fohH: 0, kitH: 0, byDay: {} };
  /* timesheets first: what Connecteam actually counts as worked (hours per person per day) */
  const worked = {};
  for (const c of clocks) {
    const t = await ctFetch(env, '/time-clock/v1/time-clocks/' + c.id + '/timesheet?startDate=' + mon + '&endDate=' + sun);
    for (const u of ((t.data && t.data.users) || [])) {
      if (CT_EXCLUDE_USER_IDS.includes(u.userId)) continue;
      const g = group(u.userId);
      for (const d of (u.dailyRecords || [])) {
        let p = 0, h = 0;
        for (const it of (d.payItems || [])) {
          p += typeof it.totalPay === 'number' ? it.totalPay : 0;
          h += typeof it.hours === 'number' ? it.hours : 0;
        }
        pay[g] += p; pay[g + 'H'] += h;
        const dk = typeof d.date === 'string' ? d.date.slice(0, 10) : null;
        if (dk && days[dk]) { pay.byDay[dk] = pay.byDay[dk] || { foh: 0, kit: 0 }; pay.byDay[dk][g] += p; }
        if (dk) worked[u.userId + '|' + dk] = (worked[u.userId + '|' + dk] || 0) + h;
      }
    }
  }
  for (const c of clocks) {
    const j = await ctFetch(env, '/time-clock/v1/time-clocks/' + c.id + '/time-activities?startDate=' + mon + '&endDate=' + sun);
    const data = j.data || j;
    const list = data.timeActivitiesByUsers || data.users || data.timeActivities || [];
    if (!diag.sample) diag.sample = Object.keys(data).join(',') + (list[0] ? ' | ' + Object.keys(list[0]).join(',') : '');
    for (const u of list) {
      const uid = u.userId ?? u.id;
      if (CT_EXCLUDE_USER_IDS.includes(uid)) continue;
      diag.users++;
      const g = group(uid);
      /* Breaks only count inside that person's own shifts: each shift becomes the
         on-the-floor pieces (shift minus logged breaks). The staff count, the
         per-person columns and the hours all come from these same pieces, so
         they always agree (fixed 21 Oct 2026). */
      const brs = [];
      for (const br of (u.manualBreaks || u.breaks || [])) {
        const a = roMs(br.start), b = roMs(br.end);
        if (a == null || b == null || !(b > a)) continue;
        diag.breaks++;
        brs.push([a, b]);
      }
      brs.sort((x, y) => x[0] - y[0]);
      const hm = (ms) => { const q = tzParts(ms, RO_TZ); return q.hour + ':' + q.minute; };
      for (const sh of (u.shifts || [])) {
        const a = roMs(sh.start), b = roMs(sh.end);
        if (a == null || b == null || !(b > a)) continue;
        if (sh.isDeleted || sh.deleted || sh.isArchived || /delet|void|reject/i.test(String(sh.status || sh.state || ''))) { diag.skipped.push((names[uid] || uid) + ' (deleted)'); continue; }
        /* Owner, 28 Oct 2026: a clock-in deleted in Connecteam still came back here. Only count
           clock-ins on days where that person has hours on their Connecteam timesheet. */
        const q0 = tzParts(a, RO_TZ), dkey = q0.year + '-' + q0.month + '-' + q0.day;
        if (!(worked[uid + '|' + dkey] > 0)) { diag.skipped.push((names[uid] || uid) + ' ' + dkey); continue; }
        diag.shifts++;
        const pieces = [];
        let cur = a;
        const inBrk = [];
        for (const [x, y] of brs) {
          if (y <= cur || x >= b) continue;
          if (x > cur) pieces.push([cur, x]);
          inBrk.push([Math.max(x, a), Math.min(y, b)]);
          cur = Math.max(cur, y);
          if (cur >= b) break;
        }
        if (cur < b) pieces.push([cur, b]);
        let out = 0, ms = 0;
        for (const [x, y] of pieces) { out += roAddSpan(days, g, x, y, 1); ms += y - x; }
        const d0 = tzParts(a, RO_TZ); const dk = d0.year + '-' + d0.month + '-' + d0.day;
        if (days[dk]) {
          days[dk][g + 'Outside'] += out;
          /* who worked: names and times only, never pay */
          days[dk].people.push({ name: names[uid] || 'Unknown', g: g, in: hm(a), out: hm(b),
            pieces: pieces.map(([x, y]) => [hm(x), hm(y)]), brks: inBrk.map(([x, y]) => [hm(x), hm(y)]),
            brk: Math.round((b - a - ms) / 60000), h: Math.round(ms / 36000) / 100 });
        }
      }
    }
  }
  return { ok: true, diag, pay };
}

async function roBuildWeek(env, mon) {
  const days = {};
  for (const d of roWeekDays(mon)) {
    days[d] = { _base: localToUtcMs(d, RO_SLOT0_HOUR, RO_TZ), sales: new Array(RO_SLOTS).fill(0), salesOutside: 0,
      foh: new Array(RO_SLOTS).fill(0), kit: new Array(RO_SLOTS).fill(0), fohOutside: 0, kitOutside: 0, people: [] };
  }
  const sq = await roSquareWeek(env, mon, days);
  let ct;
  try { ct = await roConnecteamWeek(env, mon, days); } catch (e) { ct = { ok: false, why: 'Connecteam: ' + (e && e.message) }; }
  const r2 = (x) => Math.round(x * 100) / 100;
  const out = roWeekDays(mon).map((d) => {
    const x = days[d];
    const p = ct.ok && ct.pay.byDay[d];
    return { date: d, sales: x.sales, salesOutside: x.salesOutside, foh: x.foh.map(r2), kit: x.kit.map(r2),
      fohOutside: r2(x.fohOutside), kitOutside: r2(x.kitOutside),
      people: x.people.sort((p, q) => (p.in < q.in ? -1 : p.in > q.in ? 1 : 0)), pay: p ? { foh: r2(p.foh), kit: r2(p.kit) } : null };
  });
  return {
    week: mon, days: out, builtAt: new Date().toISOString(),
    square: sq.ok ? { ok: true } : { ok: false, why: sq.why },
    connecteam: ct.ok ? { ok: true, diag: ct.diag } : { ok: false, why: ct.why },
    labour: ct.ok ? { foh: r2(ct.pay.foh), kit: r2(ct.pay.kit), fohH: r2(ct.pay.fohH), kitH: r2(ct.pay.kitH) } : null
  };
}

async function roWeek(env, mon, force) {
  const key = 'ro4:wk:' + mon;   /* ro4 = clock-ins only where the timesheet has hours (deleted clock-ins dropped, 28 Oct 2026) */
  if (!force) {
    const raw = await env.TOKENS.get(key);
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  }
  const w = await roBuildWeek(env, mon);
  if (w.square.ok && w.connecteam.ok) {
    /* timesheets get fixed up for a couple of weeks; recent weeks re-fetch after 6 hours */
    const recent = addDay(mon, 21) >= ctTodayMel();
    await env.TOKENS.put(key, JSON.stringify(w), recent ? { expirationTtl: 3600 } : undefined);   /* recent weeks: 1 h, so timesheet edits show up (was 6 h) */
  }
  return w;
}


/* ----------------------------------------------------------------------------
   PLAN A WEEK (21 Oct 2026): the roster scheduled in Connecteam (published and
   draft) for a coming week, costed from each person's own recent timesheet rate
   (weekday / Saturday / Sunday where known). Rates stay on the server; the page
   only gets per-day totals. Forecast (weekly net sales) and budget are kept in KV.
---------------------------------------------------------------------------- */
async function roRates(env) {
  const raw = await env.TOKENS.get('ro:rates');
  if (raw) { try { const c = JSON.parse(raw); if (c.at > Date.now() - 86400000) return c; } catch (e) {} }
  const to = addDay(ctTodayMel(), -1), from = addDay(to, -41);
  const acc = {};   /* uid -> { wd:[pay,h], sat:[..], sun:[..], all:[..] } */
  for (const c of (await ctClocks(env)).filter((x) => !x.isArchived)) {
    const t = await ctFetch(env, '/time-clock/v1/time-clocks/' + c.id + '/timesheet?startDate=' + from + '&endDate=' + to);
    for (const u of ((t.data && t.data.users) || [])) {
      const a = acc[u.userId] = acc[u.userId] || { wd: [0, 0], sat: [0, 0], sun: [0, 0], all: [0, 0] };
      for (const d of (u.dailyRecords || [])) {
        let p = 0, h = 0;
        for (const it of (d.payItems || [])) { p += typeof it.totalPay === 'number' ? it.totalPay : 0; h += typeof it.hours === 'number' ? it.hours : 0; }
        if (!(h > 0)) continue;
        const dow = typeof d.date === 'string' ? new Date(d.date.slice(0, 10) + 'T12:00:00Z').getUTCDay() : -1;
        const k = dow === 6 ? 'sat' : dow === 0 ? 'sun' : 'wd';
        a[k][0] += p; a[k][1] += h; a.all[0] += p; a.all[1] += h;
      }
    }
  }
  const out = { at: Date.now(), users: {} };
  for (const uid of Object.keys(acc)) {
    const a = acc[uid], r = {};
    for (const k of ['wd', 'sat', 'sun', 'all']) if (a[k][1] > 0) r[k] = a[k][0] / a[k][1];
    out.users[uid] = r;
  }
  await env.TOKENS.put('ro:rates', JSON.stringify(out));
  return out;
}
/* Current pay rates straight from Connecteam (GET /pay-rates/v1/pay-rates, needs the
   pay_rates.read scope on the API key). Returns { uid: { def: hourly, res: { jobId: hourly } } }
   using the latest rate effective on or before `onDate`; {} if not available. The response
   layout is read defensively (field names per Connecteam's pay-rates guide). */
function roNum(o, keys) { for (const k of keys) { const v = o && o[k]; if (typeof v === 'number' && isFinite(v)) return v; if (v && typeof v === 'object') { const n = roNum(v, ['amount', 'value', 'rate', 'hourlyRate']); if (n != null) return n; } } return null; }
async function roPayRates(env, from, to) {
  const out = {}, diag = { ok: false, users: 0, sample: '' };
  try {
    for (let off = 0; off < 5000; ) {
      const j = await ctFetch(env, '/pay-rates/v1/pay-rates?startDate=' + from + '&endDate=' + to + '&rateType=hourly&limit=500&offset=' + off);
      const d = j.data || j;
      const list = d.payRatesByUsers || d.payRates || d.users || d.items || (Array.isArray(d) ? d : []);   /* documented: data.payRatesByUsers[].payRate */
      if (!diag.sample) diag.sample = Object.keys(d).join(',') + (list[0] ? ' | ' + Object.keys(list[0]).join(',') : '');
      for (const it of list) {
        const uid = it.userId ?? (it.user && it.user.id);
        if (uid == null) continue;
        const entries = it.payRate ? (Array.isArray(it.payRate) ? it.payRate : [it.payRate]) : Array.isArray(it.payRates) ? it.payRates : Array.isArray(it.rates) ? it.rates : [it];
        let best = null;
        for (const e of entries) {
          const eff = String(e.effectiveDate || e.startDate || '0000-00-00').slice(0, 10);
          if (eff > to) continue;
          if (e.rateType && e.rateType !== 'hourly') continue;
          if (!best || eff >= best.eff) best = { eff, e };
        }
        if (!best) continue;
        const e = best.e, def = roNum(e, ['defaultRate', 'rate', 'amount', 'hourlyRate', 'value']);
        const res = {};
        for (const rr of (e.resourcesRates || e.resourceRates || [])) {
          const id = rr.resourceId ?? rr.jobId ?? rr.id;
          const v = (rr.isUsingDefaultRate || rr.useDefaultRate) ? def : roNum(rr, ['rate', 'amount', 'hourlyRate', 'value']);
          if (id != null && v != null) res[id] = v;
        }
        if ((def != null || Object.keys(res).length) && (!out[uid] || best.eff >= out[uid].eff)) out[uid] = { def, res, eff: best.eff };
      }
      const pg = j.paging || d.paging;
      if (list.length < 500 || !(pg && pg.offset)) break;
      off = pg.offset;
    }
    diag.users = Object.keys(out).length;
    diag.ok = diag.users > 0;
  } catch (e) { diag.error = (e && e.message) || 'failed'; }
  return { rates: out, diag };
}
/* Unpaid break minutes scheduled on a shift (Connecteam only deducts breaks that are on the shift). */
function roShiftUnpaidMin(sh) {
  let m = 0;
  for (const b of (sh.breaks || sh.shiftBreaks || [])) {
    if (b.isPaid === true || b.type === 'paid' || b.paid === true) continue;
    const d = typeof b.duration === 'number' ? b.duration : typeof b.durationMinutes === 'number' ? b.durationMinutes : typeof b.durationInMinutes === 'number' ? b.durationInMinutes : null;
    if (d != null) { m += d > 1000 ? d / 60 : d; continue; }   /* seconds vs minutes */
    const a = roMs(b.startTime ?? b.start), e = roMs(b.endTime ?? b.end);
    if (a != null && e != null && e > a) m += (e - a) / 60000;
  }
  return m;
}
/* Weekend loadings on base pay rates (owner, 21 Oct 2026): casuals - everyone except Tyler and
   Michael - are x1.2 on Saturday and Sunday (levels 1-2); Hattie (level 3) is x1.2 Saturday and
   x1.4 Sunday; Tyler and Michael are on base rate. Public holidays (x2) not applied yet. */
function roWeekendLoading(name, wk) {
  const first = String(name || '').trim().split(/\s+/)[0].toLowerCase();
  if (first === 'tyler' || first === 'michael') return 1;
  if (first === 'hattie' && wk === 'sun') return 1.4;
  return 1.2;
}
async function roScheduled(env, mon, detail) {
  const sj = await ctFetch(env, '/scheduler/v1/schedulers');
  const scheds = ((sj.data && (sj.data.schedulers || sj.data)) || []).filter((x) => x && !x.isArchived);
  const names = await ctUserNames(env);
  const rates = await roRates(env);
  const pr = await roPayRates(env, mon, addDay(mon, 6));
  const startS = Math.floor(localToUtcMs(mon, 0, RO_TZ) / 1000), endS = Math.floor(localToUtcMs(addDay(mon, 7), 0, RO_TZ) / 1000);
  const days = {};
  for (const d of roWeekDays(mon)) days[d] = { date: d, shifts: [], cost: { foh: 0, kit: 0 }, unpriced: 0 };
  const diag = { schedulers: scheds.length, shifts: 0, fromRates: 0, fromHistory: 0, payRates: null, shiftKeys: '', sample: scheds[0] ? Object.keys(scheds[0]).join(',') : Object.keys(sj.data || sj).join(',') };
  /* average rate per group as a fallback for anyone without recent timesheets */
  const grp = { foh: [0, 0], kit: [0, 0] };
  for (const uid of Object.keys(rates.users)) { const r = rates.users[uid].all; if (r) { const g = ctIsKitchen(names[uid]) ? 'kit' : 'foh'; grp[g][0] += r; grp[g][1]++; } }
  const avg = { foh: grp.foh[1] ? grp.foh[0] / grp.foh[1] : 0, kit: grp.kit[1] ? grp.kit[0] / grp.kit[1] : 0 };
  /* Weekend loadings (owner 21 Oct 2026: Connecteam showed $6,549.23 FOH vs $6,258 at base rates).
     Each person's own Saturday / Sunday loading = their average pay per hour on that day ÷ their
     weekday average over the last 6 weeks (timesheets already have Connecteam's pay rules applied).
     People without enough history use the middle loading of their group. */
  const ratios = { foh: { sat: [], sun: [] }, kit: { sat: [], sun: [] } };
  const mult = {};
  for (const uid of Object.keys(rates.users)) {
    const u = rates.users[uid], g = ctIsKitchen(names[uid]) ? 'kit' : 'foh';
    mult[uid] = {};
    for (const k of ['sat', 'sun']) {
      if (u.wd > 0 && u[k] > 0) { const q = u[k] / u.wd; if (q >= 0.95 && q <= 2.6) { mult[uid][k] = q; ratios[g][k].push(q); } }
    }
  }
  const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  const gmult = { foh: { sat: med(ratios.foh.sat) || 1, sun: med(ratios.foh.sun) || 1 }, kit: { sat: med(ratios.kit.sat) || med(ratios.foh.sat) || 1, sun: med(ratios.kit.sun) || med(ratios.foh.sun) || 1 } };
  diag.weekendLoading = { foh: gmult.foh, kit: gmult.kit };
  for (const sc of scheds) {
    const sid = sc.schedulerId ?? sc.id;
    for (let off = 0; off < 3000; ) {
      const j = await ctFetch(env, '/scheduler/v1/schedulers/' + sid + '/shifts?startTime=' + startS + '&endTime=' + endS + '&limit=500&offset=' + off);
      const list = (j.data && j.data.shifts) || [];
      for (const sh of list) {
        if (!diag.shiftKeys) diag.shiftKeys = Object.keys(sh).join(',');
        const a = roMs(sh.startTime), b = roMs(sh.endTime);
        if (a == null || b == null || !(b > a)) continue;
        const p0 = tzParts(a, RO_TZ), dk = p0.year + '-' + p0.month + '-' + p0.day;
        if (!days[dk]) continue;
        const users = Array.isArray(sh.assignedUserIds) && sh.assignedUserIds.length ? sh.assignedUserIds : [null];
        for (const uid of users) {
          diag.shifts++;
          const nm = uid == null ? 'Open shift' : (names[uid] || 'Unknown');
          const g = ctIsKitchen(nm) ? 'kit' : 'foh';
          /* match Connecteam: only breaks scheduled on the shift are unpaid (owner saw $6,549 in Connecteam vs $6,419 here, 21 Oct 2026) */
          const brkMin = roShiftUnpaidMin(sh);
          const hrsPaid = (b - a) / 3600000 - brkMin / 60;
          const dow = new Date(dk + 'T12:00:00Z').getUTCDay();
          const cr = uid != null && pr.rates[uid];
          const base = cr ? ((sh.jobId != null && cr.res[sh.jobId] != null) ? cr.res[sh.jobId] : cr.def) : null;
          const wk = dow === 6 ? 'sat' : dow === 0 ? 'sun' : null;
          const load = wk ? roWeekendLoading(nm, wk) : 1;
          const crate = base != null ? base * load : null;
          const r = crate != null ? crate : (uid != null && rates.users[uid] ? (rates.users[uid][dow === 6 ? 'sat' : dow === 0 ? 'sun' : 'wd'] || rates.users[uid].all) : null);
          if (crate != null) diag.fromRates++; else if (r != null) diag.fromHistory++;
          if (r == null) days[dk].unpriced++;
          days[dk].cost[g] += hrsPaid * (r != null ? r : avg[g]);
          if (detail) detail.push({ day: dk, name: nm, g: g, start: tzParts(a, RO_TZ).hour + ':' + tzParts(a, RO_TZ).minute, end: tzParts(b, RO_TZ).hour + ':' + tzParts(b, RO_TZ).minute,
            hours: Math.round(hrsPaid * 100) / 100, brk: Math.round(brkMin), rate: r != null ? r : avg[g], src: crate != null ? 'Connecteam pay rate' + (sh.jobId != null && cr.res[sh.jobId] != null ? ' (job)' : '') + (load !== 1 ? ' \u00d7 ' + load.toFixed(2) + ' ' + wk : '') : (r != null ? 'recent average' : 'group average'),
            cost: Math.round(hrsPaid * (r != null ? r : avg[g]) * 100) / 100, published: sh.isPublished !== false, raw: JSON.stringify(sh).slice(0, 400) });
          const q = tzParts(b, RO_TZ), hm = (x) => x.hour + ':' + x.minute;
          days[dk].shifts.push({ name: nm, g: g, in: hm(p0), out: hm(q), brk: Math.round(brkMin), published: sh.isPublished !== false, open: uid == null || !!sh.isOpenShift });
        }
      }
      if (list.length < 500) break;
      off += 500;
    }
  }
  const out = roWeekDays(mon).map((d) => {
    const x = days[d];
    x.cost = { foh: Math.round(x.cost.foh), kit: Math.round(x.cost.kit) };
    x.shifts.sort((p, q) => (p.in < q.in ? -1 : p.in > q.in ? 1 : 0));
    return x;
  });
  diag.payRates = pr.diag;
  return { week: mon, days: out, diag: diag, builtAt: new Date().toISOString() };
}
async function roSettings(env) {
  let st = {};
  try { st = JSON.parse(await env.TOKENS.get('ro:settings')) || {}; } catch (e) {}
  st.forecast = st.forecast || {};
  if (!st.seeded) { st.forecast['2026-10-26'] = 26000; st.seeded = true; }   /* owner, 21 Oct 2026: $26,000 net for w/c 26 Oct */
  st.budget = st.budget || {};
  /* owner, 21 Oct 2026: front-of-house wages as % of net sales - normal weeks 24%, school holidays 21%, summer holidays 20% */
  if (!st.budget.foh) st.budget.foh = { normal: 24, school: 21, summer: 20 };
  if (st.budget.weekCap === undefined) st.budget.weekCap = null;
  st.weekType = st.weekType || {};
  st.file = forecastFile;   /* owner's forecast + wages budget file (read-only, not stored in KV) */
  return st;
}


/* Owner-only check page: every scheduled shift with hours, break, rate and cost, to compare with Connecteam. */
async function rosterCostCheckPage(env, url) {
  const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let mon = url.searchParams.get('start') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mon)) { const t = ctTodayMel(); mon = addDay(t, -((new Date(t + 'T12:00:00Z').getUTCDay() + 6) % 7) + 7); }
  const det = [];
  let body;
  try {
    const r = await roScheduled(env, mon, det);
    const tot = det.reduce((t, x) => t + x.cost, 0), hrs = det.reduce((t, x) => t + x.hours, 0);
    body = '<h1>Roster cost check</h1><p>Week starting ' + esc(mon) + ' · ' + det.length + ' shifts · ' + hrs.toFixed(2) + ' paid hours · <b>$' + tot.toFixed(2) + '</b></p>'
      + '<p class="m">Weekend loadings: casuals \u00d71.2 Sat and Sun; Hattie \u00d71.4 Sun; Tyler and Michael base rate.<br>Pay rates from Connecteam: ' + esc(JSON.stringify(r.diag.payRates)) + '<br>Shift fields: ' + esc(r.diag.shiftKeys) + '</p>'
      + '<table><tr><th>Day</th><th>Name</th><th>Shift</th><th>Break</th><th>Paid h</th><th>Rate</th><th>From</th><th>Cost</th></tr>'
      + det.map((x) => '<tr><td>' + esc(x.day.slice(5)) + '</td><td>' + esc(x.name) + (x.published ? '' : ' (draft)') + '</td><td>' + esc(x.start + '–' + x.end) + '</td><td>' + (x.brk || '') + '</td><td>' + x.hours.toFixed(2) + '</td><td>$' + Number(x.rate).toFixed(2) + '</td><td>' + esc(x.src) + '</td><td>$' + x.cost.toFixed(2) + '</td></tr>').join('')
      + '</table><details><summary>Raw shift data (first 400 characters each)</summary><pre>' + det.map((x) => esc(x.raw)).join('\n') + '</pre></details>';
  } catch (e) { body = '<h1>Couldn’t read the roster</h1><p>' + esc(e.message) + '</p>'; }
  return htmlResponse('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Roster cost check</title><style>body{margin:0;padding:1rem;background:#FDF7EE;font-family:system-ui,sans-serif;color:#2A2420}h1{font-size:20px}p{font-size:14px}.m{font-size:12px;color:#8C8075;word-break:break-all}table{border-collapse:collapse;font-size:13px;width:100%}td,th{padding:5px 4px;border-bottom:1px solid rgba(0,0,0,.08);text-align:left;white-space:nowrap}pre{font-size:11px;white-space:pre-wrap;word-break:break-all}</style></head><body>' + body + '</body></html>');
}
/* --- manager password (separate from the owner's dashboard password) --- */
async function roManagerLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'rs_session'), 'r1');
}
async function roLoginPage(env, team) {
  const set = !!(await env.TOKENS.get('sys:roster_pass_hash'));
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bainz rostering</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FDF7EE;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#FFFBF5;border:1px solid rgba(107,26,26,.12);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;color:#6B1A1A;margin:0 0 .4rem}p{font-size:14px;color:#8C8075;line-height:1.6;margin:0 0 1.2rem}'
    + 'input{width:100%;font:inherit;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,.14);border-radius:10px;box-sizing:border-box}'
    + 'button{margin-top:12px;width:100%;font:inherit;font-weight:500;font-size:15px;padding:12px;border:0;border-radius:10px;background:#6B1A1A;color:#FDF7EE;cursor:pointer}.err{color:#6B1A1A;font-size:13px;min-height:1.2em;margin-top:8px}</style></head><body><div class="box">'
    + '<h1>' + (team ? 'Bainz team' : 'Bainz rostering') + '</h1>'
    + (set
      ? '<p>' + (team ? 'Enter the manager password for Wages and New staff.' : 'Enter the rostering password.') + '</p><input id="p" type="password" autocomplete="current-password"><button id="b">Sign in</button><div class="err" id="e"></div>'
        + '<script>function go(){fetch("/api/roster/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})}).then(function(r){if(r.ok)location.reload();else document.getElementById("e").textContent="That password didn’t work.";});}'
        + 'document.getElementById("b").onclick=go;document.getElementById("p").onkeydown=function(e){if(e.key==="Enter")go();};</script>'
      : '<p>No manager password has been set yet. Linda sets it on the Wages page while signed in to the dashboard.</p>')
    + '</div></body></html>';
}

async function rosterRoute(env, request, url, path, ownerIn) {
  const managerIn = ownerIn ? false : await roManagerLoggedIn(request, env);
  const allowed = ownerIn || managerIn;
  if (path === '/roster') return htmlResponse(allowed ? rosterHtml : await roLoginPage(env));
  if (path === '/api/roster/login' && request.method === 'POST') {
    const stored = await env.TOKENS.get('sys:roster_pass_hash');
    let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
    const pass = String((body && body.passcode) || '');
    const dot = stored ? stored.indexOf('.') : -1;
    if (!stored || !timingSafeEqual(await pbkdf2B64(pass, stored.slice(0, dot)), stored.slice(dot + 1))) return json({ ok: false }, 401);
    const token = await makeSession(env, 'r1');
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'rs_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
  }
  if (path === '/api/roster/logout' && request.method === 'POST') {
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'rs_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
  }
  if (!allowed) return json({ error: 'auth' }, 401);
  if (path === '/api/roster/me' && request.method === 'GET') {
    return json({ owner: !!ownerIn, managerPasswordSet: !!(await env.TOKENS.get('sys:roster_pass_hash')), firstWeek: RO_FIRST_WEEK, today: ctTodayMel() });
  }
  if (path === '/api/roster/password' && request.method === 'POST') {
    if (!ownerIn) return json({ ok: false }, 403);
    let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
    const pass = String((body && body.passcode) || '');
    if (pass.length < 6) return json({ ok: false, error: 'too_short' }, 400);
    const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
    const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
    await env.TOKENS.put('sys:roster_pass_hash', saltHex + '.' + (await pbkdf2B64(pass, saltHex)));
    return json({ ok: true });
  }
  if (path === '/api/roster/settings' && request.method === 'GET') return json(await roSettings(env));
  if (path === '/api/roster/settings' && request.method === 'POST') {
    let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
    const st = await roSettings(env);
    const num = (v) => (v === '' || v == null) ? null : (isFinite(+v) && +v >= 0 ? +v : undefined);
    if (body.forecast && typeof body.forecast === 'object') {   /* manager and owner can enter forecasts */
      for (const [wk, v] of Object.entries(body.forecast)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(wk) || new Date(wk + 'T12:00:00Z').getUTCDay() !== 1) continue;
        const n = num(v); if (n === undefined) continue;
        if (n == null) delete st.forecast[wk]; else st.forecast[wk] = Math.round(n);
      }
    }
    if (body.weekType && typeof body.weekType === 'object') {
      for (const [wk, v] of Object.entries(body.weekType)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(wk)) continue;
        if (['normal', 'school', 'summer'].includes(v)) st.weekType[wk] = v;
      }
    }
    if (body.budget && ownerIn) {   /* budget: owner only */
      const c = num(body.budget.weekCap);
      if (c !== undefined) st.budget.weekCap = c;
      if (body.budget.foh) for (const k of ['normal', 'school', 'summer']) { const v = num(body.budget.foh[k]); if (v !== undefined && v != null) st.budget.foh[k] = v; }
    }
    const file = st.file; delete st.file;
    await env.TOKENS.put('ro:settings', JSON.stringify(st));
    st.file = file;
    return json(st);
  }
  if (path === '/api/roster/scheduled' && request.method === 'GET') {
    const mon = url.searchParams.get('start') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(mon) || new Date(mon + 'T12:00:00Z').getUTCDay() !== 1) return json({ error: 'bad week' }, 400);
    if (!env.ROSTERING_API_TOKEN) return json({ error: 'Connecteam not connected' }, 400);
    try { return json(await roScheduled(env, mon)); }
    catch (e) { return json({ error: 'Connecteam: ' + ((e && e.message) || 'failed') }, 502); }
  }
  if (path === '/api/roster/week' && request.method === 'GET') {
    const mon = url.searchParams.get('start') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(mon) || new Date(mon + 'T12:00:00Z').getUTCDay() !== 1 || mon < RO_FIRST_WEEK) return json({ error: 'bad week' }, 400);
    if (addDay(mon, 6) >= ctTodayMel()) return json({ error: 'week not finished' }, 400);
    try {
      return json(await roWeek(env, mon, url.searchParams.get('refresh') === '1'));   /* owner or manager can refresh (28 Oct 2026) */
    } catch (e) {
      return json({ error: (e && e.message) || 'failed' }, 502);
    }
  }
  return json({ error: 'not found' }, 404);
}

/* ----------------------------------------------------------------------------
   New starter onboarding (28 Oct 2026)
   OWNER DECISIONS (Linda, 28 Oct 2026):
   - Each new starter gets their own link (/join/<code>) made on /staff, with
     their role (front of house or kitchen). RSA question shows for FOH only.
   - On submit: a DRAFT-READY employee is created in Xero Payroll AU:
     EMPLOYEE, SALARYANDWAGES (WORKINGHOLIDAYMAKER for 417/462), CASUAL,
     weekly pay calendar, ordinary earnings rate "Weekday rate", regular tax
     scale (foreign / WHM scales where they apply), start date = 14 days
     before the form was sent, classification and employee group empty,
     leave / payslip / pay template left alone. Bank: statement text
     "BAINZ WAGES", remainder account. Super fund matched or added by USI.
   - Holiday group (Victoria) and emergency contact are not in Xero's API:
     Linda sets the holiday group by hand; the emergency contact is in Drive.
   - Everything (record as a Google Doc, signature, ID, visa, certificates)
     goes to Google Drive > "Bainz Staff Records" > "Surname, First name".
     TFN and bank number are masked in Drive when Xero has them; if Xero
     fails they are written in full so Linda can enter them by hand.
   - Nothing sensitive is kept in Cloudflare: KV holds only the link, name,
     role and the Xero / Drive outcome.
---------------------------------------------------------------------------- */
const PAYROLL_API = 'https://api.xero.com/payroll.xro/1.0';
const GAPI = 'https://www.googleapis.com';
const OB_ROOT_NAME = 'Bainz Staff Records';
const OB_LINK_DAYS = 30;
const OB_STATEMENT = 'BAINZ WAGES';
const OB_NOTIFY = 'hello@bainz.au';   /* completion emails go here (owner, 28 Oct 2026) */
/* USI: 3 letters + 4 digits + 2 letters (e.g. HOS0100AU), or the fund's 11-digit ABN + 3 digits */
const OB_USI = /^([A-Za-z]{3}\d{4}[A-Za-z]{2}|\d{14})$/;
const OB_DOCS = {
  fwis: { title: 'Fair Work Information Statement', url: 'https://www.fairwork.gov.au/sites/default/files/migration/724/Fair-Work-Information-Statement.pdf' },
  ceis: { title: 'Casual Employment Information Statement', url: 'https://www.fairwork.gov.au/sites/default/files/migration/724/casual-employment-information-statement.pdf' },
  ohs: { title: 'Bainz OHS induction (in the form)', url: '' },
  true: { title: 'Tax file number declaration: the information given is true and correct', url: '' }
};

function obCode() {
  const a = new Uint8Array(18); crypto.getRandomValues(a);
  return btoa(String.fromCharCode.apply(null, a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function obEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function obMelDate(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
function obMelStamp(d) { return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Melbourne', dateStyle: 'long', timeStyle: 'short' }).format(d); }
function obTfnValid(t) {
  t = String(t || '').replace(/\D/g, '');
  if (!/^\d{8,9}$/.test(t)) return false;
  const w = t.length === 9 ? [1, 4, 3, 7, 5, 8, 6, 9, 10] : [10, 7, 8, 4, 6, 3, 5, 1];
  return t.split('').reduce((s, d, i) => s + Number(d) * w[i], 0) % 11 === 0;
}

/* fetch with the stored OAuth token for a source, one forced refresh on 401 */
async function obAuthed(env, source, url, init) {
  const go = async () => {
    const h = new Headers((init && init.headers) || {});
    h.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
    return fetch(url, { ...(init || {}), headers: h });
  };
  let r = await go();
  if (r.status === 401) {
    const t = await getTokens(env, source);
    if (t) { t.expires_at = 0; await saveTokens(env, source, t); }
    r = await go();
  }
  return r;
}

/* ---- Xero Payroll AU ---- */
function obXeroMsg(b, status) {
  const msgs = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (Array.isArray(o.ValidationErrors)) o.ValidationErrors.forEach((v) => { if (v && v.Message) msgs.push(String(v.Message)); });
    for (const k of Object.keys(o)) if (k !== 'ValidationErrors') walk(o[k]);
  };
  walk(b);
  if (!msgs.length && b && typeof b.Message === 'string') msgs.push(b.Message);
  if (!msgs.length && b && typeof b.Detail === 'string') msgs.push(b.Detail);
  return ([...new Set(msgs)].join(' · ') || ('Xero said no (' + status + ')')).slice(0, 400);
}
async function obXpay(env, tenantId, path, init) {
  const headers = { 'xero-tenant-id': tenantId, 'Accept': 'application/json' };
  if (init && init.body) headers['Content-Type'] = 'application/json';
  const r = await obAuthed(env, 'accounting', PAYROLL_API + path, { ...(init || {}), headers });
  const text = await r.text();
  let b = null; try { b = JSON.parse(text); } catch (e) {}
  if (!r.ok) { const e = new Error(obXeroMsg(b, r.status)); e.status = r.status; throw e; }
  return b || {};
}
function obXDate(ymd) { return ymd + 'T00:00:00'; }

async function obCreateInXero(env, d, submittedAt) {
  const t = await xeroTenant(env, makeHelpers(env, 'accounting'));
  const [cals, items, funds] = await Promise.all([
    obXpay(env, t.id, '/PayrollCalendars'),
    obXpay(env, t.id, '/PayItems'),
    obXpay(env, t.id, '/SuperFunds')
  ]);
  const notes = [];
  /* OWNER DECISION 28 Oct 2026: the pay calendar is "Weekly - Jenik Hospitality"
     (the org also has two older calendars just called "Weekly"). */
  const weekly = (cals.PayrollCalendars || []).filter((c) => c.CalendarType === 'WEEKLY');
  const cal = weekly.find((c) => /jenik|bainz/i.test(c.Name || '')) || weekly[0];
  if (!cal) notes.push('No weekly pay calendar found: set the pay calendar by hand');
  const rates = ((items.PayItems && items.PayItems.EarningsRates) || []);
  const rate = rates.find((r) => /^weekday/i.test(r.Name || '')) || rates.find((r) => /weekday/i.test(r.Name || ''));
  if (!rate) notes.push('No earnings rate called "Weekday rate": set the ordinary earnings rate by hand');

  const usi = String(d.super.usi || '').replace(/\s/g, '').toUpperCase();
  let fund = (funds.SuperFunds || []).find((f) => String(f.USI || '').replace(/\s/g, '').toUpperCase() === usi);
  if (!fund && usi) {
    try {
      const r = await obXpay(env, t.id, '/SuperFunds', { method: 'POST', body: JSON.stringify([{ Type: 'REGULATED', USI: usi }]) });
      fund = (r.SuperFunds || [])[0];
    } catch (e) { notes.push('Super fund USI ' + usi + ' was not accepted (' + e.message + '): add the super membership by hand'); }
  }

  const res = d.tax.residency;
  const whm = res === 'WORKINGHOLIDAYMAKER';
  const foreign = res === 'FOREIGNRESIDENT';
  const tax = {
    EmploymentBasis: 'CASUAL',
    TaxScaleType: whm ? 'WORKINGHOLIDAYMAKER' : foreign ? 'FOREIGN' : 'REGULAR',
    TaxFreeThresholdClaimed: !whm && !foreign && !!d.tax.claimTaxFreeThreshold,
    HasLoanOrStudentDebt: !!d.tax.studyTrainingLoan
  };
  if (!whm) { tax.ResidencyStatus = foreign ? 'FOREIGNRESIDENT' : 'AUSTRALIANRESIDENT'; tax.AustralianResidentForTaxPurposes = !foreign; }
  if (d.tax.tfnMode === 'provided') tax.TaxFileNumber = String(d.tax.tfn).replace(/\D/g, '');
  else tax.TFNExemptionType = { applied: 'PENDING', under18: 'UNDER18', pension: 'PENSIONER' }[d.tax.tfnMode] || 'NOTQUOTED';

  const start = obMelDate(new Date(submittedAt.getTime() - 14 * 86400000));
  const p = d.personal;
  const emp = {
    FirstName: p.firstName, LastName: p.lastName,
    DateOfBirth: obXDate(p.dateOfBirth),
    StartDate: obXDate(start),
    Email: p.email, Mobile: p.phone,
    HomeAddress: { AddressLine1: p.address.line1, City: p.address.city, Region: p.address.region, PostalCode: p.address.postalCode, Country: 'AUSTRALIA' },
    JobTitle: d.role === 'kitchen' ? 'Kitchen' : 'Front of house',
    EmploymentType: 'EMPLOYEE',
    IncomeType: whm ? 'WORKINGHOLIDAYMAKER' : 'SALARYANDWAGES',
    TaxDeclaration: tax,
    BankAccounts: [{ StatementText: OB_STATEMENT, AccountName: d.bank.accountName, BSB: d.bank.bsb, AccountNumber: d.bank.accountNumber, Remainder: true }]
  };
  if (p.gender && /^[MFIN]$/.test(p.gender)) emp.Gender = p.gender;
  if (whm && d.tax.countryOfResidence) emp.CountryOfResidence = d.tax.countryOfResidence;
  if (cal) emp.PayrollCalendarID = cal.PayrollCalendarID;
  if (rate) emp.OrdinaryEarningsRateID = rate.EarningsRateID;
  if (fund && fund.SuperFundID) emp.SuperMemberships = [{ SuperFundID: fund.SuperFundID, EmployeeNumber: d.super.memberNumber }];

  const r = await obXpay(env, t.id, '/Employees', { method: 'POST', body: JSON.stringify([emp]) });
  const e = (r.Employees || [])[0];
  if (!e || !e.EmployeeID) throw new Error('Xero did not send back the new employee');
  notes.push('Set by hand in Xero: holiday group Victoria, classification, pay template');
  return { employeeId: e.EmployeeID, startDate: start, notes };
}

/* ---- Google Drive (drive.file scope) ---- */
async function obG(env, url, init) {
  const r = await obAuthed(env, 'drive', url, init);
  let b = null; try { b = await r.json(); } catch (e) {}
  if (!r.ok) {
    const e = new Error('Google Drive said no (' + r.status + ')' + (b && b.error && b.error.message ? ': ' + b.error.message : ''));
    e.status = r.status; throw e;
  }
  return b || {};
}
async function obFolder(env, name, parent) {
  return obG(env, GAPI + '/drive/v3/files?fields=id,webViewLink', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parent ? { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] } : { name, mimeType: 'application/vnd.google-apps.folder' })
  });
}
async function obRoot(env) {
  const id = await env.TOKENS.get('drive:root');
  if (id) {
    try { const f = await obG(env, GAPI + '/drive/v3/files/' + id + '?fields=id,trashed'); if (!f.trashed) return id; } catch (e) {}
  }
  const f = await obFolder(env, OB_ROOT_NAME);
  await env.TOKENS.put('drive:root', f.id);
  return f.id;
}
/* binary files: create the entry, then stream the bytes in (no copying in the Worker) */
async function obPutFile(env, parent, name, file) {
  const type = file.type || 'application/octet-stream';
  const meta = await obG(env, GAPI + '/drive/v3/files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parent], mimeType: type })
  });
  await obG(env, GAPI + '/upload/drive/v3/files/' + meta.id + '?uploadType=media&fields=id', {
    method: 'PATCH', headers: { 'Content-Type': type }, body: file
  });
  return meta.id;
}
/* the record: HTML converted to a Google Doc in one small multipart upload */
async function obPutDoc(env, parent, name, html) {
  const b = 'bainz' + obCode().replace(/[^A-Za-z0-9]/g, '');
  const body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'
    + JSON.stringify({ name, parents: [parent], mimeType: 'application/vnd.google-apps.document' })
    + '\r\n--' + b + '\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + html + '\r\n--' + b + '--';
  const f = await obG(env, GAPI + '/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body
  });
  return f;
}

function obRecordHtml(d, ctx) {
  const masked = ctx.xeroOk;
  d.tax = d.tax || {}; d.bank = d.bank || { bsb: '', accountNumber: '' }; d.super = d.super || {};
  const tfnText = d.tax.tfnMode === 'provided'
    ? (masked ? '••• ••• ' + String(d.tax.tfn).slice(-3) + ' (full number is in Xero)' : String(d.tax.tfn))
    : ({ applied: 'Not given: has applied for one (must be given within 28 days)', under18: 'Not given: under 18 exemption', pension: 'Not given: pension or benefit exemption' }[d.tax.tfnMode]);
  const accText = masked ? '••••' + String(d.bank.accountNumber).slice(-3) + ' (full number is in Xero)' : String(d.bank.accountNumber);
  const resText = { AUSTRALIANRESIDENT: 'Australian resident for tax purposes', FOREIGNRESIDENT: 'Foreign resident', WORKINGHOLIDAYMAKER: 'Working holiday maker' + (d.tax.countryOfResidence ? ' (passport country ' + d.tax.countryOfResidence + ')' : '') }[d.tax.residency];
  const wr = { citizen: 'Australian citizen', pr: 'Permanent resident (incl. NZ citizen)', visa: 'Visa holder' }[d.workRights.status] || '';
  const g = { M: 'Male', F: 'Female', I: 'Non-binary / gender diverse', N: 'Not stated' }[d.personal.gender] || 'Not stated';
  const row = (k, v) => '<tr><td style="padding:4px 12px 4px 0;color:#8C4A44;vertical-align:top">' + obEsc(k) + '</td><td style="padding:4px 0">' + obEsc(v) + '</td></tr>';
  const sec = (t, rows) => '<h2 style="color:#6B1A1A;font-size:14pt;margin:18pt 0 6pt">' + obEsc(t) + '</h2><table>' + rows.join('') + '</table>';
  const p = d.personal;
  return '<html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;font-size:11pt;color:#2A1512">'
    + '<h1 style="color:#6B1A1A;font-size:20pt">Onboarding record: ' + obEsc(p.firstName + ' ' + p.lastName) + '</h1>'
    + '<p>Jenik Hospitality Pty Ltd trading as Bainz · ABN 16 683 661 314<br>Submitted ' + obEsc(obMelStamp(ctx.submittedAt)) + ' (Melbourne time) through the Bainz new starter form.</p>'
    + (d.existing ? sec('Current employee', [row('Form type', 'Records update for an existing employee. Tax, super and bank details are already in Xero and were not collected.')]) : sec('Xero', [
      row('Employee created', ctx.xeroOk ? 'Yes' : 'NO: enter this person by hand'),
      ctx.xeroOk ? row('Start date set in Xero', ctx.startDate) : row('Xero error', ctx.xeroError || ''),
      row('Still to do by hand', 'Holiday group Victoria, classification, pay template, emergency contact (if wanted in Xero)')
    ]))
    + (d.existing ? sec('Employment', [row('Role', d.role === 'kitchen' ? 'Kitchen' : 'Front of house')]) : sec('Employment', [row('Role', d.role === 'kitchen' ? 'Kitchen' : 'Front of house'), row('Basis', 'Casual employee'), row('Pay', 'Weekly, salary and wages'), row('Award', 'Restaurant Industry Award 2020 (MA000119)')]))
    + sec('Personal details', [
      row('Name', p.firstName + ' ' + p.lastName), row('Date of birth', p.dateOfBirth), row('Gender', g),
      row('Address', [p.address.line1, p.address.city, p.address.region, p.address.postalCode].join(', ')),
      row('Mobile', p.phone), row('Email', p.email)
    ])
    + sec('Health declaration (WIRC Act 2013 s41) - confidential', [
      row('Duties shown to them', (d.health && d.health.duties || []).join('; ')),
      row('Pre-existing injury or condition that could be affected', d.health && d.health.disclosed ? 'YES' : 'No'),
      ...(d.health && d.health.disclosed ? [row('Details', d.health.detail), row('Help they asked for', d.health.help || 'None given')] : []),
      row('Emergency medical note', (d.health && d.health.emergencyNote) || 'None given'),
      row('Section 41 statement', d.existing ? 'Not shown (already employed before this form; section 41 applies only before employment starts)' : 'Shown in full and acknowledged before submitting (' + obMelStamp(ctx.submittedAt) + ')')
    ])
    + sec('Emergency contact', [row('Name', d.emergencyContact.name), row('Relationship', d.emergencyContact.relationship), row('Phone', d.emergencyContact.phone), row('Email', d.emergencyContact.email || 'Not given')])
    + (d.existing ? '' : sec('Tax file number declaration', [
      row('Tax file number', tfnText), row('Residency', resText),
      row('Claims tax-free threshold from Bainz', d.tax.claimTaxFreeThreshold ? 'Yes' : 'No'),
      row('Study or training loan', d.tax.studyTrainingLoan ? 'Yes' : 'No'),
      row('Tax scale', d.tax.residency === 'WORKINGHOLIDAYMAKER' ? 'Working holiday maker' : d.tax.residency === 'FOREIGNRESIDENT' ? 'Foreign resident' : 'Regular')
    ])
    + sec('Super', [row('Fund', d.super.fundName), row('USI', d.super.usi), row('Member number', d.super.memberNumber)])
    + sec('Bank', [row('Account name', d.bank.accountName), row('BSB', d.bank.bsb.slice(0, 3) + '-' + d.bank.bsb.slice(3)), row('Account number', accText), row('Statement text', OB_STATEMENT)]))
    + sec('Right to work', [
      row('Status', wr + (d.workRights.visaSubclass ? ', subclass ' + d.workRights.visaSubclass : '') + (d.workRights.visaExpiry ? ', expires ' + d.workRights.visaExpiry : '')),
      row('VEVO check', d.workRights.status === 'visa' ? 'TO DO before the first shift: check VEVO and save the result in this folder' : 'Not needed'),
      row('Files in this folder', (ctx.files || []).join(', ') || 'None')
    ])
    + (d.role === 'kitchen' ? '' : sec('RSA', [row('RSA', d.rsa === 'have' ? 'Has a current Victorian RSA (bring certificate to first shift)' : 'Does not hold one yet; agrees to hold a current Victorian RSA as a condition of employment and to complete the course when asked')]))
    + sec('Documents given and acknowledged', (d.acknowledged || []).map((k) => {
      const doc = OB_DOCS[k]; if (!doc) return '';
      const title = (k === 'true' && d.existing) ? 'The information given is true and correct' : doc.title;
      return row('✓ ' + title, doc.url || 'Acknowledged ' + obMelStamp(ctx.submittedAt));
    }))
    + '<h2 style="color:#6B1A1A;font-size:14pt;margin:18pt 0 6pt">Declaration and signature</h2>'
    + '<p>I declare that the information I have given is true and correct.</p>'
    + (ctx.sigDataUrl ? '<p><img src="' + ctx.sigDataUrl + '" width="300" alt="signature"></p>' : '')
    + '<p>Signed by ' + obEsc(p.firstName + ' ' + p.lastName) + ' on ' + obEsc(obMelStamp(ctx.submittedAt)) + '. The signature image is also saved in this folder.</p>'
    + '<p style="color:#8C4A44;font-size:9pt">Device: ' + obEsc(ctx.ua || '') + '</p>'
    + '<p style="color:#8C4A44;font-size:9pt">Keep for 7 years after employment ends (Fair Work record keeping).</p>'
    + '</body></html>';
}

function obValidate(d, existing) {
  const bad = [];
  const p = d && d.personal || {};
  if (!p.firstName || !p.lastName) bad.push('name');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dateOfBirth || '')) bad.push('date of birth');
  else {
    /* OWNER DECISION 28 Oct 2026: no one under 15 (Melbourne date) */
    const [y, m, dd] = p.dateOfBirth.split('-').map(Number);
    const [ty, tm, td] = obMelDate(new Date()).split('-').map(Number);
    const age = ty - y - ((tm < m || (tm === m && td < dd)) ? 1 : 0);
    if (age < 15) bad.push('age (Bainz employs people aged 15 and over only)');
  }
  if (!p.address || !p.address.line1 || !/^\d{4}$/.test(p.address.postalCode || '')) bad.push('address');
  if (!p.email || !p.phone) bad.push('contact');
  const h = d.health || {};
  if (typeof h.disclosed !== 'boolean' || !h.acknowledged || (h.disclosed && !String(h.detail || '').trim())) bad.push('health declaration');
  const ec = d.emergencyContact || {};
  if (!ec.name || !ec.relationship || !ec.phone) bad.push('emergency contact');
  const t = d.tax || {};
  if (!existing) {
  if (t.tfnMode === 'provided' && !obTfnValid(t.tfn)) bad.push('tax file number');
  if (!['AUSTRALIANRESIDENT', 'FOREIGNRESIDENT', 'WORKINGHOLIDAYMAKER'].includes(t.residency)) bad.push('residency');
  if (t.residency === 'WORKINGHOLIDAYMAKER' && !/^[A-Z]{2}$/.test(t.countryOfResidence || '')) bad.push('passport country');
  const s = d.super || {};
  if (!s.fundName || !OB_USI.test(String(s.usi || '').replace(/\s/g, '')) || !s.memberNumber) bad.push('super');
  const b = d.bank || {};
  if (!b.accountName || !/^\d{6}$/.test(b.bsb || '') || !/^\d{5,9}$/.test(b.accountNumber || '')) bad.push('bank');
  }
  if (!['citizen', 'pr', 'visa'].includes((d.workRights || {}).status)) bad.push('work rights');
  const need = ['fwis', 'ceis', 'ohs', 'true'];
  if (!need.every((k) => (d.acknowledged || []).includes(k))) bad.push('acknowledgements');
  return bad;
}

const OB_FILES = [['idFile', 'Photo ID'], ['visaFile', 'Visa grant'], ['foodFile', 'Food handler certificate']];

async function obSubmit(env, request, code) {
  const link = await env.TOKENS.get('join:' + code, 'json');
  if (!link) return json({ ok: false, error: 'This link has expired. Ask Linda for a new one.' }, 410);
  if (link.status === 'done') return json({ ok: false, error: 'This form has already been sent. Ask Linda if something needs changing.' }, 409);
  let form; try { form = await request.formData(); } catch (e) { return json({ ok: false, error: 'The form did not arrive in one piece. Try again.' }, 400); }
  let d; try { d = JSON.parse(String(form.get('data') || '')); } catch (e) { return json({ ok: false, error: 'The form did not arrive in one piece. Try again.' }, 400); }
  d.role = link.role === 'kitchen' ? 'kitchen' : 'foh';
  /* OWNER DECISION 28 Oct 2026: current staff get the same form without tax,
     super and bank (already in Xero); nothing is created in Xero for them. */
  const existing = link.mode === 'existing';
  d.existing = existing;
  const bad = obValidate(d, existing);
  if (bad.length) return json({ ok: false, error: 'Please check: ' + bad.join(', ') + '.' }, 400);

  const submittedAt = new Date();
  const name = d.personal.firstName + ' ' + d.personal.lastName;
  const out = { id: obCode().slice(0, 12), code, name, email: link.email || d.personal.email || '', xeroLinkId: link.xeroId || '', role: d.role, existing, submittedAt: submittedAt.toISOString(), xero: { ok: false }, drive: { ok: false } };

  /* 1. Xero (new starters only) */
  if (existing) out.xero = { ok: true, skipped: true };
  else try {
    const x = await obCreateInXero(env, d, submittedAt);
    out.xero = { ok: true, employeeId: x.employeeId, startDate: x.startDate, notes: x.notes };
  } catch (e) {
    out.xero = { ok: false, error: (e && e.message) || 'failed' };
  }

  /* 2. Drive */
  try {
    const root = await obRoot(env);
    /* OWNER DECISION 28 Oct 2026: one folder per person named "First Last",
       and every file inside starts with their name: "First Last - Photo ID.jpg" */
    const folder = await obFolder(env, name, root);
    const saved = [];
    const sig = form.get('signature');
    let sigDataUrl = '';
    if (sig && typeof sig === 'object' && sig.size) {
      await obPutFile(env, folder.id, name + ' - Signature.png', sig);
      saved.push(name + ' - Signature.png');
      if (sig.size < 200000) {
        const bytes = new Uint8Array(await sig.arrayBuffer());
        let bin = ''; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        sigDataUrl = 'data:image/png;base64,' + btoa(bin);
      }
    }
    for (const [field, label] of OB_FILES) {
      const f = form.get(field);
      if (f && typeof f === 'object' && f.size) {
        const ext = ((String(f.name || '').match(/\.[A-Za-z0-9]{2,5}$/) || [''])[0] || (f.type === 'application/pdf' ? '.pdf' : '.jpg')).toLowerCase();
        await obPutFile(env, folder.id, name + ' - ' + label + ext, f);
        saved.push(name + ' - ' + label + ext);
      }
    }
    await obPutDoc(env, folder.id, name + ' - Onboarding record', obRecordHtml(d, {
      submittedAt, xeroOk: out.xero.ok, xeroError: out.xero.error, startDate: out.xero.startDate,
      files: saved, sigDataUrl, ua: (request.headers.get('User-Agent') || '').slice(0, 160)
    }));
    out.drive = { ok: true, folderUrl: folder.webViewLink || ('https://drive.google.com/drive/folders/' + folder.id) };
  } catch (e) {
    out.drive = { ok: false, error: (e && e.message) || 'failed' };
  }

  if (existing && !out.drive.ok) {
    return json({ ok: false, error: 'Your details couldn’t be saved just now. Please try again in a few minutes, or tell Linda.' }, 502);
  }
  if (!out.xero.ok && !out.drive.ok) {
    /* nothing landed anywhere: keep the link open so they can send again */
    return json({ ok: false, error: 'Your details couldn’t be sent just now. Please try again in a few minutes, or tell Linda.' }, 502);
  }
  await env.TOKENS.put('sub:' + out.id, JSON.stringify(out));
  const idx = (await env.TOKENS.get('staff:index', 'json')) || [];
  idx.unshift(out.id);
  await env.TOKENS.put('staff:index', JSON.stringify(idx.slice(0, 300)));
  await env.TOKENS.put('join:' + code, JSON.stringify({ ...link, status: 'done', subId: out.id }), { expirationTtl: 90 * 86400 });
  try { await obNotifyOwner(env, out, d, new URL(request.url).origin); } catch (e) { /* the form is saved either way */ }
  return json({ ok: true });
}

async function obJoinRoute(env, request, url, path) {
  const m = /^\/(api\/)?join\/([A-Za-z0-9_-]{16,40})$/.exec(path);
  if (!m) return new Response('Not found', { status: 404 });
  const code = m[2];
  if (m[1]) {
    if (request.method !== 'POST') return json({ error: 'not found' }, 404);
    return obSubmit(env, request, code);
  }
  const link = await env.TOKENS.get('join:' + code, 'json');
  let state = 'open';
  if (!link) state = 'expired';
  else if (link.status === 'done') state = 'done';
  const boot = JSON.stringify({ state, role: (link && link.role) || 'foh', mode: (link && link.mode) || 'new', firstName: (link && link.firstName) || '', lastName: (link && link.lastName) || '', email: (link && link.email) || '' }).replace(/</g, '\\u003c');
  return htmlResponse(onboardHtml.replace('/*__BOOT__*/null', boot));
}

async function obStaffStatus(env) {
  const x = await getTokens(env, 'accounting');
  const g = await getTokens(env, 'drive');
  const idx = (await env.TOKENS.get('staff:index', 'json')) || [];
  const subs = [];
  for (const id of idx.slice(0, 40)) { const s = await env.TOKENS.get('sub:' + id, 'json'); if (s) subs.push(s); }
  const open = (await env.TOKENS.get('staff:links', 'json')) || [];
  const links = [];
  for (const l of open) {
    const v = await env.TOKENS.get('join:' + l.code, 'json');
    if (v && v.status !== 'done') links.push({ code: l.code, firstName: v.firstName, lastName: v.lastName || '', email: v.email || '', role: v.role, mode: v.mode || 'new', xeroId: v.xeroId || '', created: v.created });
  }
  return {
    xero: { connected: !!(x && x.access_token), payroll: !!(x && /payroll\.employees/.test(x.scope || '')) },
    drive: { connected: !!(g && g.refresh_token), mail: !!(g && g.refresh_token && /gmail\.send/.test(g.scope || '')), keysSet: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) },
    links, subs
  };
}

/* Gmail: one plain HTML email from the connected hello@bainz.au account */
function obB64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = ''; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function obStd64(s) { const b = obB64Url(s).replace(/-/g, '+').replace(/_/g, '/'); return b + '='.repeat((4 - b.length % 4) % 4); }
function obMimeWord(s) { return '=?UTF-8?B?' + obStd64(s) + '?='; }
async function obSendMail(env, to, subject, html) {
  const raw = [
    'To: ' + to,
    'Subject: ' + obMimeWord(subject),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    obStd64(html).replace(/(.{76})/g, '$1\r\n')
  ].join('\r\n');
  await obG(env, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: obB64Url(raw) })
  });
}

async function obSendInvite(env, to, firstName, link, role, existing) {
  const hi = firstName ? 'Hi ' + obEsc(firstName) + ',' : 'Hi,';
  if (existing) return obSendMail(env, to, 'Bainz: please update your staff details',
    '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#6B1A1A;background:#FDF7EE;padding:24px">'
    + '<p style="font-size:22px;font-weight:bold;margin:0 0 16px">Bainz.</p>'
    + '<p>' + hi + '</p>'
    + '<p>We\u2019re bringing everyone\u2019s staff records up to date. Please fill in this short form when you get a moment: your contact and emergency details, a quick health question, a photo of your ID, your certificates, and our safety induction to read and sign.</p>'
    + '<p>Your pay, tax and super details stay exactly as they are. You won\u2019t be asked for them.</p>'
    + '<p style="margin:24px 0"><a href="' + link + '" style="background:#6B1A1A;color:#FDF7EE;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">Update my details</a></p>'
    + '<p style="font-size:13px">Or copy this link: ' + link + '<br>The link is just for you and expires in ' + OB_LINK_DAYS + ' days.</p>'
    + '<p>Thanks!<br>Linda<br>Bainz \u00b7 4 Baines Crescent, Torquay</p></div>');
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#6B1A1A;background:#FDF7EE;padding:24px">'
    + '<p style="font-size:22px;font-weight:bold;margin:0 0 16px">Welcome to Bainz.</p>'
    + '<p>' + hi + '</p>'
    + '<p>Before your first shift, please fill in your new starter form. It takes about 10 minutes and covers your details, tax file number declaration, super, bank account and a short safety induction.</p>'
    + '<p>Have these handy: your tax file number, your bank BSB and account number, your super fund name, USI and member number, and a photo of your driver\u2019s licence or passport' + (role === 'kitchen' ? '' : ' (and your RSA if you have one)') + '.</p>'
    + '<p style="margin:24px 0"><a href="' + link + '" style="background:#6B1A1A;color:#FDF7EE;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">Open my form</a></p>'
    + '<p style="font-size:13px">Or copy this link: ' + link + '<br>The link is just for you and expires in ' + OB_LINK_DAYS + ' days.</p>'
    + '<p>See you soon,<br>Linda<br>Bainz \u00b7 4 Baines Crescent, Torquay</p></div>';
  const raw = [
    'To: ' + to,
    'Subject: ' + obMimeWord('Welcome to Bainz: your new starter form'),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    obStd64(html).replace(/(.{76})/g, '$1\r\n')
  ].join('\r\n');
  await obG(env, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: obB64Url(raw) })
  });
}

/* Owner-only: what Xero actually saved for an employee (TFN and bank masked) */
async function obEmployeeCheck(env, id) {
  const t = await xeroTenant(env, makeHelpers(env, 'accounting'));
  const r = await obXpay(env, t.id, '/Employees/' + encodeURIComponent(id));
  const e = (r.Employees || [])[0] || {};
  const mask = (o) => {
    if (Array.isArray(o)) return o.map(mask);
    if (o && typeof o === 'object') {
      const c = {};
      for (const k of Object.keys(o)) {
        if (/^(TaxFileNumber|AccountNumber|BSB)$/.test(k) && o[k]) c[k] = '•••' + String(o[k]).slice(-2);
        else c[k] = mask(o[k]);
      }
      return c;
    }
    return o;
  };
  const [cals, items] = await Promise.all([obXpay(env, t.id, '/PayrollCalendars'), obXpay(env, t.id, '/PayItems')]);
  return {
    employee: mask(e),
    calendars: (cals.PayrollCalendars || []).map((c) => ({ id: c.PayrollCalendarID, name: c.Name, type: c.CalendarType })),
    earningsRates: ((items.PayItems && items.PayItems.EarningsRates) || []).map((x) => ({ id: x.EarningsRateID, name: x.Name, type: x.EarningsType, rateType: x.RateType }))
  };
}

async function obNotifyOwner(env, out, d, origin) {
  const g = await getTokens(env, 'drive');
  if (!g || !/gmail\.send/.test(g.scope || '')) return;
  const todo = [];
  if (out.existing) todo.push('Current employee: records updated in Drive only (nothing changed in Xero).');
  else if (out.xero.ok) {
    todo.push('In Xero: set the holiday group to Victoria, the classification and the pay template.');
    for (const n of (out.xero.notes || [])) if (!/^Set by hand/.test(n)) todo.push(n);
  } else todo.push('Xero didn\u2019t take it (' + out.xero.error + '). Add them by hand using the record in Drive.');
  if (d.workRights && d.workRights.status === 'visa') todo.push('Visa holder (subclass ' + (d.workRights.visaSubclass || '?') + '): check VEVO before their first shift and save the result in their Drive folder.');
  if (d.health && d.health.disclosed) todo.push('They disclosed a pre-existing injury or condition. Read the health section of their record in Drive and talk to them about any adjustments.');
  if (d.role !== 'kitchen' && d.rsa === 'will') todo.push('No RSA yet: they\u2019ve agreed to get one when asked.');
  if (!out.drive.ok) todo.push('Drive didn\u2019t save (' + out.drive.error + '). Ask them to send their ID photos again.');
  const li = (t) => '<li style="margin:0 0 6px">' + obEsc(t) + '</li>';
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#6B1A1A;background:#FDF7EE;padding:24px">'
    + '<p style="font-size:20px;font-weight:bold;margin:0 0 12px">' + obEsc(out.name) + (out.existing ? ' updated their staff records' : ' sent their new starter form') + '</p>'
    + '<p>' + (d.role === 'kitchen' ? 'Kitchen' : 'Front of house') + (out.existing ? '' : ', casual') + '. Sent ' + obEsc(obMelStamp(new Date(out.submittedAt))) + '.</p>'
    + (out.existing ? '<p>' : '<p><b>Xero:</b> ' + (out.xero.ok ? 'added as an employee, start date ' + obEsc(out.xero.startDate) : 'NOT added') + '<br>')
    + '<b>Drive:</b> ' + (out.drive.ok ? '<a href="' + obEsc(out.drive.folderUrl) + '" style="color:#6B1A1A">open their folder</a>' : 'NOT saved') + '</p>'
    + '<p style="margin:16px 0 6px"><b>Still to do</b></p><ul style="padding-left:20px;margin:0">' + todo.map(li).join('') + '</ul>'
    + '<p style="margin-top:20px"><a href="' + origin + '/staff" style="color:#6B1A1A">Open New staff</a></p></div>';
  const raw = [
    'To: ' + OB_NOTIFY,
    'Subject: ' + obMimeWord((out.existing ? 'Staff records: ' + out.name + ' sent their form' : 'New starter: ' + out.name + ' sent their form') + (out.xero.ok && out.drive.ok ? '' : ' (needs a look)')),
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    obStd64(html).replace(/(.{76})/g, '$1\r\n')
  ].join('\r\n');
  await obG(env, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: obB64Url(raw) })
  });
}

/* OWNER DECISION 28 Oct 2026: the manager (rostering password, 'r1' session) can
   use New staff to email forms and see who has filled them in. Owner only: Drive
   file lists, the Xero employee check, removing records, and the connections. */
async function obStaffRoute(env, request, url, path, manager) {
  if (path === '/staff') return htmlResponse(staffHtml);
  if (manager && (path === '/api/staff/files' || path === '/api/staff/employee' || path === '/api/staff/remove')) return json({ error: 'owner only' }, 403);
  if (manager && path === '/api/staff' && request.method === 'GET') {
    const st = await obStaffStatus(env);
    return json({
      manager: true,
      xero: { connected: st.xero.connected, payroll: st.xero.payroll },
      drive: { connected: st.drive.connected, mail: st.drive.mail, keysSet: st.drive.keysSet },
      links: st.links,
      subs: st.subs.map((x) => ({ id: x.id, name: x.name, role: x.role, submittedAt: x.submittedAt,
        xero: { ok: !!(x.xero && x.xero.ok), startDate: x.xero && x.xero.startDate }, drive: { ok: !!(x.drive && x.drive.ok) } }))
    });
  }
  /* Current staff from Xero Payroll (active employees), with where each is up to */
  if (path === '/api/staff/team' && request.method === 'GET') {
    try {
      const t = await xeroTenant(env, makeHelpers(env, 'accounting'));
      const all = [];
      for (let page = 1; page <= 5; page++) {
        const r = await obXpay(env, t.id, '/Employees?page=' + page);
        const list = r.Employees || [];
        all.push(...list);
        if (list.length < 100) break;
      }
      const st = await obStaffStatus(env);
      const team = all.filter((e) => e.Status === 'ACTIVE' && e.EmploymentType !== 'CONTRACTOR').map((e) => {
        const email = String(e.Email || '').toLowerCase();
        const done = st.subs.find((x) => (x.xeroLinkId && x.xeroLinkId === e.EmployeeID) || (email && String(x.email || '').toLowerCase() === email) || (x.xero && x.xero.employeeId === e.EmployeeID));
        const open = st.links.find((l) => (l.xeroId && l.xeroId === e.EmployeeID) || (email && String(l.email || '').toLowerCase() === email));
        return { id: e.EmployeeID, firstName: e.FirstName || '', lastName: e.LastName || '', email: e.Email || '', jobTitle: e.JobTitle || '', state: done ? 'done' : open ? 'sent' : 'todo', when: done ? done.submittedAt : open ? open.created : '' };
      }).sort((a, b) => (a.firstName + a.lastName).localeCompare(b.firstName + b.lastName));
      return json({ team });
    } catch (e) { return json({ error: (e && e.message) || 'failed' }, 502); }
  }
  if (path === '/api/staff/files' && request.method === 'GET') {
    try {
      const sub = await env.TOKENS.get('sub:' + (url.searchParams.get('id') || ''), 'json');
      const fid = sub && sub.drive && sub.drive.folderUrl && (sub.drive.folderUrl.match(/folders\/([A-Za-z0-9_-]+)/) || [])[1];
      if (!fid) return json({ error: 'no folder' }, 404);
      const q = encodeURIComponent("'" + fid + "' in parents and trashed = false");
      const r = await obG(env, GAPI + '/drive/v3/files?q=' + q + '&fields=files(id,name,mimeType,size,webViewLink,createdTime)');
      const root = await env.TOKENS.get('drive:root');
      let rootInfo = null; try { rootInfo = await obG(env, GAPI + '/drive/v3/files/' + root + '?fields=id,name,parents,webViewLink,owners(emailAddress)'); } catch (e) {}
      return json({ folder: sub.drive.folderUrl, root: rootInfo, files: r.files || [] });
    } catch (e) { return json({ error: (e && e.message) || 'failed' }, 502); }
  }
  if (path === '/api/staff/employee' && request.method === 'GET') {
    try { return json(await obEmployeeCheck(env, url.searchParams.get('id') || '')); }
    catch (e) { return json({ error: (e && e.message) || 'failed' }, 502); }
  }
  if (path === '/api/staff' && request.method === 'GET') return json(await obStaffStatus(env));
  if (path === '/api/staff/link' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const code = obCode();
    const email = String(b.email || '').trim().slice(0, 120);
    if (email && !/^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/.test(email)) return json({ ok: false, error: 'Check the email address.' }, 400);
    const rec = { firstName: String(b.firstName || '').slice(0, 40), lastName: String(b.lastName || '').slice(0, 40), email, role: b.role === 'kitchen' ? 'kitchen' : 'foh', mode: b.mode === 'existing' ? 'existing' : 'new', xeroId: String(b.xeroId || '').slice(0, 40), created: new Date().toISOString(), status: 'open' };
    await env.TOKENS.put('join:' + code, JSON.stringify(rec), { expirationTtl: OB_LINK_DAYS * 86400 });
    const list = ((await env.TOKENS.get('staff:links', 'json')) || []).filter((l) => Date.now() - Date.parse(l.created) < OB_LINK_DAYS * 86400000);
    list.unshift({ code, created: rec.created });
    await env.TOKENS.put('staff:links', JSON.stringify(list.slice(0, 50)));
    const link = url.origin + '/join/' + code;
    let emailed = false, emailError = '';
    if (email) {
      try { await obSendInvite(env, email, rec.firstName, link, rec.role, rec.mode === 'existing'); emailed = true; }
      catch (e) { emailError = (e && e.message) || 'failed'; }
    }
    return json({ ok: true, url: link, emailed, emailError });
  }
  if (path === '/api/staff/link/cancel' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    if (b.code) await env.TOKENS.delete('join:' + String(b.code));
    return json({ ok: true });
  }
  if (path === '/api/staff/remove' && request.method === 'POST') {
    let b = {}; try { b = await request.json(); } catch (e) {}
    const idx = ((await env.TOKENS.get('staff:index', 'json')) || []).filter((id) => id !== b.id);
    await env.TOKENS.put('staff:index', JSON.stringify(idx));
    if (b.id) await env.TOKENS.delete('sub:' + String(b.id));
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

let BRAND_FONT = null;
function brandFont() {
  if (!BRAND_FONT) { const b = atob(brandAssets.eightiesWoff2 || ''); BRAND_FONT = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) BRAND_FONT[i] = b.charCodeAt(i); }
  return new Response(BRAND_FONT, { headers: { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' } });
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
    if (path === '/brand/eighties.woff2') return brandFont();
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    /* New starter form (28 Oct 2026): public, but only through a one-person
       link the owner creates on /staff. */
    if (path.startsWith('/join/') || path.startsWith('/api/join/')) return obJoinRoute(env, request, url, path);

    const loggedIn = await isLoggedIn(request, env);
    /* Manager (rostering password): Wages + New staff only (owner, 28 Oct 2026). */
    const managerIn = loggedIn ? false : await roManagerLoggedIn(request, env);
    if (path === '/team') {
      if (loggedIn || managerIn) return Response.redirect(url.origin + '/', 302);
      return htmlResponse(await roLoginPage(env, true));
    }
    if (path === '/staff' || path.startsWith('/api/staff')) {
      if (!loggedIn && !managerIn) return path === '/staff' ? Response.redirect(url.origin + '/', 302) : json({ error: 'auth' }, 401);
      return obStaffRoute(env, request, url, path, managerIn);
    }

    /* OWNER DECISION 28 Oct 2026: home page with three doors (Reporting = the
       dashboard, Wages = /roster, New staff = /staff). */
    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(hubHtml);
      if (managerIn) return htmlResponse(hubHtml.replace('<script>', '<script>var BAINZ_ROLE = "manager";</script><script>'));
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/reporting') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return htmlResponse(dashboardHtml);
    }
    /* OWNER DECISION 21 Oct 2026: no cron. The dashboard calls this when it is
       opened or Refresh is pressed; each call is one catch-up pass (same work the
       old 5-minute cron did) and says whether Square is still behind, so the page
       can call again. Nothing runs in the background. */
    if (path === '/api/catchup' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiCatchup(env);
    }
    /* Rostering tool (21 Oct 2026): its own page and manager password. A manager
       session ('r1') opens only these routes, never the dashboard or its data. */
    if (path === '/roster' || path.startsWith('/api/roster/')) {
      return rosterRoute(env, request, url, path, loggedIn);
    }
    /* Surcharge refunds (27 Oct 2026): owner only. The only route that writes to Square. */
    if (path === '/refunds' && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return htmlResponse(refundsHtml);
    }
    if (path.startsWith('/api/refunds/')) {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return rfRoute(env, request, url, path);
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering|drive)\/(start|callback)$/.exec(path);
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
    if (path === '/check/roster-cost' && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return rosterCostCheckPage(env, url);
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
