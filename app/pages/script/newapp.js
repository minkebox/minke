function install(app) {
  popbox.open('download');
  ws.send(JSON.stringify({
    type: 'newapp.image',
    value: app
  }));
}
