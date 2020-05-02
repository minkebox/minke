const assert = require('assert');
const FS = require('fs');

require('./fixture/system.fixture')();
require('./fixture/skeletons.fixture')();


describe('Skeletons', async function() {

  describe('Builtins', function() {

    function validate(name) {
      it(`validate ${name}`, function() {
        let skel = null;
        eval(`skel=${FS.readFileSync(`./skeletons/builtin/${name}`, { encoding: 'utf8' })}`);
        assert.ok(skel);
        assert.equal(typeof skel.name, 'string', 'bad name');
        assert.equal(typeof skel.uuid, 'string', 'bad uuid');
        assert.ok(Array.isArray(skel.actions), 'bad actions');
        assert.ok(Array.isArray(skel.properties), 'bad properties');
        assert.ok(skel.image || skel.images, 'missing image');
      });
    }

    FS.readdirSync('./skeletons/builtin').forEach(skeleton => {
      validate(skeleton);
    });

  });

  describe('catalog', function() {

    it('catalog isnt empty', function() {
      assert.notEqual(this.skeletons.catalog().length, 0);
    });

  });

  describe('loadSkeleton', function() {

    it('load builtin', function() {
      assert.ok(this.skeletons.loadSkeleton('FE8D1F85-0F18-4FFB-BA7F-FD91D2354CFE'));
    });

    it('load skeleton which doesnt exist', function() {
      assert.ok(!this.skeletons.loadSkeleton('FE8D1F85-0000-0000-0000-FD91D2354CFE'));
    });

  });

  describe('parseDockerCompose', function() {

    it('one app', function() {
      const dc = `
        version: '3'
        services:
          web:
            image: 'test'
            volumes:
            - /config:/config
            ports:
            - 80:80
            environment:
            - ENABLE
        `;
      const sk = {
        "name": "web",
        "description": "",
        "image": "test",
        "tags": [
          "App"
        ],
        "actions": [],
        "properties": [
          { "type": "Environment", "name": "ENABLE" },
          { "type": "Directory", "name": "/config" },
          { "type": "Port", "name": "80/tcp", "port": 80, "protocol": "TCP", "web": { "path": "/", "tab": "newtab" } },
          {  "type": "Network", "name": "primary", "value": "home" }
        ],
        "monitor": {
          "cmd": "",
          "init": ""
        }
      };
      const cv = this.skeletons.parseDockerCompose(dc);
      delete cv.uuid; // This will always be different
      assert.deepEqual(cv, sk);
    });

    it('two apps', function() {
      const dc = `
        version: '3'
        services:
          one:
            image: 'test1'
            volumes:
            - /config1:/config
            ports:
            - 80:80
            environment:
            - ENABLE
          two:
            image: 'test2'
            volumes:
            - /config2:/config
            ports:
            - 90:90
            environment:
            - ENABLE_AGAIN
        `;
      const sk = {
        "name": "one",
        "description": "",
        "image": "test1",
        "tags": [
          "App"
        ],
        "actions": [],
        "delay": 0.1,
        "properties": [
          { "type": "Environment", "name": "ENABLE" },
          { "type": "Directory", "name": "/config" },
          { "type": "Port", "name": "80/tcp", "port": 80, "protocol": "TCP", "web": { "path": "/", "tab": "newtab" } },
          {  "type": "Network", "name": "primary", "value": "home" }
        ],
        "secondary": [
          {
            "image": "test2",
            "properties": [
              { "type": "Environment", "name": "ENABLE_AGAIN" },
              { "type": "Directory", "name": "/config" }
            ]
          }
        ],
        "monitor": {
          "cmd": "",
          "init": ""
        }
      };
      const cv = this.skeletons.parseDockerCompose(dc);
      delete cv.uuid; // This will always be different
      assert.deepEqual(cv, sk);
    });

  });

});
