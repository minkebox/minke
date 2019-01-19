function pageShow() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener('message', function(event) {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'update.html':
        document.querySelectorAll(msg.selector).forEach(function(elem) {
          if (elem.nodeName === 'IFRAME') {
            elem.srcdoc = msg.html;
          }
          else {
            elem.innerHTML = msg.html;
          }
        });
        break;
      default:
        break;
    }
  });
}

window.addEventListener('pageshow', pageShow);

const INLINE_BORDER = 75;

function closeInlinePage() {
  const div = document.querySelector(".inline-page");
  if (div) {
    div.remove();
  }
}

function openInlinePage(url) {
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
      console.log(box);
      const padding = parseInt(box.style.padding) || 0;
      frame.width = box.clientWidth - padding * 2;
      frame.height = box.clientHeight - padding * 2;
    }
  });
}

window.addEventListener('resize', onResizePage);
