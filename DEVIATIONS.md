# Deviations from DAILY_REPORTS_SPEC.md

Deliberate differences from the specification, and why. Read this before “fixing” any of them.

## Security (Section 6)

1. **Consultants write through database functions, not direct table inserts.**
   The spec's table says anon may “insert/upsert” into `consultants`, `reports` and `report_photos`. With a public key that allows anyone to overwrite a consultant's name by mobile and to insert arbitrary rows. Instead anon has **no table privileges at all** (except reading active projects) and calls `register_consultant`, `update_my_details`, `submit_report` and `attach_photos`, which validate everything. The effect the spec asks for — consultants can submit but never read — is unchanged.
2. **Registering an existing mobile never overwrites the stored name.** Name changes go through “Edit my details”, which requires the device token issued at registration.
3. **Photo uploads are restricted to the folder of a fresh report.** Anon can upload only `YYYY/MM/DD/<report_id>/<n>.jpg` for a report created in the last 2 days, with `n` up to the number of photos that report declared; JPEG only, 1 MB max. No read, list, overwrite or delete (as the spec says).
4. **Link protection is built in but off** (Open question 3 was postponed by the owner). `app_settings.access_mode` = `none` (default) | `team_code` | `team_code_device`, switchable in Admin. Supporting additions: table `consultant_devices`, column `consultants.allow_new_device`, “Allow new phone” button on Consultants (only visible in `team_code_device` mode).
5. **Server-side limits**: 20 photos per report, 200,000 characters of report HTML, 20 reports per consultant per day (changeable in Admin).
6. **`archive_log` insert is allowed for the manager**, not only the admin. The spec's security table says “admin: write”, but Section 12 has the manager run the archive and write the log entry. The insert is restricted to the user's own id.
7. **Heartbeat is updated through `heartbeat_ping()`** rather than a raw anon `UPDATE`, so the time always comes from the server (`now()`) and nothing else in the row can be changed.

## Data model (Section 5)

8. Extra columns on `reports`: `photos_expected` and `photo_count`. They let the dashboard show “2/3” when a consultant's photos are still uploading, and they bound the storage policy.
9. Extra tables: `consultant_devices` (hashed device tokens), `app_settings` (single row).
10. `reports.consultant_id` and `project_id` use `on delete restrict`; projects are deactivated, not deleted.

## Consultant app (Section 7)

11. **Project type buttons** show the code in bold and the description beside it (`UGC` · Underground Cables) instead of the literal `UGC — Underground Cables` string, which read as a duplicate on small screens.
12. **Direction**: paragraphs and headings get automatic direction each (Arabic lines right-to-left, English left-to-right). A bulleted/numbered **list** takes one direction from its first item, so every item stays next to its number.
13. **Draft photos** are kept in IndexedDB (they do not fit in localStorage). Once the report row is saved and only photo uploads failed, the text is locked and **Retry** uploads just the remaining photos; the recorded time stays the original submission time.
14. A small “Could not load — Retry” message appears if a library fails to download (weak signal), instead of an endless spinner.

## Dashboard (Section 8)

15. Report detail labels follow the UI language (English/Arabic). The **PDF is always English**, matching the approved sample.
16. The Reports list is newest first (as specified). **PDF and Excel exports are chronological (oldest first)**, which reads naturally for a date range and an archive.
17. The Today screen also shows the number of reports and of active consultants next to the submitted / not-submitted counters.

## Exports (Section 10)

18. **PDF engine**: html2canvas + jsPDF as specified, but with our own paginator instead of html2pdf.js's page-break options. This is what guarantees “a card never splits”, the “<Name> — continued” photo continuation, and exports of a full month without freezing the browser (each card is rendered separately).
    - Consequence: PDF pages are images, so text in the PDF cannot be selected or searched. The Excel file carries the searchable text.
    - html2canvas draws small text with rounded (hinted) letter widths, which made words run together. The exporter draws text at 4× size under a ¼ transform to avoid that.
19. The running header's right side is empty (the spec allows “nothing or the filter summary”); the filter summary is on page 1.
20. Excel “Photo Files” lists the paths inside the archive ZIP (`Photos/<Consultant>/<date>/<file>.jpg`). If two reports by the same consultant, project and minute would produce the same file name, the later one gets a `_2` suffix.

## Storage and archive (Section 12)

21. **Two meters instead of one**: the free plan has separate quotas — 1 GB file storage and 500 MB database — so they are shown separately (both configurable in `js/config.js`). The spec's single “storage + DB estimate vs 1 GB” would be misleading.
22. **Archiving is blocked on phones** (touch screen narrower than 1000 px) with an explanation: a month of photos does not fit in a phone browser's memory.
23. **Large ranges are split** into several ZIPs of up to ~400 MB each (by whole days); each part contains its own PDF and Excel.
24. The archive range must end **before today**, so reports still being submitted are never archived.
25. If deletion is interrupted, the screen offers **Continue deletion**; the log entry is written only after deletion finishes.

## Keep-alive (Section 11)

26. The workflow commits the timestamp file **only when the last commit is 45+ days old**, not every day, so the history is not flooded and GitHub Pages is not rebuilt daily.

## Other

27. Fonts are **self-hosted** in `fonts/` instead of loaded from Google Fonts (no third-party requests; also needed for html2canvas).
28. The spec's Section 4 refers to “Section 9.6” for the Admin section; the correct section is 8.8.

## Changes after the three-way review (27 Sep 2026)

29. **One phone = one consultant, always.** Every phone keeps a permanent random id (`dcr.device`, also a cookie; kept across sign-out). A registered mobile can be used again only from its own phone, or after the manager taps **Allow new phone**; a phone already bound to someone cannot register a second name. **Release phone** (Consultants screen) frees a phone that changed hands. This replaces the separate `team_code_device` mode (treated as `team_code`). Honest limit: clearing site data, private mode or another browser looks like a new phone — no website can prevent that without SMS verification (paid).
30. **Submitting and attaching photos always require the phone's token**, and nothing about an existing consultant (not even the name) is returned to an unknown phone — this closes the identity-takeover path found in review.
31. **The consultant can change only the name** in "Edit my details". The mobile number is the identity; changes go through the manager.
32. **The manager can read and set the team code** (Consultants screen) — nothing else from the admin settings. Minimum 6 characters.
33. **Server-side limits**: wrong team codes are counted (20 per 10 minutes, then refused), 30 new consultants per day, 200 reports per hour, uploads stop at 950 MB of photos, report HTML ≤ 60,000 characters and checked against the allow-list on the server; `body_text` is now derived from the HTML on the server.
34. **Photo upload window is 3 days** (was 2). If photos still cannot be uploaded, the consultant can tap **Finish without the remaining photos**. Before a report is confirmed by the server the form is frozen, so a lost reply can no longer lose edits or break retries; photo slots are fixed (`n.jpg`) and never renumbered.
35. **Archive**: the newest day that can be archived is 4 days ago. Every storage object in the range goes into the ZIP (leftover uploads under `Unattached/`), deletion removes exactly what was zipped (report rows first, then files), large ranges download one ZIP per click, and deletion unlocks only after every part was saved. Report rows of today cannot be deleted by staff at all.
36. **All libraries are served from `vendor/`** (no CDN at run time) and both pages carry a strict Content-Security-Policy. The dashboard session is kept per tab (`sessionStorage`) (the site first lived on the shared `m7md-sas.github.io`; it now has its own origin `consultant-reports.github.io`); changing the password from the dashboard requires the current password.
37. Big PDF exports ask for confirmation (over 30 reports) and are refused on phones over 50 reports. Excel dates are real date cells. Network requests time out (30 s, 2 min for photos) so the Retry path takes over.
38. **Up to 2 devices per consultant without the manager** (e.g. the phone browser and WhatsApp's in-app browser, or phone + laptop). The second device is linked with a 6-digit code shown on the first device ("Link another device"), single use, valid 10 minutes; wrong codes count toward the same 20-per-10-minutes limit. A third device needs the manager's "Allow new phone". The Consultants screen shows "One device" / "Two devices".

## Round-2 review fixes (28 Sep 2026)

39. **Second device**: still linked with the 6-digit code from the first device (now consumed atomically and typed digits may be Arabic). A consultant with **no** linked device (e.g. after "Release phone") registers again freely. A lost first device → "Allow new phone", which now expires after 24 hours. Messages tell the consultant this route.
40. **Throttling**: wrong team/pairing codes are counted per device (10 per 10 minutes) with a global backstop of 300; a consultant returning on an already linked device is never throttled and needs no team code. Read-only (GET) calls to registration are refused, so guesses cannot bypass the counter.
41. **Report checks**: the server looks for dangerous attributes only inside tags (normal text such as "onsite = 12" is accepted); a report over 30 KB gets a clear "too long" message (also checked on the phone). Database stop at 420 MB (of 500).
42. **One token per device** (no unbounded rows); the phone refreshes its saved name/mobile from the server on every visit; a draft belongs to the consultant who wrote it.
43. **Deleting a consultant** is refused while they have reports from today; rows are deleted before photo files. A **deletion log** (reports, consultants, projects — who and when) is shown to the admin only.
44. **Archive**: a photo file that no longer exists is listed in `MISSING_PHOTOS.txt` instead of blocking the whole archive.
45. **Dashboard session** is persistent again (the site has its own origin). The page refuses to run inside another site's frame. iPhone users get an "Add to Home Screen" tip after sending (Safari clears site data after 7 days otherwise).

## Round-3 fixes: field use and stability (28 Sep 2026)

46. **"The report is for: Today / Yesterday"** — yesterday allowed until 12:00 Riyadh time. Stored as `reports.report_date`; the Today screen, list, filters, cards, PDF and Excel use it, and the sent time is shown with its date when it differs. The archive also selects by `report_date`.
47. **Device rules**: devices unused for 30 days don't count toward the 2-device limit; "Allow new phone" is fresh 24 h each time, the dashboard shows the hours left or "expired"; "Allow a new device for everyone (24 h)" for after holidays. iPhone tip moved to the registration screen (register inside the home-screen app).
48. **Consultant screen safety**: in-page confirmations (no `window.confirm`); a report that was sent but not confirmed says "NOT sent yet" with the date it was written and a "Discard" option; full-storage upload refusals say "keep it and retry later" instead of suggesting to drop photos; "Last report sent" line; "Submit another report" is secondary; pasted text colours are removed; the team code ignores capitals and has no auto-correct; mobile numbers accept `+966 05…`, `00966 05…` and invisible direction marks; full name (2+ words) required; photo messages show counts; old browsers get a clear message; a stale cached page reloads itself once.
49. **Server checks**: reports shorter than 10 characters are refused; the same text for the same project within 30 minutes is refused as a duplicate; code failures older than 1 hour are purged; the audit log keeps 1 year; signing out frees the phone when the consultant never sent anything.
50. **Manager tools**: delete a report (any day, logged) and change its project/type; merge a duplicate consultant into another (logged); names that look alike are flagged; link an "Other" name to an existing project. Storage warnings measure against the real stop levels (950 MB photos / 420 MB database) and also appear on the Today screen with a keep-alive warning; the dashboard uses the server's date.
51. **Archive parts** are now ~220 MB (PDF pages estimated at ~300 KB per report). Keep-alive commits even if the ping fails, and uses `actions/checkout@v5`.
52. **Forgot password**: the built-in Supabase email only reaches members of the owner's Supabase organisation, so the manager is told to ask the owner, who resets it in the Supabase dashboard.

## Home-screen app (8 Oct 2026)

53. **Add to home screen**: `manifest.webmanifest` + `icons/` make the consultant link installable as **Daily Reports** (standalone, no browser bar). The registration screen and the success screen show device-specific steps: iPhone (Share → Add to Home Screen, and register *inside* the icon because iOS gives the icon its own storage; the consultant is told only to register inside the icon). Arabic steps also show the English menu names, for phones set to English, Android Chrome / Samsung Internet (one-tap **Install the app** button when the browser offers it, otherwise menu steps), and in-app browsers such as WhatsApp (open in Chrome first). Nothing is shown when the page is already opened from the icon or on a computer; after a report the tip can be postponed for 14 days ("Later"). No service worker is added, so caching and the `?v=` update scheme are unchanged.

54. **Registration screen redesign**: a centred hero (app icon, “Daily Reports”, one-line promise) above the form, and the home-screen tip is a compact card whose steps stay folded under “Show me how”. On iPhone and in-app browsers the card sits above the form (it must be done before registering); on Android it sits below the form.
