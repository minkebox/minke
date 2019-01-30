function handlers() {
  document.addEventListener('change', (event) => {
    const elem = event.target;
    const id = elem.dataset.id;
    if (id) {
      ws.send(JSON.stringify({
        type: 'newapp.change',
        property: id,
        value: elem.value
      }));
    }
  });
}

window.addEventListener('load', handlers);
