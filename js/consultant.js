// Consultant app (Section 7): registration + Submit Report.
import { CONFIG } from './config.js?v=22';
import { t, applyI18n, bindLangToggle } from './i18n.js?v=22';
import {
  createSupabase, normalizeMobile, toWesternDigits, fmtDate, fmtTime, isoDay, fmtIsoDay, uuid, errorKey, PROJECT_TYPES, sleep,
} from './lib.js?v=22';
import { sanitizeReportHtml } from './sanitize.js?v=22';
import { photoStore } from './idb.js?v=22';

const sb = createSupabase({ anonymous: true });
const $ = (id) => document.getElementById(id);

const LS = { me: 'dcr.me', draft: 'dcr.draft', projects: 'dcr.projects', config: 'dcr.config', device: 'dcr.device' };

// Permanent random id for this phone, kept in two places and never cleared by sign-out.
// The server binds it to the first consultant who registers here, so one phone cannot
// be used to register a second name.
function deviceId() {
  const cookie = document.cookie.split('; ').find((c) => c.startsWith('dcr_device='))?.split('=')[1];
  let id = null;
  try { id = localStorage.getItem(LS.device); } catch { /* blocked */ }
  id ||= cookie || `${uuid()}${uuid()}`.replace(/-/g, '');
  try { localStorage.setItem(LS.device, id); } catch { /* blocked */ }
  document.cookie = `dcr_device=${id}; max-age=${60 * 60 * 24 * 3650}; path=/; SameSite=Strict; Secure`;
  return id;
}
const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };
const drop = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

// ---------------------------------------------------------------- add to home screen

let installPrompt = null; // Chrome / Samsung Internet on Android offer a one-tap install
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; refreshInstallTips(); });
window.addEventListener('appinstalled', () => { installPrompt = null; hideInstallTips(); });

// Which instructions this phone needs; null when already opened from the icon or not a phone.
function homeScreenKind() {
  if (navigator.standalone || matchMedia('(display-mode: standalone)').matches) return null;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (!/Android/.test(ua)) return null;
  if (/; wv\)|FBAN|FBAV|Instagram|WhatsApp|Snapchat|Line\//.test(ua)) return 'inapp';
  return /SamsungBrowser/.test(ua) ? 'samsung' : 'chrome';
}

// where: 'reg' (registration screen, essential on iPhone) or 'ok' (after a report, can be postponed).
function renderInstallTip(node, where) {
  const kind = homeScreenKind();
  const later = load('dcr.a2hsLater');
  if (!kind || (where === 'ok' && later && Date.now() - later < 14 * 864e5)) {
    node.hidden = true;
    node.replaceChildren();
    return;
  }
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const parts = [];
  const btns = el('div', '', 'row-btns');
  if (kind === 'inapp') {
    parts.push(el('p', t(where === 'reg' ? 'a2hs.inappReg' : 'a2hs.inapp')));
  } else {
    parts.push(el('p', t(where === 'reg' ? 'a2hs.titleReg' : 'a2hs.titleOk')));
    if (installPrompt && kind !== 'ios') {
      const b = el('button', t('a2hs.install'), 'btn primary grow');
      b.type = 'button';
      b.addEventListener('click', installApp);
      btns.append(b);
    } else {
      const ol = el('ol');
      t(`a2hs.${kind}.steps`).split('|').forEach((x) => ol.append(el('li', x)));
      parts.push(ol);
    }
    if (kind === 'ios') parts.push(el('p', t(where === 'reg' ? 'a2hs.ios.noteReg' : 'a2hs.ios.noteOk')));
  }
  if (where === 'ok') {
    const b = el('button', t('a2hs.later'), 'btn');
    b.type = 'button';
    b.addEventListener('click', () => { save('dcr.a2hsLater', Date.now()); node.hidden = true; });
    btns.append(b);
  }
  if (btns.childElementCount) parts.push(btns);
  node.className = 'msg info install-tip';
  node.dataset.where = where;
  node.replaceChildren(...parts);
  node.hidden = false;
}

async function installApp() {
  const p = installPrompt;
  if (!p) return;
  installPrompt = null;
  try {
    await p.prompt();
    const { outcome } = await p.userChoice;
    if (outcome === 'accepted') { hideInstallTips(); return; }
  } catch { /* prompt already used */ }
  refreshInstallTips();
}

function refreshInstallTips() {
  ['regTip', 'okTip'].forEach((id) => {
    const n = $(id);
    if (n && !n.hidden && n.dataset.where) renderInstallTip(n, n.dataset.where);
  });
}

function hideInstallTips() {
  ['regTip', 'okTip'].forEach((id) => { const n = $(id); if (n) n.hidden = true; });
}

const S = {
  config: load(LS.config) ?? { access_mode: 'none' },
  me: load(LS.me),
  projects: load(LS.projects) ?? [],
  type: null,
  projectId: '',       // project uuid, 'other' or ''
  otherName: '',
  photos: [],          // { id, order, blob, url, busy }
  reportId: null,      // generated once per report, so retries are idempotent
  reportFor: 'today',  // 'today' | 'yesterday' (allowed until 12:00 Riyadh)
  draftAt: null,       // when the draft was started (shown on a pending report)
  sent: null,          // frozen payload once sent: { html, type, projectId, otherName, slots }
  pending: null,       // { reportId, folder, submittedAt, expected, slots: [{ id, n }], uploaded: [n] }
  busy: false,
  regMode: 'register', // 'register' | 'edit'
};

let quill;

// ---------------------------------------------------------------- screens

const SCREENS = ['screenLoading', 'screenFatal', 'screenRegister', 'screenReport', 'screenSuccess'];
function show(id) {
  SCREENS.forEach((s) => { $(s).hidden = s !== id; });
  window.scrollTo(0, 0);
}

// In-page confirmation: some in-app browsers (WhatsApp, Instagram…) never show window.confirm.
function askConfirm(text, yesLabel) {
  return new Promise((resolve) => {
    const box = $('confirmBox');
    $('confirmText').textContent = text;
    $('confirmYes').textContent = yesLabel || t('common.confirm');
    box.hidden = false;
    $('confirmNo').focus();
    const done = (v) => {
      box.hidden = true;
      $('confirmYes').onclick = null;
      $('confirmNo').onclick = null;
      resolve(v);
    };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
  });
}

function showMsg(node, text, kind) {
  node.textContent = text;
  if (kind) node.className = `msg ${kind}`;
  node.hidden = !text;
}

// ---------------------------------------------------------------- boot

async function boot() {
  const REQUIRED = ['confirmBox', 'dayField', 'lastSent', 'discardBtn', 'regTip', 'okTip'];
  if (REQUIRED.some((id) => !$(id))) {
    // The browser mixed an old cached page with new scripts: reload once to get both new.
    let tried = false;
    try { tried = sessionStorage.getItem('dcr.reloaded') === '1'; sessionStorage.setItem('dcr.reloaded', '1'); } catch { /* ignore */ }
    if (!tried) { location.reload(); return; }
  }
  applyI18n();
  if (!window.Quill || !window.DOMPurify || !window.imageCompression || !window.supabase) {
    window.__dcrBooted = true;
    fatal(t('err.network'));
    return;
  }
  bindLangToggle($('langToggle'));
  window.addEventListener('langchange', onLangChange);
  wireRegister();
  wireReport();

  try {
    if (S.me) {
      await enterReport();
      refreshRemote(); // update projects/config in the background
      checkBinding();
      return;
    }
    show('screenLoading');
    await refreshRemote(true);
    openRegister('register');
  } catch (e) {
    fatal(t(errorKey(e)));
  } finally {
    window.__dcrBooted = true;
  }
}

async function refreshRemote(throwOnError = false) {
  try {
    const [cfg, pj] = await Promise.all([
      sb.rpc('get_public_config'),
      sb.from('projects').select('id,name,type').eq('is_active', true).order('name'),
    ]);
    if (cfg.error) throw cfg.error;
    if (pj.error) throw pj.error;
    S.config = cfg.data;
    S.projects = pj.data;
    save(LS.config, S.config);
    save(LS.projects, S.projects);
    renderProjects();
    syncCodeField();
  } catch (e) {
    if (throwOnError) throw e;
  }
}

// The admin can switch the team code on or off at any time, so the page re-checks
// before registering and whenever it comes back to the screen.
async function refreshConfig() {
  const { data, error } = await sb.rpc('get_public_config');
  if (error) return;
  S.config = data;
  save(LS.config, S.config);
  syncCodeField();
}

/** Shows the team-code field only when the code is required; hiding it also clears it. */
function syncCodeField() {
  const hide = S.config.access_mode === 'none' || S.regMode === 'edit';
  $('regCodeField').hidden = hide;
  if (hide) $('regCode').value = '';
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshRemote();
});

function fatal(text) {
  $('fatalMsg').textContent = text;
  show('screenFatal');
}
$('fatalRetry').addEventListener('click', () => location.reload());

// ---------------------------------------------------------------- registration / edit details

function openRegister(mode) {
  S.regMode = mode;
  const edit = mode === 'edit';
  $('regTitle').dataset.i18n = edit ? 'edit.title' : 'reg.title';
  $('regIntro').hidden = edit;
  $('regCancel').hidden = !edit;
  syncCodeField();
  $('regName').value = edit ? S.me.full_name : '';
  $('regMobile').value = edit ? S.me.mobile.replace(/^\+966/, '0') : '';
  $('regMobile').readOnly = edit;
  $('regMobileHint').dataset.i18n = edit ? 'edit.mobileHint' : 'reg.mobile.hint';
  $('regCode').value = '';
  $('regPairField').hidden = true;
  $('regPair').value = '';
  showMsg($('regError'), '');
  if (edit) showMsg($('regTip'), '');
  else renderInstallTip($('regTip'), 'reg');
  applyI18n($('screenRegister'));
  show('screenRegister');
}

function wireRegister() {
  $('regCancel').addEventListener('click', () => show('screenReport'));
  $('regForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = $('regName').value.trim();
    const mobile = normalizeMobile($('regMobile').value);
    if (name.length < 2) return showMsg($('regError'), t('err.invalid_name'));
    if (name.split(/\s+/).filter(Boolean).length < 2) return showMsg($('regError'), t('err.full_name'));
    if (!mobile) return showMsg($('regError'), t('err.invalid_mobile'));

    const btn = $('regSubmit');
    btn.disabled = true;
    showMsg($('regError'), '');
    if (S.regMode === 'register') {
      const wasHidden = $('regCodeField').hidden;
      await refreshConfig();
      if (!$('regCodeField').hidden && (wasHidden || !$('regCode').value.trim())) {
        btn.disabled = false;
        $('regCode').focus();
        return showMsg($('regError'), t('reg.codeNeeded'));
      }
    }
    const code = toWesternDigits($('regCode').value).trim();
    try {
      if (S.regMode === 'edit') {
        const { data, error } = await sb.rpc('update_my_details', {
          p_consultant_id: S.me.consultant_id, p_device_token: S.me.device_token,
          p_full_name: name, p_mobile: mobile,
        });
        if (error) throw error;
        S.me = { ...S.me, full_name: data.full_name, mobile: data.mobile };
        save(LS.me, S.me);
        await enterReport();
        notice(t('edit.saved'), 'ok');
      } else {
        const { data, error } = await sb.rpc('register_consultant', {
          p_full_name: name, p_mobile: mobile, p_team_code: code || null, p_device_id: deviceId(),
          p_pair_code: toWesternDigits($('regPair').value).trim() || null,
        });
        if (error) throw error;
        if (data?.error === 'pair_code_needed' || data?.error === 'invalid_pair_code') {
          // This number already has a device: link this one with the code from that device.
          $('regPairField').hidden = false;
          $('regPair').focus();
          if (data.error === 'invalid_pair_code') $('regPair').select();
        }
        if (data?.error) throw new Error(data.error);
        S.me = {
          consultant_id: data.consultant_id, full_name: data.full_name,
          mobile: data.mobile, device_token: data.device_token,
        };
        save(LS.me, S.me);
        await enterReport();
        if (!data.is_new && data.full_name !== name) notice(t('reg.existing', { name: data.full_name }), 'info');
      }
    } catch (e) {
      const key = errorKey(e);
      if (key === 'err.device_not_recognized') {
        forgetMe();
        openRegister('register');
      }
      if (key === 'err.invalid_team_code') {
        await refreshConfig();
        if (!$('regCodeField').hidden) $('regCode').focus();
      }
      showMsg($('regError'), t(key));
    } finally {
      btn.disabled = false;
    }
  });
}

// Ties this phone to the signed-in consultant (for accounts made before phone binding),
// and signs out if the manager released the phone or it belongs to someone else.
async function checkBinding() {
  if (!S.me) return;
  const { data, error } = await sb.rpc('bind_device', {
    p_consultant_id: S.me.consultant_id, p_device_token: S.me.device_token, p_device_id: deviceId(),
  });
  if (error && errorKey(error) !== 'err.device_bound_other') return; // offline etc.: try next time
  if (!error && data?.status === 'ok') {
    if (data.full_name !== S.me.full_name || data.mobile !== S.me.mobile) {
      S.me = { ...S.me, full_name: data.full_name, mobile: data.mobile };
      save(LS.me, S.me);
      $('idName').textContent = S.me.full_name;
      $('idMobile').textContent = S.me.mobile;
    }
    return;
  }
  if (S.pending || S.sent || S.busy) return; // never interrupt an unfinished submission
  forgetMe(); // the draft stays on the phone and comes back after registering again
  openRegister('register');
  showMsg($('regError'), t(error ? 'err.device_bound_other' : 'reg.released'));
}


// First device: show a 6-digit code to link a second device (e.g. WhatsApp's browser or a laptop).
async function showPairingCode() {
  const btn = $('pairBtn');
  btn.disabled = true;
  try {
    const { data, error } = await sb.rpc('create_pairing_code', {
      p_consultant_id: S.me.consultant_id, p_device_token: S.me.device_token,
    });
    if (error) throw error;
    const box = $('noticeBox');
    box.className = 'msg info pair-box';
    const codeEl = document.createElement('div');
    codeEl.className = 'pair-code';
    codeEl.textContent = data.code.replace(/(\d{3})(\d{3})/, '$1 $2');
    box.replaceChildren(document.createTextNode(t('pair.intro')), codeEl, document.createTextNode(t('pair.steps')));
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    notice(t(errorKey(e)), 'error');
  } finally {
    btn.disabled = false;
  }
}

function forgetMe() {
  S.me = null;
  drop(LS.me);
}

// Sign out on this phone: forget the identity and any unsent draft, so the next
// person using the phone starts clean. Reports already sent stay on the server.
async function logout() {
  if (S.busy) return;
  const hasDraft = !!(S.pending || S.sent || S.photos.length || quill?.getText().trim());
  let question = t('logout.confirm');
  if (S.pending || S.sent) question += `\n\n${t('logout.pending')}`;
  else if (hasDraft) question += `\n\n${t('logout.draft')}`;
  if (!(await askConfirm(question, t('rep.logout')))) return;
  try {
    await sb.rpc('sign_out_device', { p_consultant_id: S.me.consultant_id, p_device_token: S.me.device_token });
  } catch { /* offline: the phone simply stays linked */ }
  await clearDraft();
  if (quill) resetForm();
  forgetMe();
  openRegister('register');
}

// ---------------------------------------------------------------- report screen

function notice(text, kind) {
  showMsg($('noticeBox'), text, kind);
}

function projectLabelOf(sent) {
  if (!sent) return '';
  if (sent.otherName) return sent.otherName;
  return S.projects.find((x) => x.id === sent.projectId)?.name ?? '';
}

function renderLastSent() {
  const last = load('dcr.lastSent');
  const box = $('lastSent');
  if (!last || !S.me || last.owner !== S.me.consultant_id) { box.hidden = true; return; }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIMEZONE }).format(new Date());
  const sentDay = new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIMEZONE }).format(new Date(last.at));
  const when = sentDay === today ? `${t('rep.today')} ${fmtTime(last.at)}` : `${fmtDate(last.at)} ${fmtTime(last.at)}`;
  box.textContent = `✓ ${t('rep.lastSent')}: ${when}${last.project ? ` · ${last.project}` : ''}`;
  box.hidden = false;
}

async function enterReport() {
  $('idName').textContent = S.me.full_name;
  $('idMobile').textContent = S.me.mobile;
  showMsg($('noticeBox'), '');
  initEditor();
  renderProjects();
  renderDayField();
  renderLastSent();
  show('screenReport');
  await restoreDraft();
}

function initEditor() {
  if (quill) return;
  quill = new window.Quill('#editor', {
    theme: 'snow',
    placeholder: t('rep.body.ph'),
    // Only the formats listed in Section 7.3 — this also drops pasted images.
    formats: ['header', 'size', 'bold', 'italic', 'underline', 'color', 'list'],
    modules: {
      toolbar: [
        [{ header: [2, 3, false] }, { size: ['small', false, 'large', 'huge'] }],
        ['bold', 'italic', 'underline', { color: [] }],
        [{ list: 'ordered' }, { list: 'bullet' }],
        ['clean'],
      ],
      uploader: { mimetypes: [] },
    },
  });
  quill.clipboard.addMatcher(Node.ELEMENT_NODE, (node, delta) => {
    delta.ops.forEach((op) => {
      if (op.attributes) { delete op.attributes.color; delete op.attributes.background; }
    });
    return delta;
  });
  let timer;
  quill.on('text-change', () => {
    clearTimeout(timer);
    timer = setTimeout(saveDraft, 400);
    hideErr('errBody');
  });
}

function wireReport() {
  document.querySelectorAll('.type-btn').forEach((b) => {
    b.addEventListener('click', () => {
      if (locked() || S.busy) return;
      setType(b.dataset.type);
      saveDraft();
    });
  });
  $('projectSelect').addEventListener('change', (e) => {
    S.projectId = e.target.value;
    $('otherField').hidden = S.projectId !== 'other';
    hideErr('errProject');
    if (S.projectId === 'other') $('otherName').focus();
    saveDraft();
  });
  $('otherName').addEventListener('input', (e) => {
    S.otherName = e.target.value;
    hideErr('errOther');
    renderSuggestions();
    saveDraft();
  });
  document.querySelectorAll('.day-btn').forEach((b) => {
    b.addEventListener('click', () => {
      if (locked() || S.busy) return;
      setReportFor(b.dataset.for);
      saveDraft();
    });
  });
  $('discardBtn').addEventListener('click', discardUnsent);
  $('photoCamera').addEventListener('change', onPhotosPicked);
  $('photoGallery').addEventListener('change', onPhotosPicked);
  $('reportForm').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  $('editDetails').addEventListener('click', () => openRegister('edit'));
  $('logoutBtn').addEventListener('click', logout);
  $('pairBtn').addEventListener('click', showPairingCode);
  $('finishBtn').addEventListener('click', finishWithoutRemaining);
  $('anotherBtn').addEventListener('click', () => {
    resetForm();
    renderDayField();
    renderLastSent();
    show('screenReport');
  });
}

function setReportFor(v) {
  S.reportFor = v === 'yesterday' && yesterdayOpen() ? 'yesterday' : 'today';
  document.querySelectorAll('.day-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.for === S.reportFor)));
}

// "Yesterday" is offered until 12:00 Riyadh time (the server checks it too).
function yesterdayOpen() {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  return hour < 12;
}

function renderDayField() {
  const open = yesterdayOpen();
  $('dayField').hidden = !open;
  if (!open && S.reportFor === 'yesterday' && !S.sent) setReportFor('today');
}

// "Other": suggest existing projects of every type as the engineer types.
const squash = (v) => toWesternDigits(String(v ?? '')).toLowerCase().replace(/[\s\-_./()]+/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
function renderSuggestions() {
  const ul = $('otherSuggest');
  const q = squash(S.otherName);
  const hits = q.length < 3 ? [] : S.projects.filter((p) => {
    const n = squash(p.name);
    return n.includes(q) || q.includes(n);
  }).slice(0, 5);
  ul.replaceChildren();
  if (!hits.length) { ul.hidden = true; return; }
  const title = document.createElement('li');
  title.className = 'title';
  title.textContent = t('rep.suggest');
  ul.append(title);
  hits.forEach((p) => {
    const li = document.createElement('li');
    li.tabIndex = 0;
    const type = document.createElement('span');
    type.className = 'type';
    type.textContent = p.type;
    li.append(p.name, type);
    const pick = () => {
      setType(p.type);
      S.projectId = p.id;
      S.otherName = '';
      $('otherName').value = '';
      renderProjects();
      ul.hidden = true;
      saveDraft();
    };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
    ul.append(li);
  });
  ul.hidden = false;
}

function setType(type) {
  S.type = PROJECT_TYPES.includes(type) ? type : null;
  document.querySelectorAll('.type-btn').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.type === S.type));
  });
  // A project from another type is no longer valid.
  const p = S.projects.find((x) => x.id === S.projectId);
  if (p && p.type !== S.type) S.projectId = '';
  hideErr('errType');
  renderProjects();
}

function renderProjects() {
  const sel = $('projectSelect');
  if (!sel) return;
  sel.innerHTML = '';
  const hint = $('projectHint');
  if (!S.type) {
    sel.disabled = true;
    sel.append(new Option(t('rep.project.pickType'), ''));
    hint.textContent = '';
    $('otherField').hidden = true;
    return;
  }
  sel.disabled = locked() || S.busy;
  const list = S.projects.filter((p) => p.type === S.type);
  sel.append(new Option(t('rep.project.choose'), ''));
  list.forEach((p) => sel.append(new Option(p.name, p.id)));
  sel.append(new Option(t('rep.project.other'), 'other'));
  if (S.projectId && S.projectId !== 'other' && !list.some((p) => p.id === S.projectId)) S.projectId = '';
  sel.value = S.projectId;
  hint.textContent = list.length ? '' : t('rep.project.none');
  $('otherField').hidden = S.projectId !== 'other';
}

// ---------------------------------------------------------------- photos

async function onPhotosPicked(ev) {
  const input = ev.target;
  const files = [...input.files];
  input.value = '';
  if (!files.length || locked() || S.busy) return;

  const room = CONFIG.MAX_PHOTOS - S.photos.length;
  $('photoHint').textContent = files.length > room
    ? t('rep.photos.maxKept', { n: CONFIG.MAX_PHOTOS, k: Math.max(0, room), m: files.length }) : '';
  let failed = 0;
  const accepted = files.slice(0, Math.max(0, room));

  const items = accepted.map((file, i) => ({ id: uuid(), order: Date.now() + i, busy: true, file }));
  S.photos.push(...items);
  renderThumbs();

  for (const item of items) {
    try {
      const blob = await window.imageCompression(item.file, {
        maxWidthOrHeight: CONFIG.PHOTO_MAX_SIDE,
        maxSizeMB: CONFIG.PHOTO_MAX_MB,
        fileType: 'image/jpeg',
        initialQuality: 0.8,
        useWebWorker: true,
        libURL: new URL('vendor/browser-image-compression.js', location.href).href,
      });
      if (!S.photos.includes(item)) continue; // removed while compressing
      item.blob = blob;
      item.url = URL.createObjectURL(blob);
      item.busy = false;
      delete item.file;
      await photoStore.put({ id: item.id, order: item.order, blob });
    } catch {
      S.photos = S.photos.filter((p) => p !== item);
      failed += 1;
      $('photoHint').textContent = t('rep.photos.failedN', { n: failed });
    }
    renderThumbs();
  }
}

function renderThumbs() {
  const ul = $('thumbs');
  ul.innerHTML = '';
  S.photos.forEach((p, i) => {
    const li = document.createElement('li');
    if (p.url) {
      const img = new Image();
      img.src = p.url;
      img.alt = '';
      li.append(img);
    }
    if (p.busy) {
      const b = document.createElement('div');
      b.className = 'busy';
      b.innerHTML = `<div><span class="spinner"></span><div>${t('rep.photos.processing')}</div></div>`;
      li.append(b);
    }
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    li.append(num);
    if (!locked()) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'rm';
      rm.textContent = '×';
      rm.setAttribute('aria-label', t('rep.photos.remove'));
      rm.addEventListener('click', () => removePhoto(p));
      li.append(rm);
    }
    ul.append(li);
  });
}

function removePhoto(p) {
  if (locked() || S.busy) return;
  S.photos = S.photos.filter((x) => x !== p);
  if (p.url) URL.revokeObjectURL(p.url);
  photoStore.remove(p.id);
  renderThumbs();
}

// ---------------------------------------------------------------- draft

function saveDraft() {
  if (!quill) return;
  S.draftAt ??= new Date().toISOString();
  save(LS.draft, {
    owner: S.me?.consultant_id ?? null,
    draftAt: S.draftAt,
    reportFor: S.reportFor,
    type: S.type,
    projectId: S.projectId,
    otherName: S.otherName,
    delta: quill.getContents(),
    reportId: S.reportId,
    sent: S.sent,
    pending: S.pending,
  });
}

async function restoreDraft() {
  let d = load(LS.draft);
  if (d?.owner && S.me && d.owner !== S.me.consultant_id) {
    // Written by someone else who used this phone before: never show or send it as ours.
    await clearDraft();
    d = null;
  }
  const stored = (await photoStore.all()).sort((a, b) => a.order - b.order);
  S.photos.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  S.photos = stored.map((r) => ({ id: r.id, order: r.order, blob: r.blob, url: URL.createObjectURL(r.blob), busy: false }));

  if (d) {
    S.projectId = d.projectId ?? '';
    S.otherName = d.otherName ?? '';
    S.reportId = d.reportId ?? null;
    S.sent = d.sent ?? null;
    S.draftAt = d.draftAt ?? null;
    setReportFor(d.reportFor);
    S.pending = d.pending?.slots ? d.pending : null; // drafts from older versions restart cleanly
    if (d.pending && !d.pending.slots) S.sent = null;
    setType(d.type);
    $('otherName').value = S.otherName;
    if (d.delta) quill.setContents(d.delta, 'silent');
  }
  renderProjects();
  renderThumbs();
  applyLock();

  const hasContent = (d && (quill.getText().trim() || d.type)) || S.photos.length;
  renderPending();
  if (S.pending || S.sent) { /* the pending box explains the state */ }
  else if (hasContent) notice(t('rep.draftRestored'), 'info');
}

async function clearDraft() {
  drop(LS.draft);
  await photoStore.clear();
}

function resetForm() {
  S.photos.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  S.photos = [];
  S.type = null;
  S.projectId = '';
  S.otherName = '';
  S.reportId = null;
  S.sent = null;
  S.pending = null;
  S.draftAt = null;
  setReportFor('today');
  quill.setContents([], 'silent');
  $('otherName').value = '';
  $('photoHint').textContent = '';
  showMsg($('noticeBox'), '');
  showMsg($('submitError'), '');
  $('pendingBox').hidden = true;
  $('progressBox').hidden = true;
  setType(null);
  renderThumbs();
  applyLock();
}

// Once the report row exists on the server, its text can no longer change —
// only the remaining photo uploads are retried.
function locked() {
  return !!(S.pending || S.sent);
}

function applyLock() {
  const lock = locked();
  quill?.enable(!lock && !S.busy);
  $('otherName').disabled = lock || S.busy;
  $('projectSelect').disabled = lock || S.busy || !S.type;
  $('photoCamera').disabled = lock || S.busy;
  $('photoGallery').disabled = lock || S.busy;
  $('reportForm').setAttribute('aria-busy', String(lock || S.busy));
  $('submitBtn').textContent = lock ? t('common.retry') : t('rep.submit');
  $('finishBtn').hidden = !S.pending || S.busy;
  renderPending();
}

// Two different situations, two different messages:
//  sent but NOT confirmed → the report may not be on the server: Retry, or discard it.
//  confirmed (pending)    → the report is saved; only photos are left.
function renderPending() {
  const box = $('pendingBox');
  if (!S.sent && !S.pending) { box.hidden = true; return; }
  box.hidden = false;
  box.className = `msg ${S.pending ? 'warn' : 'error'}`;
  $('pendingTitle').textContent = t(S.pending ? 'pending.title' : 'pending.unsentTitle');
  $('pendingHint').textContent = t(S.pending ? 'pending.hint' : 'pending.unsentHint');
  $('pendingDate').textContent = S.draftAt ? t('pending.writtenOn', { d: `${fmtDate(S.draftAt)} ${fmtTime(S.draftAt)}` }) : '';
  $('discardBtn').hidden = !!S.pending || !S.sent || S.busy;
}

async function discardUnsent() {
  if (S.busy || S.pending || !S.sent) return;
  if (!(await askConfirm(t('pending.discardConfirm'), t('pending.discard')))) return;
  await clearDraft();
  resetForm();
  notice(t('pending.discarded'), 'info');
}

// ---------------------------------------------------------------- submit

function showErr(id, key) {
  const n = $(id);
  n.textContent = t(key);
  n.hidden = false;
}
function hideErr(id) {
  $(id).hidden = true;
}

function validate() {
  let first = null;
  const fail = (id, key, focus) => { showErr(id, key); first ??= focus; };
  if (!S.type) fail('errType', 'val.type', $('typeField'));
  else if (!S.projectId) fail('errProject', 'val.project', $('projectSelect'));
  else if (S.projectId === 'other' && !S.otherName.trim()) fail('errOther', 'val.otherName', $('otherName'));
  if (!quill.getText().trim()) fail('errBody', 'val.body', quill.root);
  if (first) {
    first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    first.focus?.({ preventScroll: true });
  }
  return !first;
}

function progress(text, fraction) {
  $('progressBox').hidden = false;
  $('progressText').textContent = text;
  $('progressBar').style.width = `${Math.round(fraction * 100)}%`;
}

// Submission has three stages, each saved in the draft so a reload or lost reply resumes:
//  1. S.sent    — the report was sent once. From here the form is frozen, and retries send
//                 exactly the same payload (the server returns the stored report).
//  2. S.pending — the server confirmed the report; its photo slots are fixed (slot n → n.jpg).
//  3. attach    — the server registers whatever photos arrived.
async function submit() {
  if (S.busy) return;
  showMsg($('submitError'), '');
  if (!S.pending && !S.sent && !validate()) return;

  S.busy = true; // before waiting, so a second tap cannot start a parallel submission
  applyLock();
  $('submitBtn').disabled = true;
  try {
    if (S.photos.some((p) => p.busy)) {
      // Wait for compression to finish rather than dropping photos.
      while (S.photos.some((p) => p.busy)) {
        const total = S.photos.length;
        const ready = S.photos.filter((p) => !p.busy).length;
        progress(t('rep.photos.preparingN', { i: Math.min(ready + 1, total), n: total }), 0.02 + 0.03 * (ready / total));
        await sleep(200);
      }
    }

    if (!S.pending) {
      if (!S.sent) {
        const photos = S.photos.filter((p) => p.blob);
        const html = sanitizeReportHtml(quill.getSemanticHTML());
        if (new TextEncoder().encode(html).length > 30000) throw new Error('too_long');
        S.reportId ??= uuid();
        S.sent = {
          html,
          type: S.type,
          projectId: S.projectId === 'other' ? null : S.projectId,
          otherName: S.projectId === 'other' ? S.otherName.trim() : null,
          reportFor: S.reportFor,
          slots: photos.map((p, i) => ({ id: p.id, n: i + 1 })),
        };
        saveDraft();
        applyLock();
        renderThumbs();
      }
      progress(t('prog.saving'), 0.05);
      const { data, error } = await sb.rpc('submit_report', {
        p_report_id: S.reportId,
        p_consultant_id: S.me.consultant_id,
        p_device_token: S.me.device_token,
        p_project_type: S.sent.type,
        p_project_id: S.sent.projectId,
        p_project_other_name: S.sent.otherName,
        p_body_html: S.sent.html,
        p_body_text: null,
        p_photos_expected: S.sent.slots.length,
        p_report_for: S.sent.reportFor ?? 'today',
      });
      if (error) throw error;
      S.pending = {
        reportId: data.report_id, folder: data.folder, submittedAt: data.submitted_at, reportDate: data.report_date,
        expected: data.photos_expected,
        // Only the slots the server accepted (it keeps the first submission's count).
        slots: S.sent.slots.filter((s) => s.n <= data.photos_expected),
        uploaded: [],
      };
      saveDraft();
    }

    await uploadPhotos();
    await finish(false);
  } catch (e) {
    let key = uploadRefused(e) ? 'err.upload_refused' : errorKey(e);
    if (key === 'err.upload_refused' && S.pending
        && Date.now() - new Date(S.pending.submittedAt).getTime() < 3 * 86400000) {
      key = 'err.upload_storage'; // inside the upload window: the storage is full — keep the photos, retry later
    }
    if (key === 'err.unknown_consultant' || key === 'err.device_not_recognized') {
      forgetMe();
      S.busy = false;
      openRegister('register');
      showMsg($('regError'), t(key));
      return;
    }
    if (key === 'err.invalid_project' || key === 'err.invalid_project_type' || key === 'err.bad_html'
        || key === 'err.empty_report' || key === 'err.daily_limit' || key === 'err.too_long'
        || key === 'err.report_conflict' || key === 'err.storage_full' || key === 'err.too_short'
        || key === 'err.duplicate_report' || key === 'err.yesterday_closed') {
      // The server refused the report itself: unfreeze the form so it can be corrected.
      S.sent = null;
      S.reportId = null;
      saveDraft();
      if (key === 'err.invalid_project') { S.projectId = ''; refreshRemote(); }
    }
    $('progressBox').hidden = true;
    showMsg($('submitError'), t(key));
    $('submitError').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } finally {
    S.busy = false;
    $('submitBtn').disabled = false;
    applyLock();
  }
}

function uploadRefused(e) {
  return /row-level security|unauthorized|403/i.test(`${e?.message ?? ''} ${e?.statusCode ?? ''} ${e?.error ?? ''}`);
}

async function uploadPhotos() {
  const p = S.pending;
  const todo = p.slots.filter((s) => !p.uploaded.includes(s.n));
  for (let i = 0; i < todo.length; i++) {
    const slot = todo[i];
    const photo = S.photos.find((x) => x.id === slot.id);
    if (!photo?.blob) continue; // lost from this phone's storage: reported at the end
    progress(t('prog.uploading', { i: p.uploaded.length + 1, n: p.slots.length }), 0.1 + 0.85 * (p.uploaded.length / Math.max(1, p.slots.length)));
    const { error } = await sb.storage.from(CONFIG.PHOTO_BUCKET).upload(`${p.folder}/${slot.n}.jpg`, photo.blob, {
      contentType: 'image/jpeg', upsert: false, cacheControl: '31536000',
    });
    // Already uploaded by an earlier attempt whose reply was lost: fine.
    if (error && !/already exists|duplicate|409/i.test(`${error.message} ${error.statusCode ?? ''}`)) {
      throw error;
    }
    p.uploaded.push(slot.n);
    saveDraft();
  }
}

/**
 * Registers the uploaded photos and shows the success screen.
 * force=false: only when every expected photo arrived (otherwise throws so Retry stays).
 * force=true:  "Finish without the remaining photos" — accept whatever is there.
 */
async function finish(force) {
  progress(t('prog.finishing'), 0.97);
  const p = S.pending;
  const { data, error } = await sb.rpc('attach_photos', {
    p_report_id: p.reportId, p_consultant_id: S.me.consultant_id, p_device_token: S.me.device_token,
  });
  if (error && /unknown_report/.test(error.message)) {
    await clearDraft();
    S.busy = false;
    resetForm();
    notice(t('err.report_removed'), 'warn');
    return;
  }
  if (error) throw error;
  const count = data?.photo_count ?? 0;
  const missingLocally = p.slots.some((s) => !S.photos.some((x) => x.id === s.id && x.blob) && !p.uploaded.includes(s.n));
  if (!force && count < p.expected) {
    throw new Error(missingLocally ? 'photos_missing_locally' : 'network: photos missing');
  }
  const when = p.submittedAt;
  const short = Math.max(0, p.expected - count);
  S.lastProjectLabel = projectLabelOf(S.sent);
  await clearDraft();
  S.busy = false;
  resetForm();
  $('okDate').textContent = fmtDate(when);
  $('okTime').textContent = fmtTime(when);
  if (p.reportDate && p.reportDate !== isoDay(when)) {
    $('okDate').textContent += ` · ${t('ok.forDay', { d: fmtIsoDay(p.reportDate) })}`;
  }
  const project = S.lastProjectLabel || '';
  save('dcr.lastSent', { at: when, reportDate: p.reportDate, project, owner: S.me.consultant_id });
  showMsg($('okWarn'), short ? t('ok.photosShort', { n: short }) : '', 'warn');
  renderInstallTip($('okTip'), 'ok');
  show('screenSuccess');
}

async function finishWithoutRemaining() {
  if (S.busy || !S.pending) return;
  if (!(await askConfirm(t('pending.finishConfirm'), t('pending.finish')))) return;
  S.busy = true;
  applyLock();
  try {
    await finish(true);
  } catch (e) {
    $('progressBox').hidden = true;
    showMsg($('submitError'), t(errorKey(e)));
  } finally {
    S.busy = false;
    applyLock();
  }
}

// ---------------------------------------------------------------- language

function onLangChange() {
  if (quill) quill.root.dataset.placeholder = t('rep.body.ph');
  renderProjects();
  renderThumbs();
  applyLock();
  ['errType', 'errProject', 'errOther', 'errBody'].forEach(hideErr);
  if (!$('regIntro').hidden || S.regMode === 'register') applyI18n($('screenRegister'));
  refreshInstallTips();
}

boot();
