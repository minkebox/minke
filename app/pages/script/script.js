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

function share(id, elem) {
  const parent = elem.parentElement.parentElement;
  const name = parent.firstElementChild.firstElementChild;
  const checked = parent.firstElementChild.nextElementSibling.nextElementSibling.firstElementChild;
  if (name == elem) {
    checked.checked = true;
  }
  if (property[id] != checked.checked) {
    property[id] = checked.checked;
    visibles.forEach(v => v());
  }
  ws.send(JSON.stringify({
    type: 'action.change',
    property: id,
    value: { shared: checked.checked, target: name.value }
  }));
}

function cmd(command) {
  ws.send(JSON.stringify({
    type: command
  }));
}

function filter(net) {
  if (!net) {
    document.querySelectorAll('.filter').forEach((elem) => {
      elem.classList.remove('hidden');
    });
  }
  else {
    document.querySelectorAll('.filter').forEach((elem) => {
      if (elem.classList.contains(net)) {
        elem.classList.remove('hidden');
      }
      else {
        elem.classList.add('hidden');
      }
    });
  }
}

let editor = null;
function setEditMode(edit) {
  if (!editor) {
    const div = document.querySelector('.configure .skeleton .editor');
    editor = ace.edit(div, {
      useSoftTabs: true,
      tabSize: 2,
      printMargin: false
    });
    editor.on('change', () => {
      const content = editor.getValue();
      try {
        let skel;
        eval(`skel=${content}`);
        div.classList.remove('invalid');
        action('Skeleton', content);
      }
      catch (_) {
        div.classList.add('invalid');
      }
    });
  }
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

function install(app) {
  popbox.open('download');
  ws.send(JSON.stringify({
    type: 'newapp.image',
    value: app
  }));
}

document.addEventListener('drop', function(event) {
  if (event.target.getAttribute('contenteditable') === 'true' || event.target.nodeName === 'TEXTAREA') {
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

document.addEventListener('paste', function(event) {
  if (event.target.getAttribute('contenteditable')) {
    event.preventDefault();
    const text = (event.originalEvent || event).clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }
});

/* Inline page */

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
    builder.innerHTML = `<div class="inline-page pure-g"><div class="pure-u-1"><iframe allowfullscreen="true" allow="fullscreen" frameborder="0" width="${width}" height="${height}"></div></div>`;
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

/* Inline page */

/* Tables */
function addRmTableRow(action, event) {
  let tr;
  for (tr = event.target; tr.nodeName !== 'TR'; tr = tr.parentElement)
    ;
  let table;
  for (table = tr; table.nodeName !== 'TABLE'; table = table.parentElement)
    ;
  if (event.target.classList.contains('remove')) {
    tr.parentElement.removeChild(tr);
    saveTable(action, table);
  }
  else if (event.target.classList.contains('add')) {
    const ntr = document.createElement('TR');
    for (let i = 1; i < tr.childElementCount; i++) {
      ntr.appendChild(document.createElement('TD')).setAttribute('contenteditable', 'true');
    }
    const td = document.createElement('TD');
    td.classList.add('control');
    ntr.appendChild(td).innerHTML = '<span class="remove">&minus;</span>';
    table.querySelector('tbody').appendChild(ntr);
  }
}

function saveTable(action, table) {
  const values = [];
  for (let tr = table.querySelector('tbody tr'); tr; tr = tr.nextElementSibling) {
    const row = [];
    for (let td = tr.firstElementChild; td; td = td.nextElementSibling) {
      if (!td.classList.contains('control')) {
        row.push(td.innerText);
      }
    }
    values.push(row);
  }
  window.action(action, JSON.stringify(values));
}

/* Tables */

/* Popbox */

function Popbox(config){
  // config = {blur:false}
  this.currently_opened = [];
  if('blur' in config){
    if(config.blur){
      var main_content = document.querySelector('.popbox_main_content');
      if(main_content){
        main_content.classList.add('popbox_blur');
      }
    }
  }
  this.bindEvents();
}    

Popbox.prototype = {
  bindEvents: function (){
    var triggers = document.querySelectorAll('[data-popbox-target]');
    var closers = document.querySelectorAll('[data-popbox-close]');
    var popboxs = document.querySelectorAll('[data-popbox-id]');
    var self = this;
    if(triggers){
      for (var i = 0; i < triggers.length; i++) {
          triggers[i].addEventListener('click', function(e){
             e.preventDefault();
          var popbox_id = this.getAttribute('data-popbox-target');
          if(popbox_id){
            self.open(popbox_id);
          }
          }, false);
      }
    }
    if(closers){
      for (var i = 0; i < closers.length; i++) {
          closers[i].addEventListener('click', function(e){
             e.preventDefault();
          var popbox_id = this.getAttribute('data-popbox-close');
          if(popbox_id){
            self.close(popbox_id, this);
          }
          }, false);
      }
    }
    if(popboxs){
      for (var i = 0; i < popboxs.length; i++) {
          popboxs[i].addEventListener('click', function(e){
             e.preventDefault();
          var popbox_id = e.target.getAttribute('data-popbox-id');
          if(popbox_id){
            self.close(popbox_id, e.target);
          }
          }, false);

        popboxs[i].addEventListener(self.transition, function(e) {
          if(this.classList.contains('opened') && !this.classList.contains('visible')){
              this.classList.remove('opened');
          }
        });


      }
    }
    document.addEventListener('keyup', function(e){
      if(self.current(true) && e.keyCode == 27){
        self.close(self.current(true));
      }
    });

  },
  opened: function(popbox){
    if(popbox){
      var event = new CustomEvent("popbox_opened",{bubbles:true,detail:{popbox:popbox}});
      popbox.dispatchEvent(event);
    }
  },
  opening: function(popbox){
    if(popbox){
      var event = new CustomEvent("popbox_opening",{bubbles:true,detail:{popbox:popbox}});
      popbox.dispatchEvent(event);
    }
  },
  closing: function(popbox,source){
    if(popbox){
      var event = new CustomEvent("popbox_closing",{bubbles:true,detail:{popbox:popbox,source:source}});
      popbox.dispatchEvent(event);
    }
  },
  closed: function(popbox,source){
    if(popbox){
      var event = new CustomEvent("popbox_closed",{bubbles:true,detail:{popbox:popbox,source:source}});
      popbox.dispatchEvent(event);
    }
  },
  current: function(last){
    // last = false
    if(last){
      var current = null;
      if(this.currently_opened.length){
        current = this.currently_opened[this.currently_opened.length-1];      
      }
      return current;
    }else{
      return this.currently_opened;
    }
  },
  add: function(popbox){
    var popbox_id = this.getId(popbox);
    this.remove(popbox_id);
    this.currently_opened.push(popbox_id);
  },
  remove: function(popbox){
    var popbox_id = this.getId(popbox);
    var index = this.currently_opened.indexOf(popbox_id);
    if (index > -1) {
       this.currently_opened.splice(index, 1);
    }
  },
  zIndex: function(){
    var zindex = 9999;
    var last = this.current(true);
    if(last){
      var last = this.find(last);
      if(last){
        zindex = parseInt(last.style.zIndex);
      }
    }

    return zindex;
  },
  find: function(popbox_id){
    var popbox = this.select('[data-popbox-id="'+popbox_id+'"]');
    return popbox;
  },
  select: function(selector){
    return document.querySelector(selector);
  },
  clear: function(){
    var popboxes = document.querySelectorAll('[data-popbox-id].opened');
      for (var i = 0; i < popboxes.length; i++){
        this.close(popboxes[i]);
      }
      this.currently_opened = [];
    this.select('html').classList.remove('popbox_locked');  
    this.select('html').removeAttribute('popbox');  

  },
  close: function(popbox,source){
    var popbox_id = this.getId(popbox);
    var popbox = this.getpopbox(popbox);
    if(popbox){
      this.closing(popbox,source);
      this.remove(popbox_id);
      popbox.classList.remove('visible');
      popbox.style.zIndex = -999;
      if(this.currently_opened.length == 0){
        this.select('html').classList.remove('popbox_locked');          
      }
      if(this.current(true)){
        this.select('html').setAttribute('popbox',this.current(true));  
      }else{
        this.select('html').removeAttribute('popbox');  
      }
      this.closed(popbox,source);
    }

  },
  getpopbox: function(popbox){
    if(popbox instanceof HTMLElement){
      return popbox;
    }else{
      return this.find(popbox);
    }
  },
  getId: function(popbox){
    if(popbox instanceof HTMLElement){
      return popbox.getAttribute('data-popbox-id');
    }else{
      return popbox;
    }
  },
  open: function(popbox){
    var popbox_id = this.getId(popbox);
    var popbox = this.getpopbox(popbox);
    if(popbox){
      this.opening(popbox);
      popbox.style.zIndex = this.zIndex()+1;
        popbox.classList.add('opened');
        setTimeout(function () {
          popbox.classList.add('visible');
        });
        this.select('html').classList.add('popbox_locked');
        this.select('html').setAttribute('popbox',popbox_id);  
      this.add(popbox_id);
      this.opened(popbox);
    }
  }
}

/* Popbox */

window.addEventListener('pageshow', onPageShow);
window.addEventListener('resize', onResizePage);
window.addEventListener('load', onResizePage);
