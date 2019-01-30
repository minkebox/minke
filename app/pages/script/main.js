function handler() {
  const menu = document.querySelector('.main .titlebar .menuicon');
  function menuHandler(event) {
    if (event.target == menu) {
      if (!document.querySelector('.main .titlebar .menu').classList.toggle('active')) {
        document.removeEventListener('click', menuHandler);
      }
      return;
    }
    switch (event.target.dataset.action || 'none') {
      case 'application.new':
        openInlinePage('new/application/');
        break;
      case 'network.new':
        openInlinePage('new/network/');
        break;
      default:
        break;
    }
    document.querySelector('.main .titlebar .menu').classList.remove('active');
    document.removeEventListener('click', menuHandler);
  }
  document.querySelector('.main .titlebar .menuicon').addEventListener('click', () => {
    document.addEventListener('click', menuHandler);
  });
}

window.addEventListener('load', handler);
