function loadDataHandlers() {
  document.querySelectorAll('.settings .portset').forEach((elem) => {
    elem.addEventListener('change', (event) => {
      console.log(event);
      const elem = event.target;
      if (elem.classList.contains('protocol')) {
        elem.parentElement.querySelector('.mdns-protocol').innerText = `_${elem.value.toLowerCase()}`;
      }
    });
  });
}

function editCmd(cmd) {
  if (document.body.classList.contains('editing')) {
    ws.send(JSON.stringify({
      type: cmd
    }));
  }
}

function editMode(edit) {
  document.querySelectorAll('.editable').forEach((elem) => {
    switch (elem.nodeName) {
      case 'DIV':
      case 'SPAN':
        elem.contentEditable = edit;
        break;
      case 'INPUT':
      case 'SELECT':
        elem.disabled = !edit;
        break;
      default:
        break;
    }
  });
  if (edit) {
    document.body.classList.add('editing');
  }
  else {
    document.body.classList.remove('editing');
  }
}

function monitorEdits() {
  document.addEventListener('change', (event) => {
    const elem = event.target;
    const id = elem.dataset.id;
    if (id && (elem.nodeName === 'INPUT' || elem.nodeName === 'SELECT')) {
      ws.send(JSON.stringify({
        type: 'settings.change',
        property: id,
        value: elem.type === 'checkbox' ? elem.checked : elem.value
      }));
    }
  });
  document.addEventListener('input', (event) => {
    const elem = event.target;
    const id = elem.dataset.id;
    if (id && (elem.nodeName === 'DIV' || elem.nodeName === 'SPAN')) {
      ws.send(JSON.stringify({
        type: 'settings.change',
        property: id,
        value: elem.innerText
      }));
    }
  });
  document.addEventListener('paste', function(event) {
    event.preventDefault();
    const text = (event.originalEvent || event).clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  });
  document.addEventListener('drop', function(event) {
    event.stopPropagation();
    event.preventDefault();
    if (event.dataTransfer && event.dataTransfer && event.dataTransfer.items && event.dataTransfer.items[0]) {
      const item = event.dataTransfer.items[0];
      if (item.kind === 'file')
      {
        const reader = new FileReader();
        reader.onload = function(e)
        {
          event.target.focus();
          document.execCommand('insertText', false, e.target.result);
        };
        reader.readAsText(item.getAsFile());
      }
    }
  });
}


window.addEventListener('load', loadDataHandlers);
window.addEventListener('load', monitorEdits);
