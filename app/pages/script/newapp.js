document.addEventListener('change', (event) => {
  const elem = event.target;
  if (elem.dataset.id === 'newapp.image') {
    install(elem.value);
  }
});

function install(app) {
  ws.send(JSON.stringify({
    type: 'newapp.image',
    value: app
  }));
}
