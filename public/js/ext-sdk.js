/*
 * GamePanel extension SDK. Include it in an extension page or widget:
 *
 *   <script src="/js/ext-sdk.js"></script>
 *   gamepanel.call('servers.list').then(function (r) { ... });
 *
 * The page runs in a sandboxed iframe: it cannot reach the panel's cookies or
 * API directly, only the read-only methods the panel's bridge answers
 * (see docs/extensions.md). The panel's colours arrive as CSS variables.
 */
(function () {
  var pending = {};
  var next = 0;
  window.gamepanel = {
    call: function (method, params) {
      return new Promise(function (resolve, reject) {
        var id = ++next;
        pending[id] = [resolve, reject];
        parent.postMessage({ gp: 1, id: id, method: method, params: params || {} }, '*');
        setTimeout(function () {
          if (pending[id]) {
            delete pending[id];
            reject(new Error('The panel did not answer'));
          }
        }, 10000);
      });
    },
    onTheme: null,
  };
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var m = event.data;
    if (!m || m.gp !== 1) return;
    if (m.event === 'theme') {
      var root = document.documentElement;
      Object.keys(m.vars || {}).forEach(function (k) {
        root.style.setProperty(k, m.vars[k]);
      });
      root.style.colorScheme = m.mode;
      if (typeof window.gamepanel.onTheme === 'function') window.gamepanel.onTheme(m);
    } else if (pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      if (m.error) p[1](new Error(m.error));
      else p[0](m.result);
    }
  });
  parent.postMessage({ gp: 1, event: 'ready' }, '*');
})();
