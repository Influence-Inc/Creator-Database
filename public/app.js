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
    // Roster sort — click a column header to change. Views-desc by default so
    // the biggest creators lead.
    sortKey: 'views',
    sortDir: 'desc',
    selectedId: null,
    activeTab: 'contract',
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
    // Cmd+K command palette — universal search across the loaded roster.
    cmdkOpen: false,
    cmdkQuery: '',
    cmdkIndex: 0,
    // Transient confirmation banner ({text, kind}) — cleared on a timer.
    toast: null,
  };

  // Tabs surfaced in the URL (profile view). Kept in sync with TAB_DEFS below.
  // 'contract' is the default, so it's the tab a bare '#/c/:id' URL lands on.
  var TAB_KEYS = ['contract', 'campaigns'];
  var DEFAULT_TAB = 'contract';

  var root = document.getElementById('root');

  // ---- routing (hash-based) -----------------------------------------------
  // Hash routes: '#/' → roster, '#/c/:id' → profile (default tab),
  // '#/c/:id/<tab>' → profile with tab. Hash routing keeps deep-links working
  // without needing an SPA fallback on the API server.
  function parseHash() {
    var h = String(window.location.hash || '').replace(/^#/, '');
    if (!h || h === '/') return { selectedId: null, activeTab: DEFAULT_TAB };
    var parts = h.split('/').filter(Boolean); // ['c', ':id', ':tab?']
    if (parts[0] === 'c' && parts[1]) {
      // An unknown tab (e.g. a stale '/performance' link) falls back to the
      // default rather than rendering nothing.
      var tab = parts[2] && TAB_KEYS.indexOf(parts[2]) >= 0 ? parts[2] : DEFAULT_TAB;
      return { selectedId: decodeURIComponent(parts[1]), activeTab: tab };
    }
    return { selectedId: null, activeTab: DEFAULT_TAB };
  }
  function hashFor(sel, tab) {
    if (!sel) return '#/';
    var t = tab && tab !== DEFAULT_TAB ? '/' + tab : '';
    return '#/c/' + encodeURIComponent(sel) + t;
  }
  // Sync the URL to the current state. Suppressed while we're applying a hash
  // that the user typed / used the back button on, so we don't push a dup entry.
  var suppressHashSync = false;
  function syncUrlToState() {
    if (state.view !== 'app') return;
    var next = hashFor(state.selectedId, state.activeTab);
    if (next === (window.location.hash || '#/')) return;
    suppressHashSync = true;
    // pushState avoids reloading; the '#' change also updates history normally.
    window.history.pushState(null, '', next);
    suppressHashSync = false;
  }
  // Apply the current URL to state (used on boot and on back/forward).
  function applyHashToState() {
    if (state.view !== 'app') return;
    var r = parseHash();
    var changed = r.selectedId !== state.selectedId || r.activeTab !== state.activeTab;
    if (!changed) return;
    state.selectedId = r.selectedId;
    state.activeTab = r.activeTab;
    state.editContact = false;
    state.editPayment = false;
    state.saveError = null;
    if (r.selectedId) {
      if (!state.profile || state.profile.id !== r.selectedId) {
        loadProfile(r.selectedId);
      } else {
        render();
      }
    } else {
      state.profile = null;
      render();
    }
  }

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
    // Redundant when the segment filter already guarantees it — a column of
    // identical "Used" chips is noise. Only meaningful on the mixed "All" view.
    if (state.usageFilter !== 'All') return '';
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

  // Free-text roster match — name, @handle, platforms and last campaign, so the
  // same query works whether you remember the person or the work.
  function matchesQuery(c, q) {
    if (!q) return true;
    return (
      (c.name && c.name.toLowerCase().indexOf(q) >= 0) ||
      (c.handle && c.handle.toLowerCase().indexOf(q) >= 0) ||
      (c.lastCampaign && c.lastCampaign.toLowerCase().indexOf(q) >= 0) ||
      (c.platforms || []).join(' ').toLowerCase().indexOf(q) >= 0
    );
  }

  // Sortable roster columns. `num: true` sorts numerically with blanks last.
  var SORT_COLS = [
    { key: 'name', label: 'Creator' },
    { key: 'platforms', label: 'Platforms', sortable: false, cls: 'hide-sm' },
    { key: 'campaigns', label: 'Campaigns', num: true, cls: 'hide-sm' },
    { key: 'views', label: 'Total views', num: true },
    { key: 'cpm', label: 'CPM', num: true, cls: 'hide-sm' },
    { key: 'engagement', label: 'Engagement', num: true, cls: 'hide-sm' },
  ];
  function sortCol(key) {
    for (var i = 0; i < SORT_COLS.length; i++) if (SORT_COLS[i].key === key) return SORT_COLS[i];
    return null;
  }

  // Filter + sort in one place, so the full render and the incremental
  // search re-render can never disagree about what's on screen.
  function visibleCreators() {
    if (!state.roster || !state.roster.creators) return [];
    var q = state.search.trim().toLowerCase();
    var list = state.roster.creators.filter(function (c) {
      return matchesQuery(c, q) && matchesUsage(c);
    });
    var col = sortCol(state.sortKey);
    if (!col) return list;
    var dir = state.sortDir === 'asc' ? 1 : -1;
    return list.slice().sort(function (a, b) {
      if (col.num) {
        var av = a[col.key];
        var bv = b[col.key];
        var aNull = av === null || av === undefined || isNaN(av);
        var bNull = bv === null || bv === undefined || isNaN(bv);
        // Blanks always sink to the bottom, whichever way the column is sorted.
        if (aNull && bNull) return 0;
        if (aNull) return 1;
        if (bNull) return -1;
        return (Number(av) - Number(bv)) * dir;
      }
      return String(a[col.key] || '').localeCompare(String(b[col.key] || '')) * dir;
    });
  }

  // Any filter narrowing the roster? Drives the "Clear filters" affordance.
  function filtersActive() {
    return state.search.trim() !== '' || state.usageFilter !== 'Used';
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
    syncUrlToState();
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

  // URL of a contract's compliant legal document (a Creator Services Agreement,
  // server-rendered, bank/payout details excluded). `opts.print` returns a page
  // that auto-opens the browser's Print → Save as PDF dialog on load.
  function contractDocUrl(contractId, opts) {
    opts = opts || {};
    var qs = [];
    if (opts.download) qs.push('download=1');
    if (opts.print) qs.push('print=1');
    return (
      '/roster/' +
      encodeURIComponent(state.selectedId) +
      '/contracts/' +
      encodeURIComponent(contractId) +
      '/document' +
      (qs.length ? '?' + qs.join('&') : '')
    );
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
    // Path on the URL captured up-front so we can log it on failure — useful
    // when a save silently 4xx/5xxs and the user can't see why.
    var path = '/roster/' + encodeURIComponent(state.selectedId) + '/details';
    fetch(path, {
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
        // Try JSON, fall back to text so a non-JSON error body (e.g. a proxy's
        // 502 HTML page) still surfaces something informative instead of an
        // opaque "Unexpected token" parse crash that reads as "Save failed".
        return r.text().then(function (raw) {
          var parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { /* not JSON */ }
          return { ok: r.ok, status: r.status, j: parsed, raw: raw };
        });
      })
      .then(function (res) {
        if (!res.ok) {
          var m = res.j && res.j.message;
          var msg = Array.isArray(m) ? m.join(', ') : m || (res.raw ? String(res.raw).slice(0, 300) : 'Save failed');
          // Log the full response so devs can see the exact server error in the
          // browser console (the on-page banner keeps the short message).
          console.error('[saveDetails] PATCH ' + path + ' → ' + res.status, res.j || res.raw);
          throw new Error('HTTP ' + res.status + ': ' + msg);
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
        console.error('[saveDetails] failed:', err);
        render();
      });
  }

  function saveContact() {
    if (state.saving) return;
    var ct = (state.profile && state.profile.contact) || {};
    var af = ct.addressFields || {};

    // Send ONLY the fields the admin actually changed. Both email and
    // instagramUsername are unique on the Creator; re-sending an UNCHANGED
    // identity field used to make the backend re-write it, and if that value
    // clashed with another creator the whole save 400'd — so changing just the
    // email could fail because of the untouched Instagram handle. A minimal
    // patch means an unchanged field can't be the culprit.
    var contact = {};
    var current = function (v) { return v == null ? '' : String(v); };
    var changed = function (inputId, cur) {
      var v = fieldVal(inputId);
      return v !== current(cur) ? v : undefined;
    };

    var name = changed('ec-name', ct.creatorName);
    if (name !== undefined) contact.creatorName = name;
    var ig = changed('ec-ig', ct.instagramUsername);
    if (ig !== undefined) contact.instagramUsername = ig;
    var email = changed('ec-email', ct.email);
    if (email !== undefined) contact.email = email;
    var phone = changed('ec-phone', ct.phone);
    if (phone !== undefined) contact.phone = phone;

    // Address is a nested block the backend writes all-or-nothing, so include
    // the whole object only when at least one of its fields changed.
    var addr = {
      line1: fieldVal('ec-line1'),
      line2: fieldVal('ec-line2'),
      city: fieldVal('ec-city'),
      state: fieldVal('ec-state'),
      postalCode: fieldVal('ec-zip'),
      country: fieldVal('ec-country'),
    };
    var addrChanged =
      addr.line1 !== current(af.line1) ||
      addr.line2 !== current(af.line2) ||
      addr.city !== current(af.city) ||
      addr.state !== current(af.state) ||
      addr.postalCode !== current(af.postalCode) ||
      addr.country !== current(af.country);
    if (addrChanged) contact.address = addr;

    // Nothing changed — just leave edit mode, no request (and no chance of a
    // spurious unique-constraint bounce).
    if (Object.keys(contact).length === 0) {
      state.editContact = false;
      render();
      return;
    }

    saveDetails({ contact: contact }, function () {
      state.editContact = false;
      showToast('Contact details saved');
    });
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
        showToast('Payment details saved');
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
    // Breadcrumb doubles as navigation: "Creator Database" is clickable when
    // you're inside a profile, so there's always an obvious way back.
    var inProfile = !!state.selectedId;
    var crumb = inProfile
      ? '<button class="crumb crumb-link" data-act="back">Creator Database</button>' +
        '<span class="crumb-sep">/</span>' +
        '<span class="crumb crumb-now">' +
        esc((state.profile && state.profile.name) || 'Creator') +
        '</span>'
      : '<span class="crumb">Creator Database</span>';
    return (
      '<div class="topbar">' +
      '<div class="left">' +
      '<button class="brand-mark" data-act="back" title="Back to roster">' +
      WORDMARK +
      '</button>' +
      '<div class="divider"></div>' +
      '<div class="crumbs">' +
      crumb +
      '</div>' +
      '</div>' +
      '<div class="right">' +
      '<button class="cmdk-btn" data-act="open-cmdk" title="Search (Cmd+K)">' +
      '<span>⚲</span><span class="cmdk-btn-t">Search</span>' +
      '<span class="cmdk-kbd cmdk-kbd-sm">⌘K</span>' +
      '</button>' +
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

  // Sortable column header. Clicking toggles direction; the active column keeps
  // a persistent arrow so the current sort is always readable.
  function headCell(col) {
    var cls = 'rh' + (col.cls ? ' ' + col.cls : '');
    if (col.sortable === false) return '<div class="' + cls + '">' + esc(col.label) + '</div>';
    var active = state.sortKey === col.key;
    var arrow = active ? (state.sortDir === 'asc' ? '↑' : '↓') : '';
    return (
      '<div class="' +
      cls +
      ' sortable' +
      (active ? ' sorted' : '') +
      '" data-act="sort" data-key="' +
      col.key +
      '" title="Sort by ' +
      esc(col.label) +
      '">' +
      esc(col.label) +
      '<span class="sort-arrow">' +
      arrow +
      '</span></div>'
    );
  }
  function rosterHead() {
    return (
      '<div class="roster-grid roster-head">' +
      SORT_COLS.map(headCell).join('') +
      '<div></div></div>'
    );
  }

  // Grey placeholder rows while the roster is in flight — steadier than a bare
  // spinner because the table's shape is already on screen.
  function skeletonRows(n) {
    var one =
      '<div class="roster-grid roster-row skel-row">' +
      '<div class="creator-cell"><div class="skel skel-pfp"></div><div style="flex:1">' +
      '<div class="skel skel-line" style="width:44%"></div>' +
      '<div class="skel skel-line sm" style="width:28%"></div></div></div>' +
      '<div class="hide-sm"><div class="skel skel-line" style="width:50%"></div></div>' +
      '<div class="hide-sm"><div class="skel skel-line" style="width:36%"></div></div>' +
      '<div><div class="skel skel-line" style="width:52%"></div></div>' +
      '<div class="hide-sm"><div class="skel skel-line" style="width:44%"></div></div>' +
      '<div class="hide-sm"><div class="skel skel-line" style="width:40%"></div></div>' +
      '<div></div></div>';
    return new Array(n + 1).join(one);
  }

  // Compact orientation tiles above the table — they describe the CURRENT
  // filtered view, so they change as you search or switch segments.
  function rosterSummary(list) {
    var views = 0;
    var camps = 0;
    for (var i = 0; i < list.length; i++) {
      views += list[i].views || 0;
      camps += list[i].campaigns || 0;
    }
    return (
      '<div class="summary-row">' +
      summaryTile('Creators shown', String(list.length)) +
      summaryTile('Campaigns', String(camps)) +
      summaryTile('Combined views', fmtNum(views)) +
      '</div>'
    );
  }
  function summaryTile(k, v) {
    return (
      '<div class="sum-tile"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>'
    );
  }

  // Everything below the page header — re-rendered on its own while typing so
  // the search box keeps focus.
  function rosterBody() {
    var data = state.roster;
    var list = visibleCreators();
    var rows;
    if (data.total === 0) {
      rows =
        '<div class="empty">' +
        (state.rosterError
          ? '<div class="empty-t">Could not reach the API</div><div class="empty-s">Check the service is running, then reload.</div>'
          : '<div class="empty-t">No creators yet</div><div class="empty-s">Records appear here as outreach, contract and stats syncs run.</div>') +
        '</div>';
    } else if (list.length === 0) {
      rows =
        '<div class="empty"><div class="empty-t">No creators match your filters</div>' +
        '<div class="empty-s">Try a different search, or widen the segment.</div>' +
        '<button class="btn-accent" style="margin-top:16px" data-act="clear-filters">Clear filters</button></div>';
    } else {
      rows = list.map(rosterRow).join('');
    }
    return rosterSummary(list) + '<div class="table">' + rosterHead() + rows + '</div>';
  }

  function rosterView() {
    var data = state.roster;
    var head =
      '<div class="page-head">' +
      '<div><div class="page-title">Creator roster</div><div class="page-sub" id="roster-count">' +
      (data === null ? 'Loading…' : esc(visibleCreators().length + ' of ' + data.total + ' creators')) +
      '</div></div>' +
      '<div class="toolbar">' +
      '<div class="search"><span class="search-i">⚲</span>' +
      '<input id="search" type="text" placeholder="Search name, @handle, platform…" value="' +
      esc(state.search) +
      '" autocomplete="off">' +
      (state.search ? '<button class="search-x" data-act="clear-search" title="Clear">✕</button>' : '') +
      '</div>' +
      usageChips() +
      '</div></div>';

    var body =
      data === null
        ? '<div class="table">' + rosterHead() + skeletonRows(6) + '</div>'
        : '<div id="roster-body">' + rosterBody() + '</div>';

    return (
      '<div class="app">' + topbar() + '<div class="page list fade">' + head + body + '</div></div>'
    );
  }

  function rosterRow(c) {
    var plats = (c.platforms || [])
      .map(function (p) {
        return '<div class="plat">' + esc(p) + '</div>';
      })
      .join('');
    // Whole row is the click target — a single click opens the profile.
    return (
      '<div class="roster-grid roster-row" data-act="open" data-id="' +
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
      '<div class="chev">›</div>' +
      '</div>'
    );
  }

  // ---- profile ------------------------------------------------------------
  // Performance now lives in the hero as profile stats, so the profile is just
  // two tabs: the paperwork, and the work.
  var TAB_DEFS = [
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
    // View / download the compliant legal contract (bank details excluded).
    var docActions =
      '<button class="linklike" data-act="view-doc" data-cid="' +
      esc(c.id) +
      '" title="Open the compliant legal contract in a new tab">Legal document ↗</button>' +
      '<button class="linklike" data-act="download-doc" data-cid="' +
      esc(c.id) +
      '" title="Open the contract and save it as a PDF (Print → Save as PDF)">Download PDF</button>';

    return (
      '<div class="modal-overlay">' +
      '<div class="modal">' +
      '<div class="modal-head"><div style="font-size:16px;font-weight:700">Signed contract' +
      multi +
      '</div><div style="display:flex;gap:16px;align-items:center">' +
      docActions +
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

  // Profile header: identity on the left, performance as a stat strip directly
  // beneath the name. These numbers used to sit behind a Performance tab; as
  // header stats they're context for everything else on the page.
  function heroCard(p) {
    var plats = (p.platformBreakdown || [])
      .map(function (pf) {
        return '<span class="hero-plat">' + esc(pf.name) + '</span>';
      })
      .join('');
    var signed = (p.contracts || []).length;

    var stats =
      stat('Combined views', fmtNum(p.views), 'Total views across every campaign on record') +
      stat('Blended CPM', fmtCpm(p.cpm), 'Cost per thousand views, blended across campaigns') +
      stat('Engagement', fmtPct(p.engagement), 'Average engagement rate') +
      stat('Campaigns', String(p.campaigns), 'Campaigns from contracts and performance data') +
      stat('Contracts', String(signed), 'Contracts on record') +
      (p.followers != null ? stat('Followers', fmtNum(p.followers), 'Follower count on the primary platform') : '');

    return (
      '<div class="card card-lg profile-hero">' +
      '<div class="hero-id">' +
      '<div class="pfp-lg">' +
      esc(p.initials) +
      '</div>' +
      '<div class="hero-idtext">' +
      '<div class="hero-name">' +
      esc(p.name) +
      '</div>' +
      '<div class="hero-meta">' +
      '<span class="creator-handle mono">' +
      esc(p.handle) +
      '</span>' +
      (plats ? '<span class="hero-plats">' + plats + '</span>' : '') +
      '</div></div></div>' +
      '<div class="hero-stats">' +
      stats +
      '</div></div>'
    );
  }
  function stat(k, v, tip) {
    return (
      '<div class="stat"' +
      (tip ? ' title="' + esc(tip) + '"' : '') +
      '><div class="k">' +
      esc(k) +
      '</div><div class="v">' +
      v +
      '</div></div>'
    );
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
    return state.activeTab === 'campaigns' ? campaignsTab(p) : contractTab(p);
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
        // Error banner at the TOP so a failed save is immediately visible —
        // the old bottom-of-card placement sat below the address block and
        // read as "no feedback" to anyone who didn't scroll.
        (state.saveError ? '<div class="save-err">' + esc(state.saveError) + '</div>' : '') +
        '<div class="detail-list">' +
        // Identity — editable directly on the master Creator record even before
        // a contract exists (see updateDetails in roster.service.ts).
        dl('Name', editInput('ec-name', ct.creatorName, 'Full name')) +
        dl('Instagram', editInput('ec-ig', ct.instagramUsername, '@handle')) +
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
        '</div>';
    } else {
      body =
        '<div class="detail-list">' +
        dl('Name', esc(ct.creatorName || '—')) +
        dl(
          'Instagram',
          ct.instagramUsername
            ? copyable('@' + ct.instagramUsername, ct.instagramUsername)
            : '—',
        ) +
        dl('Email', ct.email ? copyable(ct.email, ct.email) : '—') +
        dl('Phone', ct.phone ? copyable(ct.phone, ct.phone) : '—') +
        dl('Registered address', esc(ct.address || '—')) +
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
        // Same top-of-form placement as the contact card — surface errors above
        // the fields so a failed save can't be missed.
        (state.saveError ? '<div class="save-err">' + esc(state.saveError) + '</div>' : '') +
        '<div class="detail-list">' + erows + '</div>' +
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
  // A mono value with a click-to-copy affordance — these are fields an admin
  // routinely pastes elsewhere (email, handle, phone).
  function copyable(display, raw) {
    return (
      '<span class="copyable" data-act="copy" data-copy="' +
      esc(raw) +
      '" title="Click to copy"><span class="mono">' +
      esc(display) +
      '</span><span class="copy-i">⧉</span></span>'
    );
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

  // Where a creator's views actually came from. Lives alongside the campaign
  // table now that the Performance tab is gone.
  function platformCard(p) {
    return (
      '<div class="card"><div class="card-title">Views by platform</div>' +
      bars(p.platformBreakdown, function (pf) {
        return fmtNum(pf.views) + ' · ' + fmtPct(pf.engagement) + ' eng.';
      }) +
      '</div>'
    );
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
    return (
      '<div class="stack">' +
      '<div class="section-table"><div class="st-title">Campaigns · deliverables &amp; rights</div>' +
      head +
      rows +
      '</div>' +
      platformCard(p) +
      '</div>'
    );
  }

  // ---- command palette (Cmd/Ctrl + K) -------------------------------------
  // Universal search over the loaded roster. Ranks by field priority (handle >
  // name > platforms > last campaign). No API round-trip — the roster is
  // preloaded up-front, so this is instant even for large lists.
  function cmdkResults() {
    if (!state.roster || !state.roster.creators) return [];
    var q = state.cmdkQuery.trim().toLowerCase();
    var all = state.roster.creators;
    if (!q) return all.slice(0, 12);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      var hay = [
        c.handle || '',
        c.name || '',
        (c.platforms || []).join(' '),
        c.lastCampaign || '',
      ].map(function (s) { return String(s).toLowerCase(); });
      var score = -1;
      for (var j = 0; j < hay.length; j++) {
        if (hay[j].indexOf(q) >= 0) {
          score = j; // lower is better (0 = handle match)
          break;
        }
      }
      if (score >= 0) out.push({ c: c, score: score });
      if (out.length > 200) break;
    }
    out.sort(function (a, b) { return a.score - b.score; });
    return out.slice(0, 25).map(function (x) { return x.c; });
  }
  function openCmdk() {
    state.cmdkOpen = true;
    state.cmdkQuery = '';
    state.cmdkIndex = 0;
    render();
    // Focus the input after the DOM is in place.
    var input = document.getElementById('cmdk-input');
    if (input) input.focus();
  }
  function cmdkKey(e) {
    var results = cmdkResults();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.cmdkIndex = Math.min(state.cmdkIndex + 1, Math.max(0, results.length - 1));
      renderCmdkList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.cmdkIndex = Math.max(state.cmdkIndex - 1, 0);
      renderCmdkList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var pick = results[state.cmdkIndex];
      if (!pick) return;
      state.selectedId = pick.id;
      state.activeTab = DEFAULT_TAB;
      state.cmdkOpen = false;
      state.cmdkQuery = '';
      syncUrlToState();
      loadProfile(pick.id);
    }
  }
  function cmdkResultRow(c, i) {
    var plats = (c.platforms || []).slice(0, 3).join(' · ');
    return (
      '<div class="cmdk-row' +
      (i === state.cmdkIndex ? ' active' : '') +
      '" data-act="open" data-id="' +
      esc(c.id) +
      '" data-cmdk-idx="' +
      i +
      '">' +
      '<div class="pfp cmdk-pfp">' +
      esc(c.initials || '') +
      '</div>' +
      '<div class="cmdk-main"><div class="cmdk-name">' +
      esc(c.name || '—') +
      '</div><div class="cmdk-sub mono">' +
      esc(c.handle || '') +
      (plats ? '<span class="cmdk-sep">·</span>' + esc(plats) : '') +
      '</div></div>' +
      '<div class="cmdk-hint mono">' +
      (i === state.cmdkIndex ? '↵' : '') +
      '</div>' +
      '</div>'
    );
  }
  // Rerender only the results list, so typing doesn't lose input focus.
  function renderCmdkList() {
    var list = document.getElementById('cmdk-list');
    if (!list) return;
    var results = cmdkResults();
    if (!results.length) {
      list.innerHTML = '<div class="cmdk-empty">No creators match.</div>';
      return;
    }
    if (state.cmdkIndex >= results.length) state.cmdkIndex = 0;
    list.innerHTML = results.map(cmdkResultRow).join('');
  }
  function cmdkView() {
    if (!state.cmdkOpen) return '';
    var results = cmdkResults();
    var body = results.length
      ? results.map(cmdkResultRow).join('')
      : '<div class="cmdk-empty">No creators match.</div>';
    return (
      '<div class="cmdk-overlay" data-act="close-cmdk">' +
      '<div class="cmdk" data-cmdk-stop="1">' +
      '<div class="cmdk-head"><span class="cmdk-icon">⚲</span>' +
      '<input id="cmdk-input" class="cmdk-input" type="text" placeholder="Search creators by name, @handle, platform…" value="' +
      esc(state.cmdkQuery) +
      '" autocomplete="off" spellcheck="false" />' +
      '<span class="cmdk-kbd">esc</span></div>' +
      '<div id="cmdk-list" class="cmdk-list">' + body + '</div>' +
      '<div class="cmdk-foot"><span><span class="cmdk-kbd">↑</span><span class="cmdk-kbd">↓</span> navigate</span>' +
      '<span><span class="cmdk-kbd">↵</span> open</span>' +
      '<span><span class="cmdk-kbd">esc</span> close</span></div>' +
      '</div></div>'
    );
  }

  // ---- toasts -------------------------------------------------------------
  // Short confirmation for actions whose result isn't otherwise visible —
  // a successful save used to just close the form with no acknowledgement.
  var toastTimer = null;
  function showToast(text, kind) {
    state.toast = { text: text, kind: kind || 'ok' };
    render();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      state.toast = null;
      render();
    }, 2600);
  }
  function toastView() {
    if (!state.toast) return '';
    return (
      '<div class="toast ' +
      esc(state.toast.kind) +
      '"><span class="toast-i">' +
      (state.toast.kind === 'err' ? '!' : '✓') +
      '</span>' +
      esc(state.toast.text) +
      '</div>'
    );
  }

  // ---- render + events ----------------------------------------------------
  function render() {
    if (state.view === 'loading') {
      root.innerHTML = '<div class="spinner"></div>';
    } else if (state.view === 'login') {
      root.innerHTML = loginView();
    } else if (state.selectedId) {
      root.innerHTML = profileView() + cmdkView() + toastView();
    } else {
      root.innerHTML = rosterView() + cmdkView() + toastView();
    }
    // Refocus the palette input after a full re-render (opened via keybind or
    // topbar button). Cursor placed at the end for continued typing.
    if (state.cmdkOpen) {
      var input = document.getElementById('cmdk-input');
      if (input && document.activeElement !== input) {
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
      }
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
    if (act === 'sort') {
      var key = el.getAttribute('data-key');
      var col = sortCol(key);
      if (!col) return;
      // Same column toggles direction; a new column starts on the ordering
      // that's most useful for it — biggest-first for numbers, A-Z for text.
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = col.num ? 'desc' : 'asc';
      }
      return render();
    }
    if (act === 'clear-search') {
      state.search = '';
      return render();
    }
    if (act === 'clear-filters') {
      state.search = '';
      state.usageFilter = 'All';
      return render();
    }
    if (act === 'copy') {
      var text = el.getAttribute('data-copy') || '';
      if (!text) return;
      var done = function () { showToast('Copied to clipboard'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          showToast('Could not copy', 'err');
        });
      } else {
        // Fallback for non-secure contexts, where the async clipboard API is
        // unavailable.
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (_) { showToast('Could not copy', 'err'); }
        document.body.removeChild(ta);
      }
      return;
    }
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
    if (act === 'view-doc') {
      // Open synchronously inside the click handler so popup blockers allow it.
      window.open(contractDocUrl(el.getAttribute('data-cid')), '_blank', 'noopener');
      return;
    }
    if (act === 'download-doc') {
      // Open the print-ready page; it auto-invokes the browser's Print → Save
      // as PDF dialog once loaded. Opened synchronously so popup blockers allow
      // it, and same-origin so cookies ride along.
      window.open(contractDocUrl(el.getAttribute('data-cid'), { print: true }), '_blank', 'noopener');
      return;
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
      setState({ view: 'login', username: '', password: '', selectedId: null });
      return;
    }
    if (act === 'open') {
      var openId = el.getAttribute('data-id');
      state.selectedId = openId;
      state.activeTab = DEFAULT_TAB;
      state.cmdkOpen = false;
      state.cmdkQuery = '';
      syncUrlToState();
      loadProfile(openId);
      return;
    }
    if (act === 'back') return setState({ selectedId: null, profile: null });
    if (act === 'open-cmdk') return openCmdk();
    if (act === 'close-cmdk') {
      // Only the backdrop dismisses — clicks inside the palette shouldn't close it.
      if (e.target.closest('.cmdk')) return;
      return setState({ cmdkOpen: false, cmdkQuery: '' });
    }
    if (act === 'tab') {
      return setState({
        activeTab: el.getAttribute('data-tab'),
        editContact: false,
        editPayment: false,
        saveError: null,
      });
    }
  });

  // Global key bindings: Cmd/Ctrl+K opens the command palette; Escape dismisses
  // whichever overlay is open (palette first, then the contract modal).
  document.addEventListener('keydown', function (e) {
    var mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      if (state.view !== 'app') return;
      e.preventDefault();
      state.cmdkOpen ? setState({ cmdkOpen: false, cmdkQuery: '' }) : openCmdk();
      return;
    }
    if (e.key === 'Escape') {
      if (state.cmdkOpen) return setState({ cmdkOpen: false, cmdkQuery: '' });
      if (state.modalContractId !== null) return setState({ modalContractId: null });
    }
    if (state.cmdkOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
      cmdkKey(e);
      return;
    }
    // '/' jumps to the roster search — the usual table-app shortcut. Ignored
    // while typing somewhere else.
    if (e.key === '/' && !mod && state.view === 'app' && !state.selectedId) {
      var t = e.target;
      var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) return;
      var box = document.getElementById('search');
      if (box) {
        e.preventDefault();
        box.focus();
        box.select();
      }
    }
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
          // Honour a deep-link URL entered before the user logged in.
          var route = parseHash();
          state.selectedId = route.selectedId;
          state.activeTab = route.activeTab;
          loadRoster();
          if (route.selectedId) loadProfile(route.selectedId);
        } else {
          setState({ loginError: true, loggingIn: false });
        }
      })
      .catch(function () {
        setState({ loginError: true, loggingIn: false });
      });
  });

  // Palette input — update query without a full re-render so focus stays.
  root.addEventListener('input', function (e) {
    if (e.target.id === 'cmdk-input') {
      state.cmdkQuery = e.target.value;
      state.cmdkIndex = 0;
      renderCmdkList();
      return;
    }
    // fall through to roster search handler below
    if (e.target.id === 'search') {
      state.search = e.target.value;
      if (!state.roster) return;
      // Re-render the summary + table only, so the input keeps focus and the
      // caret doesn't jump while typing.
      var body = document.getElementById('roster-body');
      var sub = document.getElementById('roster-count');
      if (sub) sub.textContent = visibleCreators().length + ' of ' + state.roster.total + ' creators';
      if (body) body.innerHTML = rosterBody();
      // The clear (✕) button lives inside the search box, which we deliberately
      // don't re-render — toggle it directly instead.
      var x = root.querySelector('.search-x');
      if (state.search && !x) {
        var box = root.querySelector('.search');
        if (box) {
          var btn = document.createElement('button');
          btn.className = 'search-x';
          btn.setAttribute('data-act', 'clear-search');
          btn.title = 'Clear';
          btn.textContent = '✕';
          box.appendChild(btn);
        }
      } else if (!state.search && x) {
        x.parentNode.removeChild(x);
      }
    }
  });

  // Back / forward navigation → re-apply the URL to state.
  window.addEventListener('hashchange', function () {
    if (suppressHashSync) return;
    applyHashToState();
  });
  window.addEventListener('popstate', function () {
    if (suppressHashSync) return;
    applyHashToState();
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
          // Apply the URL (deep-link) BEFORE fetching the roster so profile
          // requests can fire in parallel. If the URL asks for a creator page,
          // its profile loads alongside the roster.
          var route = parseHash();
          state.selectedId = route.selectedId;
          state.activeTab = route.activeTab;
          loadRoster();
          if (route.selectedId) loadProfile(route.selectedId);
          else render();
        } else {
          setState({ view: 'login' });
        }
      })
      .catch(function () {
        setState({ view: 'login' });
      });
  })();
})();
