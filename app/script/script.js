window.onpageshow = function() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener('message', function(event) {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'update.html':
        document.querySelectorAll(msg.selector).forEach(function(elem) {
          elem.innerHTML = msg.html;
        });
        break;
      default:
        break;
    }
  });
}
