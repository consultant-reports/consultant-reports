// Report detail (Section 8.3): the PDF card layout, with photos via short-lived signed URLs.
import { CONFIG } from '../config.js?v=29';
import { t, getLang } from '../i18n.js?v=29';
import { el, PROJECT_TYPES, errorKey } from '../lib.js?v=29';
import { FULL_COLS } from '../export/data.js?v=29';
import { sortedPhotos } from '../export/excel.js?v=29';
import { buildCard } from '../export/card.js?v=29';
import { loadingBlock, errorBlock, select, field } from './ui.js?v=29';

export async function render(ctx, view, [id], isCurrent) {
  const back = el('a', { class: 'btn sm', href: '#reports', text: `← ${t('rd.back')}` });
  view.replaceChildren(el('div', { class: 'detail' }, back, loadingBlock()));
  const box = view.firstChild;

  const { data: r, error } = await ctx.sb.from('reports').select(FULL_COLS).eq('id', id).maybeSingle();
  if (!isCurrent()) return;
  if (error) {
    box.lastChild.replaceWith(errorBlock(t('err.load'), () => render(ctx, view, [id], isCurrent)));
    return;
  }
  if (!r) {
    box.lastChild.replaceWith(el('p', { class: 'center-state', text: t('rd.notFound') }));
    return;
  }

  const paths = sortedPhotos(r).map((p) => p.storage_path);
  let urls = [];
  if (paths.length) {
    const signed = await ctx.sb.storage.from(CONFIG.PHOTO_BUCKET).createSignedUrls(paths, 3600);
    if (!isCurrent()) return;
    urls = (signed.data ?? []).map((s) => s.signedUrl).filter(Boolean);
  }
  const photos = urls.map((src) => ({ src, onClick: () => ctx.openLightbox(src) }));
  box.lastChild.replaceWith(buildCard(r, { photos, lang: getLang() }));

  // Staff tools: correct the project, or delete a test / wrong report (logged in the deletion log).
  const tools = el('div', { class: 'panel detail-tools' });
  const again = () => render(ctx, view, [id], isCurrent);
  const editBtn = el('button', { type: 'button', class: 'btn sm', text: t('rd.changeProject') });
  const delBtn = el('button', { type: 'button', class: 'btn sm danger-outline', text: t('rd.delete') });
  tools.append(el('div', { class: 'actions' }, editBtn, delBtn));
  box.append(tools);

  delBtn.addEventListener('click', async () => {
    if (!window.confirm(t('rd.deleteConfirm', { name: r.consultant_name_snapshot }))) return;
    delBtn.disabled = true;
    const { data, error: e1 } = await ctx.sb.rpc('staff_delete_report', { p_report_id: r.id });
    if (e1) { ctx.toast(t(errorKey(e1))); delBtn.disabled = false; return; }
    const names = data.object_names ?? [];
    for (let i = 0; i < names.length; i += 100) {
      await ctx.sb.storage.from(CONFIG.PHOTO_BUCKET).remove(names.slice(i, i + 100));
    }
    ctx.toast(t('rd.deleted'));
    ctx.go('reports');
  });

  editBtn.addEventListener('click', async () => {
    const { data: projs } = await ctx.sb.from('projects').select('id, name, type').order('name');
    let type = r.project_type;
    let project = r.project_id ? `p:${r.project_id}` : 'other';
    const otherIn = el('input', { class: 'input', value: r.project_other_name ?? '', maxlength: 150, dir: 'auto' });
    const projectBox = el('div');
    const renderProjects = () => {
      const opts = (projs ?? []).filter((p) => p.type === type).map((p) => ({ label: p.name, value: `p:${p.id}` }));
      opts.push({ label: t('rep.project.other'), value: 'other' });
      if (!opts.some((o) => o.value === project)) project = opts[0].value;
      projectBox.replaceChildren(field(t('rl.project'), select(opts, project, (v) => { project = v; otherIn.parentElement.hidden = v !== 'other'; })));
      otherIn.parentElement && (otherIn.parentElement.hidden = project !== 'other');
    };
    const otherField = field(t('rep.project.otherName'), otherIn);
    const save = el('button', {
      type: 'button', class: 'btn sm primary', text: t('common.save'),
      onclick: async () => {
        save.disabled = true;
        const { error: e2 } = await ctx.sb.rpc('staff_set_report_project', {
          p_report_id: r.id, p_type: type,
          p_project_id: project.startsWith('p:') ? project.slice(2) : null,
          p_other_name: project === 'other' ? otherIn.value : null,
        });
        save.disabled = false;
        if (e2) { ctx.toast(t(errorKey(e2))); return; }
        ctx.toast(t('cs.updated'));
        again();
      },
    });
    tools.replaceChildren(
      field(t('rl.type'), select(PROJECT_TYPES.map((x) => ({ label: t(`type.${x}`), value: x })), type, (v) => { type = v; renderProjects(); })),
      projectBox, otherField,
      el('div', { class: 'actions' }, save, el('button', { type: 'button', class: 'btn sm', text: t('common.cancel'), onclick: again })));
    renderProjects();
    otherField.hidden = project !== 'other';
  });
}
