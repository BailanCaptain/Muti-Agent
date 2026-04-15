export const BRIDGE_SCRIPT = `
<script data-multi-agent-bridge="true">
(function() {
  if (window.__multiAgentBridge) return;
  window.__multiAgentBridge = true;

  var origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console)
  };

  function patchLevel(level) {
    console[level] = function() {
      origConsole[level].apply(console, arguments);
      try {
        var args = [];
        for (var i = 0; i < arguments.length; i++) {
          try {
            args.push(typeof arguments[i] === 'object' ? JSON.stringify(arguments[i]) : String(arguments[i]));
          } catch(e) {
            args.push('[unserializable]');
          }
        }
        parent.postMessage({
          type: 'console',
          source: 'multi-agent-bridge',
          level: level,
          args: args,
          timestamp: Date.now()
        }, '*');
      } catch(e) {}
    };
  }

  patchLevel('log');
  patchLevel('warn');
  patchLevel('error');
  patchLevel('info');

  window.addEventListener('error', function(e) {
    parent.postMessage({
      type: 'console',
      source: 'multi-agent-bridge',
      level: 'error',
      args: [e.message + ' at ' + (e.filename || '') + ':' + (e.lineno || 0)],
      timestamp: Date.now()
    }, '*');
  });

  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'screenshot-request' || e.data.source !== 'multi-agent-preview') return;
    try {
      var html = document.documentElement.outerHTML;
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + document.documentElement.scrollWidth + '" height="' + document.documentElement.scrollHeight + '">' +
        '<foreignObject width="100%" height="100%">' +
        '<div xmlns="http://www.w3.org/1999/xhtml">' + html + '</div>' +
        '</foreignObject></svg>';
      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement('canvas');
        canvas.width = Math.min(img.width, 1920);
        canvas.height = Math.min(img.height, 1080);
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        parent.postMessage({
          type: 'screenshot-result',
          source: 'multi-agent-bridge',
          dataUrl: canvas.toDataURL('image/png')
        }, '*');
      };
      img.onerror = function() {
        parent.postMessage({
          type: 'screenshot-error',
          source: 'multi-agent-bridge',
          error: 'SVG foreignObject rendering failed'
        }, '*');
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    } catch(e) {
      parent.postMessage({
        type: 'screenshot-error',
        source: 'multi-agent-bridge',
        error: e.message || 'Screenshot failed'
      }, '*');
    }
  });
})();
</script>`
