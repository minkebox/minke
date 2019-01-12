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

const INLINE_BORDER = 50 * 2;

function closeInlinePage() {
  const div = document.querySelector(".inline-page");
  if (div) {
    div.remove();
  }
}

function openInlinePage(url) {
  closeInlinePage();
  const builder = document.createElement('div');
  const width = document.body.clientWidth - INLINE_BORDER;
  const height = document.body.clientHeight - INLINE_BORDER;
  builder.innerHTML = `<div class="inline-page"><iframe frameborder="0" border="0" width="${width}" height="${height}" src="${url}"></div>`;
  const scrollY = window.scrollY;
  setTimeout(() => {
    window.scrollTo(0, scrollY);
  }, 0);
  document.body.appendChild(builder.firstElementChild);
  resizeInlinePage();
  const div = document.querySelector(".inline-page");
  function noScroll(e) {
    e.preventDefault();
  }
  div.addEventListener('scroll', noScroll);
  div.addEventListener('mousewheel', noScroll);
  div.addEventListener('click', closeInlinePage);
}

 function resizeInlinePage() {
  const div = document.querySelector(".inline-page");
  const frame = document.querySelector(".inline-page iframe");
  if (div && frame) {
    frame.width = div.clientWidth - INLINE_BORDER;
    frame.height = div.clientHeight - INLINE_BORDER;
  }
}

window.addEventListener('resize', resizeInlinePage);
