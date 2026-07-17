/* ==========================================================================
   Creator Database — admin console (vanilla SPA).
   Renders the roster + creator profile from the read-model API (/roster).
   No build step: plain ES, event-delegated, themed via [data-theme] on <html>.
   ========================================================================== */
(function () {
  'use strict';

  // The INFLUENCE wordmark (same artwork as the signing page), so the logo is
  // crisp at any size and inherits the current text colour via `fill`.
  var WORDMARK =
    '<svg viewBox="0 0 793 70" role="img" aria-label="INFLUENCE"><path d="M20.01 68.6729H1.35348e-05V1.03334H20.01V68.6729ZM126.221 69.8941L55.1993 29.4044V68.6729H42.5169V-4.03086e-05L113.538 40.3018V1.03334H126.221V69.8941ZM209.764 44.2475H168.992V68.6729H148.794V1.03334H219.816V11.9308H169.086V33.35H209.764V44.2475ZM306.528 68.6729H236.54V1.03334H256.738V57.7754H306.528V68.6729ZM389.07 34.6652V1.03334H401.847V34.6652C401.847 40.8029 400.813 46.1577 398.747 50.7296C396.742 55.3015 393.861 58.934 390.104 61.6271C386.409 64.3201 382.15 66.3243 377.327 67.6395C372.505 68.9547 367.119 69.6123 361.169 69.6123C348.706 69.6123 338.81 66.7627 331.483 61.0634C324.218 55.3642 320.585 46.6274 320.585 34.8531V1.03334H341.065V34.6652C341.065 38.8614 341.754 42.4939 343.132 45.5627C344.51 48.6315 346.357 51.0114 348.675 52.7024C351.054 54.3934 353.591 55.646 356.284 56.4602C359.04 57.2117 361.983 57.5875 365.115 57.5875C368.246 57.5875 371.158 57.2117 373.851 56.4602C376.607 55.646 379.144 54.3934 381.461 52.7024C383.841 51.0114 385.688 48.6315 387.004 45.5627C388.381 42.4939 389.07 38.8614 389.07 34.6652ZM494.814 68.6729H423.041V1.03334H494.814V11.9308H443.238V28.7468H484.386V39.6442H443.238V57.7754H494.814V68.6729ZM596.325 69.8941L525.303 29.4044V68.6729H512.621V-4.03086e-05L583.643 40.3018V1.03334H596.325V69.8941ZM702.321 52.6085V63.7878C692.989 67.796 681.778 69.8002 668.689 69.8002C657.917 69.8002 648.428 68.4536 640.224 65.7606C632.082 63.0049 625.694 58.9653 621.059 53.6418C616.425 48.3184 614.108 42.0555 614.108 34.8531C614.108 24.0809 619.087 15.6259 629.045 9.48828C639.003 3.28799 652.217 0.187845 668.689 0.187845C681.966 0.187845 693.177 2.19198 702.321 6.20025V18.5069C693.302 13.4965 682.78 10.9914 670.756 10.9914C659.545 10.9914 650.84 13.246 644.639 17.7553C638.439 22.202 635.339 27.9013 635.339 34.8531C635.339 41.8676 638.439 47.6294 644.639 52.1387C650.902 56.648 659.796 58.9027 671.319 58.9027C682.029 58.9027 692.363 56.8046 702.321 52.6085ZM792.821 68.6729H721.048V1.03334H792.821V11.9308H741.246V28.7468H782.393V39.6442H741.246V57.7754H792.821V68.6729Z"/></svg>';

  var state = {
    // 'loading' until GET /auth/session resolves, then 'login' or 'app'.
    view: 'loading',
    username: '',
    password: '',
    loginError: false,
    loggingIn: false,
    search: '',
    riskFilter: 'All',
    expandedId: null,
    selectedId: null,
    activeTab: 'overview',
    roster: null, // {creators, total} | null (loading)
    rosterError: false,
    profile: null,
    profileLoading: false,
  };

  var root = document.getElementById('root');

  // ---- helpers ------------------------------------------------------------
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtNum(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
    return String(n);
  }
  function fmtCpm(n) {
    return n === null || n === undefined || isNaN(n) ? '—' : '$' + Number(n).toFixed(1);
  }
  function fmtPct(n) {
    return n === null || n === undefined || isNaN(n) ? '—' : Number(n).toFixed(1) + '%';
  }
  var CUR = { USD: '$', EUR: '€', GBP: '£', INR: '₹', CAD: 'C$', AUD: 'A$' };
  function fmtMoney(n, cur) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var sym = CUR[cur] || (cur ? cur + ' ' : '$');
    return sym + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
  }
  function fmtMonth(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
  function riskClass(risk) {
    if (risk === 'Low') return 'low';
    if (risk === 'Med') return 'med';
    if (risk === 'High') return 'high';
    return 'pending';
  }
  function riskStyle(risk) {
    var k = riskClass(risk);
    return 'background:var(--risk-' + k + '-bg);color:var(--risk-' + k + '-fg)';
  }
  function statusStyle(status) {
    var map = { Active: 'active', Completed: 'completed', Pending: 'pending' };
    var k = map[status] || 'completed';
    return 'background:var(--st-' + k + '-bg);color:var(--st-' + k + '-fg)';
  }

  function setState(patch) {
    Object.assign(state, patch);
    render();
  }

  // ---- data ---------------------------------------------------------------
  function loadRoster() {
    state.roster = null;
    state.rosterError = false;
    render();
    fetch('/roster', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) {
          state.view = 'login';
          throw new Error('unauthorized');
        }
        if (!r.ok) throw new Error('roster ' + r.status);
        return r.json();
      })
      .then(function (data) {
        state.roster = data && data.creators ? data : { creators: [], total: 0 };
        render();
      })
      .catch(function () {
        if (state.view === 'login') return render();
        state.rosterError = true;
        state.roster = { creators: [], total: 0 };
        render();
      });
  }
  function loadProfile(id) {
    state.profile = null;
    state.profileLoading = true;
    render();
    fetch('/roster/' + encodeURIComponent(id), { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) {
          state.view = 'login';
          state.selectedId = null;
          throw new Error('unauthorized');
        }
        if (!r.ok) throw new Error('profile ' + r.status);
        return r.json();
      })
      .then(function (p) {
        state.profile = p;
        state.profileLoading = false;
        render();
      })
      .catch(function () {
        state.profileLoading = false;
        state.profile = null;
        render();
      });
  }

  // ---- theme --------------------------------------------------------------
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('cdb_theme', next);
    render();
  }
  function themeIcon() {
    return currentTheme() === 'dark' ? '☀' : '☽';
  }

  // ---- views --------------------------------------------------------------
  function loginView() {
    return (
      '<div class="login">' +
      '<button class="icon-btn" data-act="theme">' +
      themeIcon() +
      '</button>' +
      '<div class="brand">' +
      WORDMARK +
      '</div>' +
      '<form class="login-card" data-act="login">' +
      '<div><h1>Admin sign in</h1><div class="sub">Credentials are provisioned at deployment. No self-signup.</div></div>' +
      '<div class="field"><label>Username</label><input id="u" type="text" placeholder="admin" value="' +
      esc(state.username) +
      '" autocomplete="username"></div>' +
      '<div class="field"><label>Password</label><input id="p" type="password" placeholder="••••••••" value="' +
      esc(state.password) +
      '" autocomplete="current-password"></div>' +
      (state.loginError
        ? '<div class="login-err">Invalid username or password.</div>'
        : '') +
      '<button class="btn-primary" type="submit"' +
      (state.loggingIn ? ' disabled' : '') +
      '>' +
      (state.loggingIn ? 'Signing in…' : 'Sign in') +
      '</button>' +
      '</form>' +
      '<div class="login-foot">Internal admin console · v2.4</div>' +
      '</div>'
    );
  }

  function topbar() {
    return (
      '<div class="topbar">' +
      '<div class="left">' +
      '<div class="brand-mark">' +
      WORDMARK +
      '</div>' +
      '<div class="divider"></div>' +
      '<div class="crumb">Creator Database</div>' +
      '</div>' +
      '<div class="right">' +
      '<button class="icon-btn" data-act="theme">' +
      themeIcon() +
      '</button>' +
      '<div class="divider"></div>' +
      '<div style="display:flex;align-items:center;gap:9px"><div class="avatar">A</div><div style="font-size:13px;font-weight:500">Admin</div></div>' +
      '<button class="link-btn" data-act="signout">Sign out</button>' +
      '</div>' +
      '</div>'
    );
  }

  function rosterView() {
    var data = state.roster;
    var body;
    if (data === null) {
      body = '<div class="spinner"></div>';
    } else {
      var q = state.search.trim().toLowerCase();
      var list = data.creators.filter(function (c) {
        var mq =
          !q ||
          (c.name && c.name.toLowerCase().indexOf(q) >= 0) ||
          (c.handle && c.handle.toLowerCase().indexOf(q) >= 0);
        var mr = state.riskFilter === 'All' || c.risk === state.riskFilter;
        return mq && mr;
      });
      var countLabel = list.length + ' of ' + data.total + ' creators';

      var rows;
      if (data.total === 0) {
        rows =
          '<div class="empty">' +
          (state.rosterError
            ? 'Could not reach the API. Check the service is running.'
            : 'No creators yet. Records appear here as outreach, contract and stats syncs run.') +
          '</div>';
      } else if (list.length === 0) {
        rows = '<div class="empty">No creators match your filters.</div>';
      } else {
        rows = list.map(rosterRow).join('');
      }

      var chips = ['All', 'Low', 'Med', 'High']
        .map(function (r) {
          return (
            '<button class="chip' +
            (state.riskFilter === r ? ' active' : '') +
            '" data-act="risk" data-risk="' +
            r +
            '">' +
            r +
            '</button>'
          );
        })
        .join('');

      body =
        '<div class="page-head">' +
        '<div><div class="page-title">Creator roster</div><div class="page-sub">' +
        esc(countLabel) +
        '</div></div>' +
        '<div class="toolbar">' +
        '<div class="search"><span>⚲</span><input id="search" type="text" placeholder="Search name or @handle" value="' +
        esc(state.search) +
        '"></div>' +
        chips +
        '</div></div>' +
        '<div class="table">' +
        '<div class="roster-grid roster-head"><div>Creator</div><div class="hide-sm">Platforms</div><div class="hide-sm">Campaigns</div><div>Total views</div><div class="hide-sm">CPM</div><div class="hide-sm">Engagement</div><div>Risk</div><div></div></div>' +
        rows +
        '</div>';
    }
    return '<div class="app">' + topbar() + '<div class="page list fade">' + body + '</div></div>';
  }

  function rosterRow(c) {
    var expanded = state.expandedId === c.id;
    var plats = (c.platforms || [])
      .map(function (p) {
        return '<div class="plat">' + esc(p) + '</div>';
      })
      .join('');
    var detail = expanded
      ? '<div class="row-detail fade">' +
        kv('Followers', fmtNum(c.followers)) +
        kv('Signature on file', c.signature ? 'On file' : 'Missing') +
        kv('Active contracts', String(c.activeContracts)) +
        kv('Last campaign', esc(c.lastCampaign || '—')) +
        '<button class="btn-accent" style="margin-left:auto" data-act="open" data-id="' +
        esc(c.id) +
        '">View full profile →</button>' +
        '</div>'
      : '';
    return (
      '<div>' +
      '<div class="roster-grid roster-row' +
      (expanded ? ' expanded' : '') +
      '" data-act="toggle" data-id="' +
      esc(c.id) +
      '">' +
      '<div class="creator-cell"><div class="pfp">' +
      esc(c.initials) +
      '</div><div><div class="creator-name">' +
      esc(c.name) +
      '</div><div class="creator-handle mono">' +
      esc(c.handle) +
      '</div></div></div>' +
      '<div class="plat-chips hide-sm">' +
      plats +
      '</div>' +
      '<div class="cell hide-sm">' +
      esc(c.campaigns) +
      '</div>' +
      '<div class="cell mono">' +
      fmtNum(c.views) +
      '</div>' +
      '<div class="cell mono hide-sm">' +
      fmtCpm(c.cpm) +
      '</div>' +
      '<div class="cell hide-sm">' +
      fmtPct(c.engagement) +
      '</div>' +
      '<div><span class="badge" style="' +
      riskStyle(c.risk) +
      '">' +
      esc(c.risk || '—') +
      '</span></div>' +
      '<div class="chev' +
      (expanded ? ' open' : '') +
      '">›</div>' +
      '</div>' +
      detail +
      '</div>'
    );
  }

  function kv(k, v) {
    return '<div class="kv"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  }

  // ---- profile ------------------------------------------------------------
  var TAB_DEFS = [
    { key: 'overview', label: 'Overview' },
    { key: 'contract', label: 'Contract & Legal' },
    { key: 'deliverables', label: 'Deliverables & Rights' },
    { key: 'performance', label: 'Performance' },
    { key: 'campaigns', label: 'Campaigns' },
  ];

  function profileView() {
    var inner;
    if (state.profileLoading || state.profile === null) {
      inner = state.profileLoading
        ? '<div class="spinner"></div>'
        : '<div class="empty">Could not load this creator.</div>';
    } else {
      var p = state.profile;
      inner =
        '<button class="back-btn" data-act="back">← Back to roster</button>' +
        heroCard(p) +
        tabsBar() +
        tabContent(p);
    }
    return '<div class="app">' + topbar() + '<div class="page profile fade">' + inner + '</div></div>';
  }

  function heroCard(p) {
    return (
      '<div class="card card-lg profile-hero">' +
      '<div class="pfp-lg">' +
      esc(p.initials) +
      '</div>' +
      '<div style="flex:1;min-width:200px">' +
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div class="hero-name">' +
      esc(p.name) +
      '</div><span class="badge" style="' +
      riskStyle(p.risk) +
      '">' +
      esc(p.risk || '—') +
      ' risk</span></div>' +
      '<div class="creator-handle mono" style="margin-top:3px">' +
      esc(p.handle) +
      '</div></div>' +
      '<div class="hero-stats">' +
      stat('Followers', fmtNum(p.followers)) +
      stat('Total views', fmtNum(p.views)) +
      stat('CPM', fmtCpm(p.cpm)) +
      stat('Campaigns', String(p.campaigns)) +
      '</div></div>'
    );
  }
  function stat(k, v) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  }

  function tabsBar() {
    return (
      '<div class="tabs">' +
      TAB_DEFS.map(function (t) {
        return (
          '<button class="tab' +
          (state.activeTab === t.key ? ' active' : '') +
          '" data-act="tab" data-tab="' +
          t.key +
          '">' +
          t.label +
          '</button>'
        );
      }).join('') +
      '</div>'
    );
  }

  function tabContent(p) {
    switch (state.activeTab) {
      case 'contract':
        return contractTab(p);
      case 'deliverables':
        return deliverablesTab(p);
      case 'performance':
        return performanceTab(p);
      case 'campaigns':
        return campaignsTab(p);
      default:
        return overviewTab(p);
    }
  }

  function bars(list, metaFn) {
    if (!list || !list.length) return '<div class="dim" style="font-size:13px">No platform data yet.</div>';
    var max = Math.max.apply(
      null,
      list.map(function (x) {
        return x.views || 0;
      })
    );
    max = max || 1;
    return list
      .map(function (pf) {
        var w = Math.round(((pf.views || 0) / max) * 100);
        return (
          '<div class="bar-row"><div class="bar-label"><span class="name">' +
          esc(pf.name) +
          '</span><span class="meta mono">' +
          metaFn(pf) +
          '</span></div><div class="bar-track"><div class="bar-fill" style="width:' +
          w +
          '%"></div></div></div>'
        );
      })
      .join('');
  }

  function overviewTab(p) {
    var ra = p.riskAssessment || { note: '—', factors: {} };
    return (
      '<div class="grid-2">' +
      '<div class="card"><div class="card-title">Platform performance</div>' +
      bars(p.platformBreakdown, function (pf) {
        return fmtNum(pf.views) + ' views · ' + fmtPct(pf.engagement) + ' eng.';
      }) +
      '</div>' +
      '<div class="card"><div class="card-title">Risk assessment</div>' +
      '<div class="dim" style="font-size:13px;line-height:1.7">' +
      esc(ra.note) +
      '</div>' +
      '<div style="margin-top:18px;display:flex;flex-direction:column;gap:10px">' +
      riskFactor('Content compliance', ra.factors.compliance) +
      riskFactor('Payment / tax', ra.factors.payment) +
      riskFactor('Delivery reliability', ra.factors.delivery) +
      '</div></div>' +
      '</div>'
    );
  }
  function riskFactor(lbl, val) {
    return (
      '<div class="risk-factor"><span class="lbl">' +
      esc(lbl) +
      '</span><span class="val">' +
      esc(val || '—') +
      '</span></div>'
    );
  }

  function contractTab(p) {
    var ct = p.contact || {};
    var pay = p.payment || {};
    var sigLine = ct.signature
      ? 'Signed · ' + fmtDate(ct.signedDate)
      : 'Missing';
    var contactCard =
      '<div class="card"><div class="card-title">Contact &amp; identity</div><div class="detail-list">' +
      dl('Registered address', esc(ct.address || '—')) +
      dl('Phone', '<span class="mono">' + esc(ct.phone || '—') + '</span>') +
      dl('Email', '<span class="mono">' + esc(ct.email || '—') + '</span>') +
      dl(
        'Signature on file',
        '<span style="display:inline-flex;align-items:center;gap:8px"><span style="width:8px;height:8px;border-radius:50%;background:var(--risk-' +
          (ct.signature ? 'low' : 'high') +
          '-fg)"></span>' +
          esc(sigLine) +
          '</span>'
      ) +
      '</div></div>';
    var payCard =
      '<div class="card"><div class="card-title">Payment account</div><div class="detail-list">' +
      dl('Account holder', esc(pay.accountHolder || '—')) +
      dl(
        'Bank account',
        '<span class="mono">' + (pay.bankLast4 ? '•••• •••• ' + esc(pay.bankLast4) : '—') + '</span>'
      ) +
      dl('Payment method', esc(pay.paymentMethod || '—')) +
      dl('Tax status', esc(pay.taxStatus || '—')) +
      '</div></div>';
    return (
      '<div class="grid-2">' +
      contactCard +
      payCard +
      '<div style="grid-column:1/-1">' +
      contractHistory(p.contracts) +
      '</div></div>'
    );
  }
  function dl(k, v) {
    return '<div><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  }

  function contractHistory(contracts) {
    var head =
      '<div class="st-headrow" style="display:grid;grid-template-columns:1.4fr 1fr 1fr 0.8fr 0.8fr"><div>Campaign / Brand</div><div>Start</div><div>End</div><div>Value</div><div>Status</div></div>';
    var rows =
      contracts && contracts.length
        ? contracts
            .map(function (ct) {
              return (
                '<div class="st-row" style="display:grid;grid-template-columns:1.4fr 1fr 1fr 0.8fr 0.8fr">' +
                '<div><div style="font-weight:600">' +
                esc(ct.campaign) +
                '</div><div class="dim" style="font-size:12px">' +
                esc(ct.brand) +
                '</div></div>' +
                '<div class="dim">' +
                fmtMonth(ct.start) +
                '</div><div class="dim">' +
                fmtMonth(ct.end) +
                '</div>' +
                '<div class="mono" style="font-weight:600">' +
                fmtMoney(ct.value, ct.currency) +
                '</div>' +
                '<div><span class="badge badge-sm" style="' +
                statusStyle(ct.status) +
                '">' +
                esc(ct.status) +
                '</span></div></div>'
              );
            })
            .join('')
        : '<div class="empty">No contracts on record.</div>';
    return '<div class="section-table"><div class="st-title">Contract history</div>' + head + rows + '</div>';
  }

  function deliverablesTab(p) {
    var head =
      '<div class="st-headrow" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr"><div>Deliverables</div><div>Platform</div><div>Due</div><div>Status</div></div>';
    var rows =
      p.deliverables && p.deliverables.length
        ? p.deliverables
            .map(function (d) {
              return (
                '<div class="st-row" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr">' +
                '<div style="font-weight:600">' +
                esc(d.type) +
                '</div><div class="dim">' +
                esc(d.platform) +
                '</div><div class="dim">' +
                fmtDate(d.due) +
                '</div>' +
                '<div><span class="badge badge-sm" style="' +
                statusStyle(d.status) +
                '">' +
                esc(d.status) +
                '</span></div></div>'
              );
            })
            .join('')
        : '<div class="empty">No deliverables recorded.</div>';
    var ur = p.usageRights || {};
    var rights =
      '<div class="card grid-4" style="gap:20px">' +
      kv('Usage rights', esc(ur.usageRights || '—')) +
      kv('Exclusivity', esc(ur.exclusivity || '—')) +
      kv('Paid ad rights', esc(ur.paidAdRights || '—')) +
      kv('Deadline', fmtDate(ur.deadline)) +
      '</div>';
    return (
      '<div style="display:flex;flex-direction:column;gap:20px">' +
      '<div class="section-table"><div class="st-title">Deliverables</div>' +
      head +
      rows +
      '</div>' +
      rights +
      '</div>'
    );
  }

  function performanceTab(p) {
    return (
      '<div class="grid-4">' +
      statCard('Combined views', fmtNum(p.views)) +
      statCard('Blended CPM', fmtCpm(p.cpm)) +
      statCard('Engagement rate', fmtPct(p.engagement)) +
      statCard('Campaigns', String(p.campaigns)) +
      '<div style="grid-column:1/-1" class="card"><div class="card-title">Views by platform</div>' +
      bars(p.platformBreakdown, function (pf) {
        return fmtNum(pf.views) + ' · ' + fmtPct(pf.engagement) + ' eng.';
      }) +
      '</div></div>'
    );
  }
  function statCard(k, v) {
    return '<div class="stat-card"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  }

  function campaignsTab(p) {
    var head =
      '<div class="st-headrow" style="display:grid;grid-template-columns:1.4fr 1fr 1fr 0.8fr"><div>Campaign / Brand</div><div>Start</div><div>End</div><div>Status</div></div>';
    var rows =
      p.contracts && p.contracts.length
        ? p.contracts
            .map(function (ct) {
              return (
                '<div class="st-row" style="display:grid;grid-template-columns:1.4fr 1fr 1fr 0.8fr">' +
                '<div><div style="font-weight:600">' +
                esc(ct.campaign) +
                '</div><div class="dim" style="font-size:12px">' +
                esc(ct.brand) +
                '</div></div>' +
                '<div class="dim">' +
                fmtMonth(ct.start) +
                '</div><div class="dim">' +
                fmtMonth(ct.end) +
                '</div>' +
                '<div><span class="badge badge-sm" style="' +
                statusStyle(ct.status) +
                '">' +
                esc(ct.status) +
                '</span></div></div>'
              );
            })
            .join('')
        : '<div class="empty">No campaigns on record.</div>';
    return '<div class="section-table"><div class="st-title">Campaign participation</div>' + head + rows + '</div>';
  }

  // ---- render + events ----------------------------------------------------
  function render() {
    if (state.view === 'loading') {
      root.innerHTML = '<div class="spinner"></div>';
    } else if (state.view === 'login') {
      root.innerHTML = loginView();
    } else if (state.selectedId) {
      root.innerHTML = profileView();
    } else {
      root.innerHTML = rosterView();
    }
  }

  root.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (act === 'theme') return toggleTheme();
    if (act === 'signout') {
      fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
      setState({ view: 'login', username: '', password: '', selectedId: null, expandedId: null });
      return;
    }
    if (act === 'risk') return setState({ riskFilter: el.getAttribute('data-risk') });
    if (act === 'toggle') {
      var id = el.getAttribute('data-id');
      return setState({ expandedId: state.expandedId === id ? null : id });
    }
    if (act === 'open') {
      state.selectedId = el.getAttribute('data-id');
      state.activeTab = 'overview';
      loadProfile(state.selectedId);
      return;
    }
    if (act === 'back') return setState({ selectedId: null, profile: null });
    if (act === 'tab') return setState({ activeTab: el.getAttribute('data-tab') });
  });

  root.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-act="login"]');
    if (!form) return;
    e.preventDefault();
    if (state.loggingIn) return;
    var u = document.getElementById('u').value;
    var p = document.getElementById('p').value;
    state.username = u;
    state.password = p;
    setState({ loggingIn: true, loginError: false });
    fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        if (res.ok && res.j && res.j.authenticated) {
          state.username = '';
          state.password = '';
          state.loginError = false;
          state.loggingIn = false;
          state.view = 'app';
          loadRoster();
        } else {
          setState({ loginError: true, loggingIn: false });
        }
      })
      .catch(function () {
        setState({ loginError: true, loggingIn: false });
      });
  });

  // Keep search state without re-rendering on every keystroke (preserves focus).
  root.addEventListener('input', function (e) {
    if (e.target.id === 'search') {
      state.search = e.target.value;
      var data = state.roster;
      if (!data) return;
      // Re-render only the rows + count, keeping the input focused.
      var q = state.search.trim().toLowerCase();
      var list = data.creators.filter(function (c) {
        var mq =
          !q ||
          (c.name && c.name.toLowerCase().indexOf(q) >= 0) ||
          (c.handle && c.handle.toLowerCase().indexOf(q) >= 0);
        var mr = state.riskFilter === 'All' || c.risk === state.riskFilter;
        return mq && mr;
      });
      var tbl = root.querySelector('.table');
      var sub = root.querySelector('.page-sub');
      if (sub) sub.textContent = list.length + ' of ' + data.total + ' creators';
      if (tbl) {
        var headHtml = tbl.querySelector('.roster-head').outerHTML;
        var rowsHtml =
          data.total === 0
            ? '<div class="empty">No creators yet.</div>'
            : list.length === 0
              ? '<div class="empty">No creators match your filters.</div>'
              : list.map(rosterRow).join('');
        tbl.innerHTML = headHtml + rowsHtml;
      }
    }
  });

  // ---- boot ---------------------------------------------------------------
  (function boot() {
    var saved = localStorage.getItem('cdb_theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    render(); // shows the loading spinner
    fetch('/auth/session', { credentials: 'same-origin' })
      .then(function (r) {
        return r.json();
      })
      .then(function (s) {
        if (s && s.authenticated) {
          state.view = 'app';
          loadRoster();
        } else {
          setState({ view: 'login' });
        }
      })
      .catch(function () {
        setState({ view: 'login' });
      });
  })();
})();
