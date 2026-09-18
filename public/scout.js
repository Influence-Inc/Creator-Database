/* =========================================================================
 * Scouting sheet — the page manual scouters use.
 *
 * Deliberately a separate, small bundle from the admin console (app.js): a
 * scout never downloads the Creator Database UI, and the only API surface this
 * page touches is /auth/* and /scouts/entries (which the server scopes to the
 * signed-in scout's own rows).
 *
 * Qualification and notes are rendered read-only here — they're the admin's
 * verdict. The server enforces that too; this is just the honest UI for it.
 * ========================================================================= */
(function () {
  'use strict';

  var WORDMARK =
    '<svg viewBox="0 0 793 70" role="img" aria-label="INFLUENCE"><path d="M20.01 68.6729H1.35348e-05V1.03334H20.01V68.6729ZM126.221 69.8941L55.1993 29.4044V68.6729H42.5169V-4.03086e-05L113.538 40.3018V1.03334H126.221V69.8941ZM209.764 44.2475H168.992V68.6729H148.794V1.03334H219.816V11.9308H169.086V33.35H209.764V44.2475ZM306.528 68.6729H236.54V1.03334H256.738V57.7754H306.528V68.6729ZM389.07 34.6652V1.03334H401.847V34.6652C401.847 40.8029 400.813 46.1577 398.747 50.7296C396.742 55.3015 393.861 58.934 390.104 61.6271C386.409 64.3201 382.15 66.3243 377.327 67.6395C372.505 68.9547 367.119 69.6123 361.169 69.6123C348.706 69.6123 338.81 66.7627 331.483 61.0634C324.218 55.3642 320.585 46.6274 320.585 34.8531V1.03334H341.065V34.6652C341.065 38.8614 341.754 42.4939 343.132 45.5627C344.51 48.6315 346.357 51.0114 348.675 52.7024C351.054 54.3934 353.591 55.646 356.284 56.4602C359.04 57.2117 361.983 57.5875 365.115 57.5875C368.246 57.5875 371.158 57.2117 373.851 56.4602C376.607 55.646 379.144 54.3934 381.461 52.7024C383.841 51.0114 385.688 48.6315 387.004 45.5627C388.381 42.4939 389.07 38.8614 389.07 34.6652ZM494.814 68.6729H423.041V1.03334H494.814V11.9308H443.238V28.7468H484.386V39.6442H443.238V57.7754H494.814V68.6729ZM596.325 69.8941L525.303 29.4044V68.6729H512.621V-4.03086e-05L583.643 40.3018V1.03334H596.325V69.8941ZM702.321 52.6085V63.7878C692.989 67.796 681.778 69.8002 668.689 69.8002C657.917 69.8002 648.428 68.4536 640.224 65.7606C632.082 63.0049 625.694 58.9653 621.059 53.6418C616.425 48.3184 614.108 42.0555 614.108 34.8531C614.108 24.0809 619.087 15.6259 629.045 9.48828C639.003 3.28799 652.217 0.187845 668.689 0.187845C681.966 0.187845 693.177 2.19198 702.321 6.20025V18.5069C693.302 13.4965 682.78 10.9914 670.756 10.9914C659.545 10.9914 650.84 13.246 644.639 17.7553C638.439 22.202 635.339 27.9013 635.339 34.8531C635.339 41.8676 638.439 47.6294 644.639 52.1387C650.902 56.648 659.796 58.9027 671.319 58.9027C682.029 58.9027 692.363 56.8046 702.321 52.6085ZM792.821 68.6729H721.048V1.03334H792.821V11.9308H741.246V28.7468H782.393V39.6442H741.246V57.7754H792.821V68.6729Z"/></svg>';

  var GENDERS = [
    { value: '', label: '—' },
    { value: 'MALE', label: 'Male' },
    { value: 'FEMALE', label: 'Female' },
    { value: 'OTHER', label: 'Other' }
  ];

  var state = {
    view: 'loading', // loading | login | sheet
    username: '',
    password: '',
    loginError: '',
    loggingIn: false,
    me: null,
    rows: [],
    loadError: '',
    adding: false,
    toast: null
  };

  var root = document.getElementById('root');

  // ---- helpers ------------------------------------------------------------

  function esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, options) {
    var opts = options || {};
    return fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (res.status === 401) {
        setState({ view: 'login', me: null, rows: [] });
        throw new Error('unauthenticated');
      }
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) {
            var msg = data && data.message;
            throw new Error(Array.isArray(msg) ? msg.join(', ') : msg || 'Request failed');
          }
          return data;
        });
    });
  }

  var toastTimer = null;
  function toast(message, kind) {
    state.toast = { message: message, kind: kind || 'info' };
    render();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      state.toast = null;
      render();
    }, 4000);
  }

  function setState(patch) {
    Object.keys(patch).forEach(function (k) {
      state[k] = patch[k];
    });
    render();
  }

  // ---- theme --------------------------------------------------------------

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('cdb-theme', theme);
    } catch (e) {
      /* private mode — theme just won't persist */
    }
  }
  try {
    var saved = localStorage.getItem('cdb-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {
    /* ignore */
  }
  function themeIcon() {
    return currentTheme() === 'dark'
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }

  // ---- views --------------------------------------------------------------

  function loginView() {
    return (
      '<div class="login">' +
      '<button class="icon-btn" data-act="theme">' + themeIcon() + '</button>' +
      '<div class="brand">' + WORDMARK + '</div>' +
      '<form class="login-card" data-act="login">' +
      '<div><h1>Scout sign in</h1><div class="sub">Your scouting sheet is private to you. Accounts are created by an admin.</div></div>' +
      '<div class="field"><label>Username</label><input id="u" type="text" value="' +
      esc(state.username) + '" autocomplete="username" autofocus></div>' +
      '<div class="field"><label>Password</label><input id="p" type="password" placeholder="••••••••" value="' +
      esc(state.password) + '" autocomplete="current-password"></div>' +
      (state.loginError ? '<div class="login-err">' + esc(state.loginError) + '</div>' : '') +
      '<button class="btn-primary" type="submit"' + (state.loggingIn ? ' disabled' : '') + '>' +
      (state.loggingIn ? 'Signing in…' : 'Sign in') +
      '</button>' +
      '</form>' +
      '<div class="login-foot">Scouting sheet · INFLUENCE</div>' +
      '</div>'
    );
  }

  function qualificationCell(row) {
    if (row.qualification === 'QUALIFIED') {
      return '<span class="qual qual-yes" title="Qualified by an admin">✓</span>';
    }
    if (row.qualification === 'REJECTED') {
      return '<span class="qual qual-no" title="Not a fit">✗</span>';
    }
    return '<span class="qual qual-pending" title="Not reviewed yet">·</span>';
  }

  function genderSelect(row) {
    var opts = GENDERS.map(function (g) {
      return (
        '<option value="' + g.value + '"' +
        ((row.gender || '') === g.value ? ' selected' : '') +
        '>' + esc(g.label) + '</option>'
      );
    }).join('');
    return '<select class="sheet-input" data-field="gender" data-id="' + esc(row.id) + '">' + opts + '</select>';
  }

  function textCell(row, field, placeholder, type) {
    return (
      '<input class="sheet-input" type="' + (type || 'text') + '"' +
      ' data-field="' + field + '" data-id="' + esc(row.id) + '"' +
      ' value="' + esc(row[field] === null || row[field] === undefined ? '' : row[field]) + '"' +
      ' placeholder="' + esc(placeholder || '') + '">'
    );
  }

  /**
   * `position` is the 1-based index within the sheet, not the stored
   * `rowNumber`. Rows keep a stable per-scout rowNumber in the database (so a
   * row's identity never shifts), but the visible numbering column stays
   * contiguous the way it did in the spreadsheet this replaces — deleting a row
   * renumbers the ones under it instead of leaving a gap.
   */
  function rowView(row, position) {
    return (
      '<tr>' +
      '<td class="sheet-num">' + esc(position) + '</td>' +
      '<td>' + textCell(row, 'instagramProfileLink', 'instagram.com/handle') +
        (row.instagramUsername
          ? '<a class="sheet-handle" href="https://instagram.com/' + esc(row.instagramUsername) +
            '" target="_blank" rel="noopener noreferrer">@' + esc(row.instagramUsername) + '</a>'
          : '<span class="sheet-handle sheet-handle-warn">no handle detected</span>') +
      '</td>' +
      '<td>' + textCell(row, 'reelIdeas', 'Reels they could replicate with the brand') + '</td>' +
      '<td>' + textCell(row, 'approxAge', 'Age', 'number') + '</td>' +
      '<td>' + genderSelect(row) + '</td>' +
      '<td>' + textCell(row, 'country', 'Country') + '</td>' +
      '<td>' + textCell(row, 'language', 'Language') + '</td>' +
      '<td class="sheet-ro sheet-center">' + qualificationCell(row) + '</td>' +
      '<td class="sheet-ro"><span class="sheet-notes">' +
        (row.notes ? esc(row.notes) : '<span class="sheet-muted">—</span>') + '</span></td>' +
      '<td class="sheet-center"><button class="row-del" data-act="del" data-id="' + esc(row.id) +
        '" title="Delete row">✕</button></td>' +
      '</tr>'
    );
  }

  function sheetView() {
    var who = state.me ? state.me.displayName || state.me.username : '';
    var head =
      '<div class="topbar">' +
      '<div class="brand-mark">' + WORDMARK + '</div>' +
      '<div class="topbar-title">Scouting sheet</div>' +
      '<div class="topbar-right">' +
      '<button class="icon-btn" data-act="theme">' + themeIcon() + '</button>' +
      '<span class="who"><span class="avatar">' + esc((who || '?').charAt(0).toUpperCase()) +
        '</span><span class="who-name">' + esc(who) + '</span></span>' +
      '<button class="link-btn" data-act="logout">Sign out</button>' +
      '</div>' +
      '</div>';

    var intro =
      '<div class="sheet-head">' +
      '<div><h1 class="page-title">Your creators</h1>' +
      '<div class="page-sub">' + state.rows.length +
        ' row' + (state.rows.length === 1 ? '' : 's') +
        ' · only you and an admin can see this sheet</div></div>' +
      '<button class="btn-primary" data-act="add"' + (state.adding ? ' disabled' : '') + '>' +
      (state.adding ? 'Adding…' : '+ Add row') +
      '</button>' +
      '</div>';

    if (state.loadError) {
      return head + '<div class="sheet-page">' + intro +
        '<div class="empty"><div class="empty-t">Could not load your sheet</div>' +
        '<div class="empty-s">' + esc(state.loadError) + '</div></div></div>';
    }

    var body = state.rows.length
      ? '<div class="sheet-wrap"><table class="sheet"><thead><tr>' +
        '<th class="sheet-num">#</th>' +
        '<th class="col-profile">Instagram profile</th>' +
        '<th class="col-reels">Reels to replicate</th>' +
        '<th class="col-age">Age</th>' +
        '<th class="col-gender">Gender</th>' +
        '<th class="col-loc">Location</th>' +
        '<th class="col-lang">Language</th>' +
        '<th class="col-qual sheet-center" title="Set by an admin — read only">Qualified 🔒</th>' +
        '<th class="col-notes" title="Set by an admin — read only">Notes 🔒</th>' +
        '<th class="col-act"></th>' +
        '</tr></thead><tbody>' +
        state.rows.map(function (r, i) { return rowView(r, i + 1); }).join('') +
        '</tbody></table></div>'
      : '<div class="empty"><div class="empty-t">No creators yet</div>' +
        '<div class="empty-s">Add your first row to start scouting.</div></div>';

    return head + '<div class="sheet-page">' + intro + body + '</div>';
  }

  function toastView() {
    if (!state.toast) return '';
    return (
      '<div class="toast toast-' + esc(state.toast.kind) + '">' +
      esc(state.toast.message) + '</div>'
    );
  }

  function render() {
    if (state.view === 'loading') {
      root.innerHTML = '<div class="spinner"></div>';
      return;
    }
    if (state.view === 'login') {
      root.innerHTML = loginView();
      return;
    }
    root.innerHTML = sheetView() + toastView();
  }

  // ---- data ---------------------------------------------------------------

  function loadRows() {
    return api('/scouts/entries')
      .then(function (rows) {
        setState({ rows: Array.isArray(rows) ? rows : [], loadError: '' });
      })
      .catch(function (err) {
        if (err.message !== 'unauthenticated') setState({ loadError: err.message });
      });
  }

  function boot() {
    api('/auth/session')
      .then(function (s) {
        if (!s.authenticated) return setState({ view: 'login' });
        // An admin landing here belongs in the console, not a scouting sheet.
        if (s.role === 'ADMIN') {
          window.location.href = '/';
          return;
        }
        state.me = { username: s.username, displayName: s.displayName };
        setState({ view: 'sheet' });
        loadRows();
      })
      .catch(function () {
        setState({ view: 'login' });
      });
  }

  // ---- events -------------------------------------------------------------

  document.addEventListener('click', function (e) {
    var themeBtn = e.target.closest('[data-act="theme"]');
    if (themeBtn) {
      applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      render();
      return;
    }

    var logout = e.target.closest('[data-act="logout"]');
    if (logout) {
      api('/auth/logout', { method: 'POST' })
        .catch(function () {})
        .then(function () {
          setState({ view: 'login', me: null, rows: [], username: '', password: '' });
        });
      return;
    }

    var add = e.target.closest('[data-act="add"]');
    if (add) {
      if (state.adding) return;
      setState({ adding: true });
      api('/scouts/entries', { method: 'POST', body: { instagramProfileLink: '' } })
        .then(function (res) {
          state.rows = state.rows.concat([res.entry]);
          setState({ adding: false });
          var inputs = document.querySelectorAll('input[data-field="instagramProfileLink"]');
          if (inputs.length) inputs[inputs.length - 1].focus();
        })
        .catch(function (err) {
          setState({ adding: false });
          if (err.message !== 'unauthenticated') toast(err.message, 'err');
        });
      return;
    }

    var del = e.target.closest('[data-act="del"]');
    if (del) {
      var id = del.getAttribute('data-id');
      var row = state.rows.filter(function (r) { return r.id === id; })[0];
      var label = row && row.instagramUsername ? '@' + row.instagramUsername : 'this row';
      if (!window.confirm('Delete ' + label + '? This cannot be undone.')) return;
      api('/scouts/entries/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function () {
          state.rows = state.rows.filter(function (r) { return r.id !== id; });
          render();
          toast('Row deleted', 'info');
        })
        .catch(function (err) {
          if (err.message !== 'unauthenticated') toast(err.message, 'err');
        });
    }
  });

  // Save a cell when it loses focus / changes. `change` (not `input`) keeps us
  // from firing a request on every keystroke and never steals focus mid-typing.
  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-field]');
    if (!el) return;

    var id = el.getAttribute('data-id');
    var field = el.getAttribute('data-field');
    var raw = el.value;
    var body = {};

    if (field === 'approxAge') {
      var n = parseInt(raw, 10);
      if (raw === '') {
        // Clearing the age is fine; the API treats an absent field as "leave it",
        // so send nothing rather than an invalid value.
        return;
      }
      if (!isFinite(n) || n < 1 || n > 120) {
        toast('Age must be a number between 1 and 120', 'err');
        return;
      }
      body.approxAge = n;
    } else if (field === 'gender') {
      if (raw === '') return; // "—" means leave as-is
      body.gender = raw;
    } else {
      body[field] = raw;
    }

    el.classList.add('saving');
    api('/scouts/entries/' + encodeURIComponent(id), { method: 'PATCH', body: body })
      .then(function (res) {
        el.classList.remove('saving');
        var updated = res.entry;
        state.rows = state.rows.map(function (r) { return r.id === id ? updated : r; });
        if (res.duplicateWarning) {
          toast(res.duplicateWarning, 'warn');
        } else if (field === 'instagramProfileLink') {
          // Re-render so the parsed @handle under the link updates.
          render();
        }
      })
      .catch(function (err) {
        el.classList.remove('saving');
        if (err.message !== 'unauthenticated') toast(err.message, 'err');
      });
  });

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-act="login"]');
    if (!form) return;
    e.preventDefault();
    if (state.loggingIn) return;

    var username = (document.getElementById('u') || {}).value || '';
    var password = (document.getElementById('p') || {}).value || '';
    setState({ loggingIn: true, loginError: '', username: username, password: password });

    fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (r) {
        if (!r.ok || !r.data.authenticated) {
          setState({ loggingIn: false, loginError: 'Invalid username or password.', password: '' });
          return;
        }
        if (r.data.role === 'ADMIN') {
          window.location.href = '/';
          return;
        }
        state.me = { username: r.data.username, displayName: r.data.displayName };
        setState({ loggingIn: false, view: 'sheet', username: '', password: '' });
        loadRows();
      })
      .catch(function () {
        setState({ loggingIn: false, loginError: 'Could not reach the server. Try again.' });
      });
  });

  boot();
})();
