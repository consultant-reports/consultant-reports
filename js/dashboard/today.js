// Today (Section 8.1): who submitted, who did not — for today's date on the server (Riyadh),
// counting reports by the day they are for. Also shows storage and keep-alive warnings here,
// because the manager rarely opens the Storage or Admin screens.
import { CONFIG } from '../config.js?v=29';
import { t, getLang } from '../i18n.js?v=29';
import { el, todayIso } from '../lib.js?v=29';
import { fmtIsoDay, sentLabel } from './dates.js?v=29';
import { LIST_COLS } from '../export/data.js?v=29';
import { cardProjectName } from '../export/card.js?v=29';
import { loadingBlock, errorBlock, viewHead, statCard } from './ui.js?v=29';

export async function render(ctx, view, _params, isCurrent) {
  const refresh = el('button', { type: 'button', class: 'btn sm', text: '↻', 'aria-label': t('common.retry'), onclick: () => render(ctx, view, _params, isCurrent) });
  view.replaceChildren(viewHead(t('nav.today'), refresh), loadingBlock());

  // The server's date, not the manager's PC clock.
  const cfg = await ctx.sb.rpc('get_public_config');
  const day = cfg.data?.today ?? todayIso();
  view.firstChild.querySelector('h1').textContent = `${t('nav.today')} — ${fmtIsoDay(day)}`;

  const [rep, cons, usage, beat] = await Promise.all([
    ctx.sb.from('reports').select(LIST_COLS).eq('report_date', day).order('submitted_at', { ascending: false }),
    ctx.sb.from('consultants').select('id, full_name, mobile').eq('is_active', true).order('full_name'),
    ctx.sb.rpc('storage_usage'),
    ctx.sb.from('heartbeat').select('last_ping').eq('id', 1).maybeSingle(),
  ]);
  if (!isCurrent()) return;
  const error = rep.error || cons.error;
  if (error) {
    view.lastChild.replaceWith(errorBlock(t('err.load'), () => render(ctx, view, _params, isCurrent)));
    return;
  }

  // Warnings (quiet when everything is fine).
  const warnings = [];
  if (usage.data) {
    const pct = Math.max(usage.data.photos_bytes / CONFIG.STORAGE_STOP_BYTES, usage.data.db_bytes / CONFIG.DB_STOP_BYTES) * 100;
    if (pct >= CONFIG.WARN_PERCENT) {
      warnings.push(el('a', {
        class: `msg ${pct >= CONFIG.DANGER_PERCENT ? 'error' : 'warn'} banner`, href: '#storage',
        text: t(pct >= CONFIG.DANGER_PERCENT ? 'st.danger' : 'st.warn', { p: Math.round(pct) }),
      }));
    }
  }
  if (beat.data?.last_ping && (Date.now() - new Date(beat.data.last_ping).getTime()) / 86400000 > CONFIG.HEARTBEAT_WARN_DAYS) {
    warnings.push(el('div', { class: 'msg warn', text: t('today.keepAliveStale') }));
  }

  const submittedIds = new Set(rep.data.map((r) => r.consultant_id));
  const missing = cons.data.filter((c) => !submittedIds.has(c.id));
  const activeSubmitted = cons.data.length - missing.length;

  const stats = el('div', { class: 'stats' },
    statCard(activeSubmitted, t('today.submitted')),
    statCard(missing.length, t('today.notSubmitted'), true),
    statCard(rep.data.length, t('nav.reports'), true),
    statCard(cons.data.length, `${t('nav.consultants')} (${t('common.active')})`, true));

  const submittedList = rep.data.length
    ? el('ul', { class: 'list' }, rep.data.map((r) => el('li', {},
      el('a', { class: 'row', href: `#report/${r.id}` },
        el('span', { class: 'time', text: sentLabel(r) }),
        el('span', { class: 'who' },
          el('b', { dir: 'auto', text: r.consultant_name_snapshot }),
          el('span', { dir: 'auto', text: cardProjectName(r, getLang()) })),
        el('span', { class: 'pill', text: r.project_type })))))
    : el('p', { class: 'center-state', text: t('today.noneYet') });

  const missingList = missing.length
    ? el('ul', { class: 'list' }, missing.map((c) => el('li', {},
      el('span', { class: 'who' }, el('b', { dir: 'auto', text: c.full_name })),
      el('a', { class: 'ltr', href: `tel:${c.mobile}`, text: c.mobile }))))
    : el('p', { class: 'center-state', text: t('today.allDone') });

  view.lastChild.replaceWith(el('div', {},
    ...warnings,
    stats,
    el('h2', { class: 'section', text: `${t('today.submitted')} (${rep.data.length})` }),
    el('div', { class: 'table-wrap' }, submittedList),
    el('h2', { class: 'section', text: `${t('today.notSubmitted')} (${missing.length})` }),
    el('div', { class: 'table-wrap' }, missingList)));
}
