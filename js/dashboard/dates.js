// Dates for the dashboard screens, in the screen's language: "8 أكتوبر 2026" / "08 Oct 2026".
// Same names as the lib.js helpers, so a view only changes its import. Exports (PDF, Excel)
// keep using lib.js and are not affected.
import { getLang } from '../i18n.js?v=30';
import {
  fmtIsoDay as enDay, fmtTime, isoDay, reportDay,
} from '../lib.js?v=30';

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

export function fmtIsoDay(iso) {
  if (getLang() !== 'ar') return enDay(iso);
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${AR_MONTHS[Number(m) - 1]} ${y}`;
}
export function fmtDate(value) {
  return fmtIsoDay(isoDay(value));
}
export function fmtDateTime(value) {
  return `${fmtDate(value)}${getLang() === 'ar' ? '، ' : ', '}${fmtTime(value)}`;
}
export function sentLabel(r) {
  return reportDay(r) === isoDay(r.submitted_at) ? fmtTime(r.submitted_at) : `${fmtDate(r.submitted_at)} ${fmtTime(r.submitted_at)}`;
}
