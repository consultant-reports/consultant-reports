// If a script fails to download (weak signal), the app never starts: after 15 s offer a reload
// instead of an endless spinner. Plain script (no modules) so it runs even when the rest fails.
(function () {
  // Never run inside someone else's frame (clickjacking).
  if (window.top !== window.self) {
    try { window.top.location = window.self.location.href; } catch (e) { document.documentElement.style.display = 'none'; }
    return;
  }
  // Browsers older than ~2021 (iOS < 15.4, old Samsung Internet) cannot run this app.
  var old = typeof Array.prototype.at !== 'function' || typeof String.prototype.replaceAll !== 'function'
    || typeof structuredClone !== 'function';
  if (old) {
    document.addEventListener('DOMContentLoaded', function () {
      var l = document.getElementById('screenLoading') || document.getElementById('loading');
      if (l) {
        l.innerHTML = '<p>Your browser is too old for this app. Open the link in Google Chrome, or update your phone.<br>' +
          '<span lang="ar" dir="rtl">متصفحك قديم ولا يدعم هذا التطبيق. افتح الرابط في Google Chrome أو حدّث جوالك.</span></p>';
      }
    });
    return;
  }
  setTimeout(function () {
    var l = document.getElementById('screenLoading') || document.getElementById('loading');
    if (!l || l.hidden || window.__dcrBooted) return;
    l.innerHTML = '<p>Could not load the page. Check your connection.<br>' +
      '<span lang="ar" dir="rtl">تعذّر تحميل الصفحة. تأكد من الاتصال.</span></p>' +
      '<button type="button" class="btn primary" id="fallbackReload">Retry / إعادة المحاولة</button>';
    document.getElementById('fallbackReload').addEventListener('click', function () { location.reload(); });
  }, 15000);
}());
