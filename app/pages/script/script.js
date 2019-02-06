let ws = { send: () => {} };

function onPageShow() {
  ws = new WebSocket(`ws://${location.host}${location.pathname}ws`);
  ws.addEventListener('message', function(event) {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'html.update':
        document.querySelectorAll(msg.selector).forEach(function(elem) {
          if (elem.nodeName === 'IFRAME') {
            elem.srcdoc = msg.html;
          }
          else {
            elem.innerHTML = msg.html;
          }
        });
        break;
      case 'html.replace':
        document.querySelectorAll(msg.selector).forEach(function(elem) {
          const builder = document.createElement('div');
          builder.innerHTML = msg.html;
          elem.parentNode.replaceChild(builder.firstElementChild, elem);
        });
        break;
      case 'html.update.attribute':
        document.querySelectorAll(msg.selector).forEach(function(elem) {
          elem.setAttribute(msg.name, msg.value);
        });
        break;
      case 'html.append':
        document.querySelectorAll(msg.selector).forEach(function(elem) {
          const builder = document.createElement('tbody');
          builder.innerHTML = msg.html;
          elem.appendChild(builder.firstElementChild);
        });
        break;
      case 'html.remove':
        document.querySelectorAll(msg.selector).forEach(function(elem) {
          elem.remove();
        });
        break;
      case 'html.truncate':
        document.querySelectorAll(msg.selector).forEach(function(elem) {
          const last = elem.lastElementChild;
          if (last) {
            last.remove();
          }
        });
        break;
      case 'page.reload':
        window.location.reload();
        break;
      case 'page.redirect':
        window.location.replace(msg.url);
        break;
      default:
        break;
    }
  });
}

let property = {};
let visibles = [];
function setActionProperties(props) {
  property = props || {};
}
function registerVisibles(vis) {
  visibles = vis || [];
  visibles.forEach(v => v());
}

function action(id, value) {
  if (property[id] != value) {
    property[id] = value;
    visibles.forEach(v => v());
  }
  ws.send(JSON.stringify({
    type: 'action.change',
    property: id,
    value: value
  }));
}

function cmd(command) {
  ws.send(JSON.stringify({
    type: command
  }));
}

function filter(net) {
  if (!net) {
    document.querySelectorAll('.app').forEach((elem) => {
      elem.classList.remove('hidden');
    });
  }
  else {
    document.querySelectorAll('.app').forEach((elem) => {
      if (elem.classList.contains(net)) {
        elem.classList.remove('hidden');
      }
      else {
        elem.classList.add('hidden');
      }
    });
  }
}

function setEditMode(edit) {
  if (edit === null) {
    return document.firstElementChild.classList.toggle('editing');
  }
  else if (edit) {
    document.firstElementChild.classList.add('editing');
    return true;
  }
  else {
    document.firstElementChild.classList.remove('editing');
    return false;
  }
}

function skelValid(editor) {
  try {
    let skel;
    eval(`skel=${editor.innerText}`);
    editor.classList.remove('invalid')
    return true;
  }
  catch (_) {
    editor.classList.add('invalid');
    return false;
  }
}

document.addEventListener('drop', function(event) {
  if (event.target.getAttribute('contenteditable') === 'true') {
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
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          document.execCommand('insertText', false, e.target.result);
        };
        reader.readAsText(item.getAsFile());
      }
    }
  }
});

function closeInlinePage() {
  const div = document.querySelector(".inline-page");
  if (div) {
    div.remove();
    document.body.removeEventListener('click', closeInlinePage);
    document.body.removeEventListener('touchstart', closeInlinePage);
  }
}

function openInlinePage(url, onClose) {
  closeInlinePage();
  if (url.split('#')[1] === 'newtab') {
    window.open(url.split('#')[0], '_black');
  }
  else {
    const builder = document.createElement('div');
    const width = document.body.clientWidth;
    const height = document.body.clientHeight;
    builder.innerHTML = `<div class="inline-page pure-g"><div class="pure-u-1-4"></div><div class="pure-u-3-4"><iframe allowfullscreen="true" allow="fullscreen" frameborder="0" width="${width}" height="${height}"></div></div>`;
    const scrollY = window.scrollY;
    setTimeout(() => {
      window.scrollTo(0, scrollY);
      document.body.addEventListener('click', closeInlinePage);
      document.body.addEventListener('touchstart', closeInlinePage);
    }, 0);
    const div = builder.firstElementChild;
    const insert = document.getElementById('insertion-point');
    insert.insertBefore(div, insert.firstElementChild);
    function noScroll(e) {
      e.preventDefault();
    }
    div.addEventListener('scroll', noScroll);
    div.addEventListener('mousewheel', noScroll);
    div.querySelector('iframe').src = url;
    onResizePage();
  }
}

function onResizePage() {
  document.querySelectorAll('.inline-page iframe').forEach((frame) => {
    const box = frame.parentElement;
    if (box) {
      frame.width = box.clientWidth;
      frame.height = window.innerHeight;
    }
  });
}

window.addEventListener('pageshow', onPageShow);
window.addEventListener('resize', onResizePage);
window.addEventListener('load', onResizePage);
