function onload() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener('message', function(event) {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'html.update':
        const div = document.querySelector(`#application-${msg.id} .status`);
        if (div) {
          div.innerHTML = msg.html;
        }
        break;
      default:
        break;
    }
  });
}

window.onpageshow = onload;
