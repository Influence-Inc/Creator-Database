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
    usageFilter: 'Used', // Used (default) | Unused | All
    expandedId: null,
    selectedId: null,
    activeTab: 'performance',
    // Inline edit state for the Contact & Payment cards.
    editContact: false,
    editPayment: false,
    saving: false,
    saveError: null,
    roster: null, // {creators, total} | null (loading)
    rosterError: false,
    profile: null,
    profileLoading: false,
    // Full (unredacted) contracts for the selected creator — fetched on demand
    // when the admin reveals the account number or opens a signed contract.
    contractsFull: null,
    contractsLoading: false,
    revealPay: false,
    modalContractId: null,
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
  // New-vs-returning chip. "Returning" = the creator has 2+ campaigns on record;
  // "New" = a single campaign so far. Purely informational (who's worked with us
  // before), computed server-side in the /roster read-model.
  // Used-vs-unused chip. "Used" = we've worked with this creator — they've
  // signed a contract and/or we hold their campaign performance from
  // influence-stats. "Unused" = no contract and no performance history yet.
  // Computed server-side in the /roster read-model (segment: 'used' | 'unused').
  function segChip(c) {
    if (c.segment !== 'used' && c.segment !== 'unused') return '';
    var label = c.segment === 'used' ? 'Used' : 'Unused';
    var signed = c.signedContracts || 0;
    var camps = c.campaigns || 0;
    var title;
    if (c.segment !== 'used') {
      title = 'Unused creator — no contract or performance on record yet';
    } else if (signed >= 1) {
      title = 'Used creator — signed ' + signed + ' contract' + (signed === 1 ? '' : 's');
    } else {
      title = 'Used creator — ' + camps + ' campaign' + (camps === 1 ? '' : 's') + ' on record (performance data)';
    }
    return '<span class="seg-chip ' + c.segment + '" title="' + esc(title) + '">' + label + '</span>';
  }

  // Used/Unused roster filter. "Used" is the default so the roster leads with
  // creators we've actually worked with (signed a contract).
  function matchesUsage(c) {
    if (state.usageFilter === 'All') return true;
    if (state.usageFilter === 'Unused') return c.segment === 'unused';
    return c.segment === 'used';
  }
  function usageChips() {
    return ['Used', 'Unused', 'All']
      .map(function (r) {
        return (
          '<button class="chip' +
          (state.usageFilter === r ? ' active' : '') +
          '" data-act="usage" data-usage="' +
          r +
          '">' +
          r +
          '</button>'
        );
      })
      .join('');
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
    state.contractsFull = null;
    state.contractsLoading = false;
    state.revealPay = false;
    state.modalContractId = null;
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

  // Fetch the full (unredacted) contracts for the selected creator, once, then
  // run `cb`. Used by both "reveal account number" and "view signed contract".
  function loadContractsFull(cb) {
    if (state.contractsFull) return cb();
    if (state.contractsLoading) return;
    state.contractsLoading = true;
    render();
    fetch('/roster/' + encodeURIComponent(state.selectedId) + '/contracts', {
      credentials: 'same-origin',
    })
      .then(function (r) {
        if (r.status === 401) {
          state.view = 'login';
          state.selectedId = null;
          throw new Error('unauthorized');
        }
        if (!r.ok) throw new Error('contracts ' + r.status);
        return r.json();
      })
      .then(function (data) {
        state.contractsFull = data && data.contracts ? data.contracts : [];
        state.contractsLoading = false;
        cb();
      })
      .catch(function () {
        state.contractsLoading = false;
        state.contractsFull = state.view === 'login' ? null : [];
        render();
      });
  }

  // ---- inline editing (contact + payout details) --------------------------
  function fieldVal(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
  }

  // PATCH the edited details to the API, then refresh the profile in place.
  // `onSuccess` runs after the profile is replaced (e.g. to leave edit mode).
  function saveDetails(body, onSuccess) {
    state.saving = true;
    state.saveError = null;
    render();
    fetch('/roster/' + encodeURIComponent(state.selectedId) + '/details', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        if (r.status === 401) {
          state.view = 'login';
          state.selectedId = null;
          throw new Error('unauthorized');
        }
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (res) {
        if (!res.ok) {
          var m = res.j && res.j.message;
          throw new Error(Array.isArray(m) ? m.join(', ') : m || 'Save failed');
        }
        state.profile = res.j;
        state.contractsFull = null; // force a re-fetch of the unredacted view
        state.saving = false;
        state.saveError = null;
        onSuccess();
      })
      .catch(function (err) {
        state.saving = false;
        if (err && err.message === 'unauthorized') {
          render();
          return;
        }
        state.saveError = (err && err.message) || 'Save failed';
        render();
      });
  }

  function saveContact() {
    if (state.saving) return;
    saveDetails(
      {
        contact: {
          email: fieldVal('ec-email'),
          phone: fieldVal('ec-phone'),
          address: {
            line1: fieldVal('ec-line1'),
            line2: fieldVal('ec-line2'),
            city: fieldVal('ec-city'),
            state: fieldVal('ec-state'),
            postalCode: fieldVal('ec-zip'),
            country: fieldVal('ec-country'),
          },
        },
      },
      function () {
        state.editContact = false;
        render();
      },
    );
  }

  function savePayment() {
    if (state.saving) return;
    saveDetails(
      {
        payment: {
          accountHolderName: fieldVal('ep-holder'),
          bankName: fieldVal('ep-bank'),
          accountNumber: fieldVal('ep-acct'),
          iban: fieldVal('ep-iban'),
          routingNumber: fieldVal('ep-routing'),
          ifscCode: fieldVal('ep-ifsc'),
          swiftCode: fieldVal('ep-swift'),
          panNumber: fieldVal('ep-pan'),
          taxIdNumber: fieldVal('ep-taxid'),
        },
      },
      function () {
        state.editPayment = false;
        render();
      },
    );
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
        return mq && matchesUsage(c);
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

      body =
        '<div class="page-head">' +
        '<div><div class="page-title">Creator roster</div><div class="page-sub">' +
        esc(countLabel) +
        '</div></div>' +
        '<div class="toolbar">' +
        '<div class="search"><span>⚲</span><input id="search" type="text" placeholder="Search name or @handle" value="' +
        esc(state.search) +
        '"></div>' +
        usageChips() +
        '</div></div>' +
        '<div class="table">' +
        '<div class="roster-grid roster-head"><div>Creator</div><div class="hide-sm">Platforms</div><div class="hide-sm">Campaigns</div><div>Total views</div><div class="hide-sm">CPM</div><div class="hide-sm">Engagement</div><div></div></div>' +
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
      segChip(c) +
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
    { key: 'performance', label: 'Performance' },
    { key: 'contract', label: 'Contract & Legal' },
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
    return (
      '<div class="app">' +
      topbar() +
      '<div class="page profile fade">' +
      inner +
      '</div>' +
      contractModal() +
      '</div>'
    );
  }

  // Full signed-contract viewer (modal): signature image + all terms + the full
  // (unredacted) payout details. state.modalContractId is the index into
  // state.contractsFull, or null when closed.
  function contractModal() {
    if (state.modalContractId === null) return '';
    var list = state.contractsFull || [];
    var c = list[state.modalContractId];
    if (!c) return '';
    var addr = c.address || {};
    var addrStr = [addr.line1, addr.line2, addr.city, addr.state, addr.postalCode, addr.country]
      .filter(Boolean)
      .join(', ');
    var pay = c.payment || {};
    var sig = c.signatureImage
      ? '<img class="sig-img" src="' + esc(c.signatureImage) + '" alt="signature">'
      : '<div class="dim" style="font-size:13px">No signature image on file.</div>';

    function row(k, v) {
      return v ? '<div class="mrow"><span class="mk">' + esc(k) + '</span><span class="mv">' + v + '</span></div>' : '';
    }
    var mono = function (v) {
      return v ? '<span class="mono">' + esc(v) + '</span>' : '';
    };

    var signer =
      row('Signed by', esc(c.signerName)) +
      row('Email', mono(c.signerEmail)) +
      row('Phone', mono(c.signerPhone)) +
      row('Gender', esc(c.signerGender)) +
      row('Address', esc(addrStr)) +
      row('Signed date', c.signedAt ? fmtDate(c.signedAt) : c.signerSignedDate ? fmtDate(c.signerSignedDate) : '') +
      row('Status', '<span class="badge badge-sm" style="' + statusStyle(c.status) + '">' + esc(c.status) + '</span>');

    var payment =
      row('Account holder', esc(pay.accountHolderName)) +
      row('Bank name', esc(pay.bankName)) +
      row('Account number', mono(pay.accountNumber)) +
      row('IBAN', mono(pay.iban)) +
      row('Routing number', mono(pay.routingNumber)) +
      row('IFSC code', mono(pay.ifscCode)) +
      row('SWIFT / BIC', mono(pay.swiftCode)) +
      row('PAN', mono(pay.panNumber)) +
      row('Tax ID', mono(pay.taxIdNumber));
    if (!payment) payment = '<div class="dim" style="font-size:13px">No payout details on file.</div>';

    var terms =
      row('Brand', esc(c.brandName)) +
      row('Campaign', esc(c.campaignName)) +
      row('Platform', esc(c.platform)) +
      row('Deliverables', esc(c.deliverables)) +
      row('No. of deliverables', c.numberOfDeliverables != null ? esc(String(c.numberOfDeliverables)) : '') +
      row('Timeline', esc(c.timeline)) +
      row('Deadline', c.deadline ? fmtDate(c.deadline) : '') +
      row('Usage rights', esc(c.usageRights)) +
      row('Exclusivity', esc(c.exclusivity)) +
      row('Guaranteed views', c.guaranteedViews != null ? fmtNum(c.guaranteedViews) : '') +
      row('Compensation', c.compensation != null ? mono(fmtMoney(c.compensation, c.currency)) : '') +
      row('Payment terms', esc(c.paymentTerms)) +
      row('Special notes', esc(c.specialNotes));

    var multi =
      list.length > 1
        ? '<span class="dim" style="font-size:12px;font-weight:500;margin-left:8px">(' + (state.modalContractId + 1) + ' of ' + list.length + ')</span>'
        : '';
    var link = c.contractUrl
      ? '<a href="' + esc(c.contractUrl) + '" target="_blank" rel="noopener" class="linklike">Open original ↗</a>'
      : '';

    return (
      '<div class="modal-overlay">' +
      '<div class="modal">' +
      '<div class="modal-head"><div style="font-size:16px;font-weight:700">Signed contract' +
      multi +
      '</div><div style="display:flex;gap:16px;align-items:center">' +
      link +
      '<button class="modal-x" data-act="close-modal" aria-label="Close">✕</button></div></div>' +
      '<div class="modal-body">' +
      '<div class="msec"><div class="msec-t">Signature</div><div class="sig-box">' + sig + '</div></div>' +
      '<div class="msec"><div class="msec-t">Signer &amp; identity</div>' + signer + '</div>' +
      '<div class="msec"><div class="msec-t">Payment account (full)</div>' + payment + '</div>' +
      '<div class="msec"><div class="msec-t">Contract terms</div>' + (terms || '<div class="dim" style="font-size:13px">—</div>') + '</div>' +
      '</div></div></div>'
    );
  }

  function heroCard(p) {
    return (
      '<div class="card card-lg profile-hero">' +
      '<div class="pfp-lg">' +
      esc(p.initials) +
      '</div>' +
      '<div style="flex:1;min-width:200px">' +
      '<div class="hero-name">' +
      esc(p.name) +
      '</div>' +
      '<div class="creator-handle mono" style="margin-top:3px">' +
      esc(p.handle) +
      '</div></div>' +
      '<div class="hero-stats">' +
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
      case 'campaigns':
        return campaignsTab(p);
      case 'performance':
        return performanceTab(p);
      default:
        return contractTab(p);
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

  function contractTab(p) {
    return (
      '<div class="grid-2">' +
      contactCard(p) +
      paymentCard(p) +
      '<div style="grid-column:1/-1">' +
      contractHistory(p.contracts) +
      '</div></div>'
    );
  }

  // Small input used inside the editable cards.
  function editInput(id, value, placeholder) {
    return (
      '<input class="edit-input" id="' +
      id +
      '" value="' +
      esc(value || '') +
      '" placeholder="' +
      esc(placeholder || '') +
      '">'
    );
  }
  function cardTitleBar(label, editing, editAct, saveAct, cancelAct) {
    var right = editing
      ? '<span style="display:flex;gap:14px">' +
        '<button class="linklike" data-act="' + cancelAct + '"' + (state.saving ? ' disabled' : '') + '>Cancel</button>' +
        '<button class="linklike" data-act="' + saveAct + '"' + (state.saving ? ' disabled' : '') + '>' +
        (state.saving ? 'Saving…' : 'Save') +
        '</button></span>'
      : '<button class="linklike" data-act="' + editAct + '">Edit</button>';
    return (
      '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center">' +
      label +
      right +
      '</div>'
    );
  }

  function contactCard(p) {
    var ct = p.contact || {};
    var af = ct.addressFields || {};
    var body;
    if (state.editContact) {
      body =
        '<div class="detail-list">' +
        dl('Email', editInput('ec-email', ct.email, 'email@example.com')) +
        dl('Phone', editInput('ec-phone', ct.phone, '+1 555 123 4567')) +
        dl(
          'Address',
          editInput('ec-line1', af.line1, 'Address line 1') +
            '<div style="height:8px"></div>' +
            editInput('ec-line2', af.line2, 'Address line 2 (optional)') +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">' +
            editInput('ec-city', af.city, 'City') +
            editInput('ec-state', af.state, 'State / Province') +
            editInput('ec-zip', af.postalCode, 'Postal code') +
            editInput('ec-country', af.country, 'Country') +
            '</div>'
        ) +
        '</div>' +
        (state.saveError ? '<div class="save-err">' + esc(state.saveError) + '</div>' : '');
    } else {
      body =
        '<div class="detail-list">' +
        dl('Registered address', esc(ct.address || '—')) +
        dl('Phone', '<span class="mono">' + esc(ct.phone || '—') + '</span>') +
        dl('Email', '<span class="mono">' + esc(ct.email || '—') + '</span>') +
        '</div>';
    }
    return (
      '<div class="card">' +
      cardTitleBar('Contact &amp; identity', state.editContact, 'edit-contact', 'save-contact', 'cancel-contact') +
      body +
      '</div>'
    );
  }

  // Payment account card. Masked by default; the admin can Reveal the full
  // account/IBAN or Edit it (both fetch the full payout details on demand).
  function paymentCard(p) {
    var pay = p.payment || {};
    var full =
      state.contractsFull && state.contractsFull.length ? state.contractsFull[0].payment || {} : null;
    var monoV = function (v) {
      return '<span class="mono">' + esc(v) + '</span>';
    };

    // Edit mode — inputs seeded from the full (unredacted) payout details.
    if (state.editPayment) {
      var f = full || {};
      var erows =
        dl('Account holder', editInput('ep-holder', f.accountHolderName, 'Name on account')) +
        dl('Bank name', editInput('ep-bank', f.bankName, 'Bank name')) +
        dl('Account number', editInput('ep-acct', f.accountNumber, 'Account number')) +
        dl('IBAN', editInput('ep-iban', f.iban, 'IBAN')) +
        dl('Routing number', editInput('ep-routing', f.routingNumber, 'Routing number')) +
        dl('IFSC code', editInput('ep-ifsc', f.ifscCode, 'IFSC code')) +
        dl('SWIFT / BIC', editInput('ep-swift', f.swiftCode, 'SWIFT / BIC')) +
        dl('PAN number', editInput('ep-pan', f.panNumber, 'PAN')) +
        dl('Tax ID number', editInput('ep-taxid', f.taxIdNumber, 'Tax ID'));
      return (
        '<div class="card">' +
        cardTitleBar('Payment account', true, 'edit-payment', 'save-payment', 'cancel-payment') +
        '<div class="detail-list">' + erows + '</div>' +
        (state.saveError ? '<div class="save-err">' + esc(state.saveError) + '</div>' : '') +
        '</div>'
      );
    }

    // Reveal (full) view.
    if (state.revealPay && full) {
      var rrows =
        dl('Account holder', esc(full.accountHolderName || pay.accountHolder || '—')) +
        (full.bankName ? dl('Bank name', esc(full.bankName)) : '') +
        (full.accountNumber ? dl('Account number', monoV(full.accountNumber)) : '') +
        (full.iban ? dl('IBAN', monoV(full.iban)) : '') +
        (full.routingNumber ? dl('Routing number', monoV(full.routingNumber)) : '') +
        (full.ifscCode ? dl('IFSC code', monoV(full.ifscCode)) : '') +
        (full.swiftCode ? dl('SWIFT / BIC', monoV(full.swiftCode)) : '') +
        (full.panNumber ? dl('PAN', monoV(full.panNumber)) : '') +
        (full.taxIdNumber ? dl('Tax ID', monoV(full.taxIdNumber)) : '') +
        dl('Payment method', esc(pay.paymentMethod || '—'));
      return (
        '<div class="card">' +
        '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center">Payment account' +
        '<span style="display:flex;gap:14px"><button class="linklike" data-act="edit-payment">Edit</button><button class="linklike" data-act="hide-pay">Hide</button></span></div>' +
        '<div class="detail-list">' + rrows + '</div></div>'
      );
    }

    // Masked view.
    var revealBtn = pay.bankLast4
      ? ' <button class="linklike" data-act="reveal-pay">' +
        (state.contractsLoading && !state.editPayment ? 'Revealing…' : 'Reveal') +
        '</button>'
      : '';
    return (
      '<div class="card">' +
      '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center">Payment account<button class="linklike" data-act="edit-payment">Edit</button></div>' +
      '<div class="detail-list">' +
      dl('Account holder', esc(pay.accountHolder || '—')) +
      dl('Bank account', '<span class="mono">' + (pay.bankLast4 ? '•••• •••• ' + esc(pay.bankLast4) : '—') + '</span>' + revealBtn) +
      dl('Payment method', esc(pay.paymentMethod || '—')) +
      dl('Tax status', esc(pay.taxStatus || '—')) +
      '</div></div>'
    );
  }
  function dl(k, v) {
    return '<div><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';
  }

  function contractHistory(contracts) {
    var head =
      '<div class="st-headrow" style="display:grid;grid-template-columns:1.4fr 1fr 1fr 0.8fr 0.8fr 90px"><div>Campaign / Brand</div><div>Start</div><div>End</div><div>Value</div><div>Status</div><div></div></div>';
    var rows =
      contracts && contracts.length
        ? contracts
            .map(function (ct, i) {
              return (
                '<div class="st-row st-row-click" data-act="view-contract" data-idx="' +
                i +
                '" style="display:grid;grid-template-columns:1.4fr 1fr 1fr 0.8fr 0.8fr 90px;cursor:pointer">' +
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
                '</span></div>' +
                '<div class="dim" style="font-size:12px;font-weight:600">View →</div></div>'
              );
            })
            .join('')
        : '<div class="empty">No contracts on record.</div>';
    var title =
      '<div class="st-title" style="display:flex;justify-content:space-between;align-items:center">Contract history' +
      (contracts && contracts.length
        ? '<span class="dim" style="font-size:12px;font-weight:500">Click a row to view the signed contract</span>'
        : '') +
      '</div>';
    return '<div class="section-table">' + title + head + rows + '</div>';
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
    // Prefer the merged list (contracts + influence-stats); fall back to
    // contracts for older API responses.
    var list = p.campaignList && p.campaignList.length ? p.campaignList : p.contracts;
    var cols = 'display:grid;grid-template-columns:1.5fr 1.6fr 1.3fr 0.8fr 1fr 0.8fr;gap:12px';
    var head =
      '<div class="st-headrow" style="' + cols + '"><div>Campaign / Brand</div><div>Deliverables</div><div>Usage rights</div><div>Views</div><div>Dates</div><div>Status</div></div>';
    var rows =
      list && list.length
        ? list
            .map(function (ct) {
              var delivSub = [ct.platform, ct.numberOfDeliverables ? ct.numberOfDeliverables + ' deliverable' + (ct.numberOfDeliverables === 1 ? '' : 's') : null]
                .filter(Boolean)
                .join(' · ');
              var rightsSub = ct.exclusivity && ct.exclusivity !== 'None' ? 'Exclusivity: ' + ct.exclusivity : '';
              var due = ct.deadline || ct.end;
              // Where this campaign row came from — contract, stats, or both.
              var srcLabel = ct.source === 'stats' ? 'From performance data' : ct.source === 'both' ? 'Contract + performance' : '';
              return (
                '<div class="st-row" style="' + cols + '">' +
                '<div><div style="font-weight:600">' +
                esc(ct.campaign) +
                '</div><div class="dim" style="font-size:12px">' +
                esc(ct.brand) +
                '</div>' +
                (srcLabel ? '<div class="dim" style="font-size:11px;opacity:.7">' + esc(srcLabel) + '</div>' : '') +
                '</div>' +
                '<div><div>' +
                esc(ct.deliverables || '—') +
                '</div>' +
                (delivSub ? '<div class="dim" style="font-size:12px">' + esc(delivSub) + '</div>' : '') +
                '</div>' +
                '<div><div>' +
                esc(ct.usageRights || '—') +
                '</div>' +
                (rightsSub ? '<div class="dim" style="font-size:12px">' + esc(rightsSub) + '</div>' : '') +
                '</div>' +
                '<div class="mono">' +
                (ct.views != null ? fmtNum(ct.views) : '—') +
                '</div>' +
                '<div class="dim"><div>' +
                fmtMonth(ct.start) +
                '</div>' +
                (due ? '<div style="font-size:12px">Due ' + fmtDate(due) + '</div>' : '') +
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
    return '<div class="section-table"><div class="st-title">Campaigns · deliverables &amp; rights</div>' + head + rows + '</div>';
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
    // Clicking the dimmed backdrop (but not the dialog) closes the modal.
    if (e.target.classList && e.target.classList.contains('modal-overlay')) {
      return setState({ modalContractId: null });
    }
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (act === 'theme') return toggleTheme();
    if (act === 'usage') return setState({ usageFilter: el.getAttribute('data-usage') });
    if (act === 'reveal-pay') {
      return loadContractsFull(function () {
        setState({ revealPay: true });
      });
    }
    if (act === 'hide-pay') return setState({ revealPay: false });
    if (act === 'view-contract') {
      var idx = parseInt(el.getAttribute('data-idx'), 10) || 0;
      return loadContractsFull(function () {
        setState({ modalContractId: idx });
      });
    }
    if (act === 'close-modal') return setState({ modalContractId: null });
    // ---- inline edit of contact + payment ----
    if (act === 'edit-contact') return setState({ editContact: true, saveError: null });
    if (act === 'cancel-contact') return setState({ editContact: false, saveError: null });
    if (act === 'save-contact') return saveContact();
    if (act === 'edit-payment') {
      // Needs the full payout details to seed the form.
      return loadContractsFull(function () {
        setState({ editPayment: true, revealPay: false, saveError: null });
      });
    }
    if (act === 'cancel-payment') return setState({ editPayment: false, saveError: null });
    if (act === 'save-payment') return savePayment();
    if (act === 'signout') {
      fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
      setState({ view: 'login', username: '', password: '', selectedId: null, expandedId: null });
      return;
    }
    if (act === 'toggle') {
      var id = el.getAttribute('data-id');
      return setState({ expandedId: state.expandedId === id ? null : id });
    }
    if (act === 'open') {
      state.selectedId = el.getAttribute('data-id');
      state.activeTab = 'performance';
      loadProfile(state.selectedId);
      return;
    }
    if (act === 'back') return setState({ selectedId: null, profile: null });
    if (act === 'tab') {
      return setState({
        activeTab: el.getAttribute('data-tab'),
        editContact: false,
        editPayment: false,
        saveError: null,
      });
    }
  });

  // Escape closes the signed-contract modal.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.modalContractId !== null) setState({ modalContractId: null });
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
        return mq && matchesUsage(c);
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
