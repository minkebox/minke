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
      case 'page.redirect':
        window.location.replace(msg.url);
        break;
      default:
        break;
    }
  });
}

const INLINE_BORDER = 75;

function closeInlinePage() {
  const div = document.querySelector(".inline-page");
  if (div) {
    div.remove();
  }
}

function openInlinePage(url, onClose) {
  closeInlinePage();
  const builder = document.createElement('div');
  const width = document.body.clientWidth - INLINE_BORDER * 2;
  const height = document.body.clientHeight - INLINE_BORDER * 2;
  builder.innerHTML = `<div class="inline-page" style="padding:${INLINE_BORDER}px"><iframe class="resize" frameborder="0" width="${width}" height="${height}"></div>`;
  const scrollY = window.scrollY;
  setTimeout(() => {
    window.scrollTo(0, scrollY);
  }, 0);
  const div = builder.firstElementChild;
  document.body.appendChild(div);
  function noScroll(e) {
    e.preventDefault();
  }
  div.addEventListener('scroll', noScroll);
  div.addEventListener('mousewheel', noScroll);
  div.addEventListener('click', closeInlinePage);
  div.firstElementChild.src = url;
  onResizePage();
}

function onResizePage() {
  document.querySelectorAll('iframe.resize').forEach((frame) => {
    const box = frame.parentElement;
    if (box) {
      const padding = parseInt(box.style.padding) || 0;
      frame.width = box.clientWidth - padding * 2;
      frame.height = box.clientHeight - padding * 2;
    }
  });
}

window.addEventListener('pageshow', onPageShow);
window.addEventListener('resize', onResizePage);
window.addEventListener('load', onResizePage);
