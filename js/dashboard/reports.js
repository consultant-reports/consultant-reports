// Reports list (Section 8.2) with combinable filters, pagination and exports (8.6).
import { CONFIG } from '../config.js?v=30';
import { t, getLang } from '../i18n.js?v=30';
import { el, reportDay, PROJECT_TYPES } from '../lib.js?v=30';
import { fmtIsoDay, sentLabel } from './dates.js?v=30';
import {
  LIST_COLS, applyFilters, fetchAllReports, photoLoader, exportRange, exportBaseName, filterParts, saveBlob,
} from '../export/data.js?v=30';
import { cardProjectName } from '../export/card.js?v=30';
import { buildPdf } from '../export/pdf.js?v=30';
import { buildExcel } from '../export/excel.js?v=30';
import { loadingBlock, errorBlock, viewHead, dataTable, combo, select, field, progressBar, iso } from './ui.js?v=30';

export async function render(ctx, view, _params, isCurrent) {
  const st = (ctx.state.reports ??= { f: {}, page: 0 });
  const pdfBtn = el('button', { type: 'button', class: 'btn', text: t('rl.exportPdf') });
  const xlsBtn = el('button', { type: 'button', class: 'btn', text: t('rl.exportExcel') });
  const prog = progressBar();
  view.replaceChildren(viewHead(t('nav.reports'), pdfBtn, xlsBtn), prog, loadingBlock());

  const [cons, projs, others] = await Promise.all([
    ctx.sb.from('consultants').select('id, full_name, mobile').order('full_name'),
    ctx.sb.from('projects').select('id, name, type, is_active').order('name'),
    ctx.sb.rpc('other_project_names'),
  ]);
  if (!isCurrent()) return;
  if (cons.error || projs.error || others.error) {
    view.lastChild.replaceWith(errorBlock(t('err.load'), () => render(ctx, view, _params, isCurrent)));
    return;
  }

  // ---------------------------------------------------------------- filters
  const f = st.f;
  const listBox = el('div');
  let summary = null; // the phone's "Filters (n)" button, set below
  const countFilters = () => {
    const n = Object.keys(f).length;
    if (summary) summary.textContent = n ? `${t('rl.filters')} (${n})` : t('rl.filters');
    return n;
  };
  const setFilter = (k, v) => {
    if (v) f[k] = v; else delete f[k];
    st.page = 0;
    countFilters();
    load();
  };

  const consCombo = combo({
    items: cons.data.map((c) => ({ value: c.id, label: c.full_name, sub: c.mobile })),
    value: f.consultantId ?? '',
    placeholder: t('rl.consultant.all'),
    onChange: (v) => setFilter('consultantId', v),
  });

  const projectOptions = () => {
    const pj = projs.data.filter((p) => !f.type || p.type === f.type);
    const ot = others.data.filter((o) => !f.type || o.project_type === f.type);
    const opts = [{ label: t('common.all'), value: '' }];
    if (pj.length) opts.push({ group: t('rl.projectsGroup'), options: pj.map((p) => ({ label: `${iso(p.name)} · ${p.type}`, value: `p:${p.id}` })) });
    if (ot.length) {
      const seen = new Set();
      const uniq = ot.filter((o) => !seen.has(o.name) && seen.add(o.name));
      opts.push({ group: t('rl.otherGroup'), options: uniq.map((o) => ({ label: `${iso(o.name)} (${t('card.other')})`, value: `o:${o.name}` })) });
    }
    return opts;
  };
  {
    // A saved filter may point at a project that was deleted or renamed meanwhile.
    const offered = projectOptions().flatMap((o) => (o.group ? o.options : [o])).map((o) => o.value);
    if (f.project && !offered.includes(f.project)) delete f.project;
  }
  let projSelect = select(projectOptions(), f.project, (v) => setFilter('project', v));
  const projField = field(t('rl.project'), projSelect);

  const typeSelect = select(
    [{ label: t('common.all'), value: '' }, ...PROJECT_TYPES.map((x) => ({ label: t(`type.${x}`), value: x }))],
    f.type, (v) => {
      if (v) f.type = v; else delete f.type;
      const opts = projectOptions();
      const offered = opts.flatMap((o) => (o.group ? o.options : [o])).map((o) => o.value);
      if (f.project && !offered.includes(f.project)) delete f.project;
      const fresh = select(opts, f.project, (val) => setFilter('project', val));
      projSelect.replaceWith(fresh);
      projSelect = fresh;
      st.page = 0;
      countFilters();
      load();
    });

  // The phone's own date box shows mm/dd/yyyy on many devices; show "8 Oct 2026" / "8 أكتوبر 2026"
  // on top of it instead, and still open the phone's own calendar when tapped.
  const dateInput = (key) => {
    const shown = el('span', { class: f[key] ? '' : 'muted', text: f[key] ? fmtIsoDay(f[key]) : t('rl.pickDate') });
    const input = el('input', {
      type: 'date', value: f[key] ?? '', 'aria-label': t(key === 'from' ? 'rl.from' : 'rl.to'),
      onclick: (e) => { try { e.target.showPicker(); } catch { /* older browsers open it themselves */ } },
      onchange: (e) => {
        const v = e.target.value;
        shown.textContent = v ? fmtIsoDay(v) : t('rl.pickDate');
        shown.className = v ? '' : 'muted';
        setFilter(key, v);
      },
    });
    return el('span', { class: 'input date-box' }, shown, input);
  };
  const fromInput = dateInput('from');
  const toInput = dateInput('to');

  const clearBtn = el('button', {
    type: 'button', class: 'btn', text: t('rl.clear'),
    onclick: () => { st.f = {}; st.page = 0; render(ctx, view, _params, isCurrent); },
  });

  const filterGrid = el('div', { class: 'filters' },
    field(t('rl.consultant'), consCombo),
    field(t('rl.type'), typeSelect),
    projField,
    field(t('rl.from'), fromInput),
    field(t('rl.to'), toInput),
    el('div', { class: 'field' }, clearBtn));

  // Phones: filters fold away behind one button (open when a filter is already set).
  summary = el('summary');
  const filters = el('details', { class: 'filters-box', open: countFilters() > 0 || !window.matchMedia('(max-width: 700px)').matches },
    summary, filterGrid);
  view.lastChild.replaceWith(el('div', {}, filters, listBox));

  // ---------------------------------------------------------------- list
  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    listBox.replaceChildren(loadingBlock());
    const from = st.page * CONFIG.PAGE_SIZE;
    const { data, count, error } = await applyFilters(
      ctx.sb.from('reports').select(LIST_COLS, { count: 'exact' }), f)
      .order('report_date', { ascending: false })
      .order('submitted_at', { ascending: false })
      .range(from, from + CONFIG.PAGE_SIZE - 1);
    if (!isCurrent() || seq !== loadSeq) return;
    if (error) {
      listBox.replaceChildren(errorBlock(t('err.load'), load));
      return;
    }

    const table = dataTable({
      rows: data,
      empty: t('rl.empty'),
      onRowClick: (r) => ctx.go(`report/${r.id}`),
      cls: 'cards',
      columns: [
        { label: t('col.consultant'), cls: 'name', render: (r) => el('span', { dir: 'auto', text: r.consultant_name_snapshot }) },
        { label: t('col.type'), cls: 'badge', render: (r) => el('span', { class: 'pill', text: r.project_type }) },
        { label: t('col.mobile'), cls: 'hide-m', render: (r) => el('span', { class: 'ltr', dir: 'ltr', text: r.consultant_mobile_snapshot }) },
        { label: t('col.project'), cls: 'plain', render: (r) => el('span', { dir: 'auto', text: cardProjectName(r, getLang()) }) },
        { label: t('col.date'), cls: 'num hide-m', render: (r) => fmtIsoDay(reportDay(r)) },
        { label: t('col.time'), cls: 'num hide-m', render: (r) => sentLabel(r) },
        {
          label: t('col.photos'), cls: 'num hide-m',
          render: (r) => (r.photos_expected > r.photo_count
            ? el('span', { class: 'pill warn', title: t('exp.photosPending'), text: `${r.photo_count}/${r.photos_expected}` })
            : String(r.photo_count)),
        },
        {
          // Phones: date, time and photos on one line.
          label: '', cls: 'm-only foot',
          render: (r) => `${fmtIsoDay(reportDay(r))} · ${sentLabel(r)} · ${t('col.photos')}: ${r.photos_expected > r.photo_count ? `${r.photo_count}/${r.photos_expected}` : r.photo_count}`,
        },
      ],
    });

    const total = count ?? 0;
    if (total > 0 && from >= total) {
      st.page = Math.floor((total - 1) / CONFIG.PAGE_SIZE);
      load();
      return;
    }
    const a = total ? from + 1 : 0;
    const b = Math.min(from + CONFIG.PAGE_SIZE, total);
    const prev = el('button', { type: 'button', class: 'btn sm', text: t('common.prev'), disabled: st.page === 0, onclick: () => { st.page--; load(); } });
    const next = el('button', { type: 'button', class: 'btn sm', text: t('common.next'), disabled: b >= total, onclick: () => { st.page++; load(); } });
    listBox.replaceChildren(table, el('div', { class: 'pager' },
      el('span', { class: 'muted small', text: t('rl.count', { a, b, n: total }) }),
      el('div', { class: 'actions' }, prev, next)));
  }
  load();

  // ---------------------------------------------------------------- exports
  const labels = () => ({
    consultant: cons.data.find((c) => c.id === f.consultantId)?.full_name,
    project: f.project?.startsWith('p:')
      ? projs.data.find((p) => `p:${p.id}` === f.project)?.name
      : f.project?.startsWith('o:') ? `${f.project.slice(2)} (Other)` : undefined,
  });

  async function runExport(kind) {
    pdfBtn.disabled = true;
    xlsBtn.disabled = true;
    try {
      prog.set(0.02, t('exp.preparing', { p: '' }));
      await (kind === 'pdf' ? ctx.loadLibs('html2canvas', 'jspdf', 'filesaver') : ctx.loadLibs('xlsx', 'filesaver'));
      const rows = await fetchAllReports(ctx.sb, f, (n) => prog.set(0.05, t('exp.preparing', { p: n })));
      if (!rows.length) {
        ctx.toast(t('exp.none'));
        return;
      }
      const range = exportRange(f, rows);
      const base = exportBaseName('Daily_Reports', range);
      if (kind === 'pdf') {
        const photos = rows.reduce((n, r) => n + (r.report_photos?.length ?? 0), 0);
        const phone = window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 1000;
        if (phone && rows.length > 50) {
          ctx.toast(t('exp.tooBigPhone', { r: rows.length }));
          return;
        }
        if (rows.length > 30 && !window.confirm(t('exp.confirmBig', { r: rows.length, p: photos }))) return;
        const blob = await buildPdf({
          reports: rows,
          filterParts: filterParts(f, labels(), rows.length, range),
          loadPhotos: photoLoader(ctx.sb),
          onProgress: (d, n) => prog.set(0.08 + 0.9 * (d / n), t('exp.preparing', { p: `${d}/${n}` })),
        });
        saveBlob(blob, `${base}.pdf`);
      } else {
        saveBlob(buildExcel(rows), `${base}.xlsx`);
      }
    } catch (e) {
      ctx.toast(t('exp.failed', { msg: e.message ?? e }));
    } finally {
      prog.hide();
      pdfBtn.disabled = false;
      xlsBtn.disabled = false;
    }
  }
  pdfBtn.addEventListener('click', () => runExport('pdf'));
  xlsBtn.addEventListener('click', () => runExport('xlsx'));
}
