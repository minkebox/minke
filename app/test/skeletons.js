const assert = require('assert');
const FS = require('fs');

describe('Skeletons', async function() {

  require('./fixture/system.fixture')();
  require('./fixture/skeletons.fixture')();

  describe('Builtins', function() {

    function validate(name) {
      it(`validate ${name}`, function() {
        let skel = null;
        eval(`skel=${FS.readFileSync(`./skeletons/builtin/${name}`, { encoding: 'utf8' })}`);
        assert.ok(skel);
        assert.equal(typeof skel.name, 'string', 'bad name');
        assert.ok(skel.uuid, 'missing uuid');
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
          { "type": "Network", "name": "primary", "value": "home" }
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
        "delay": 1,
        "properties": [
          { "type": "Environment", "name": "ENABLE" },
          { "type": "Directory", "name": "/config" },
          { "type": "Port", "name": "80/tcp", "port": 80, "protocol": "TCP", "web": { "path": "/", "tab": "newtab" } },
          { "type": "Network", "name": "primary", "value": "home" }
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

    it('environment as array', function() {
      const dc = `
        version: '3'
        services:
          web:
            environment:
            - ONE=1
            - TWO=2
        `;
      const sk = {
        "name": "web",
        "description": "",
        "image": undefined,
        "tags": [
          "App"
        ],
        "actions": [],
        "properties": [
          { "type": "Environment", "name": "ONE", "value": "1" },
          { "type": "Environment", "name": "TWO", "value": "2" },
          { "type": "Network", "name": "primary", "value": "home" }
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

    it('environment as hash', function() {
      const dc = `
        version: '3'
        services:
          web:
            environment:
              ONE: 1
              TWO: 2
        `;
      const sk = {
        "name": "web",
        "description": "",
        "image": undefined,
        "tags": [
          "App"
        ],
        "actions": [],
        "properties": [
          { "type": "Environment", "name": "ONE", "value": "1" },
          { "type": "Environment", "name": "TWO", "value": "2" },
          { "type": "Network", "name": "primary", "value": "home" }
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

    it('simple command', function() {
      const dc = `
        version: '3'
        services:
          web:
            command: do a thing
        `;
      const sk = {
        "name": "web",
        "description": "",
        "image": undefined,
        "tags": [
          "App"
        ],
        "actions": [],
        "properties": [
          { "type": "Arguments", "value": [ 'do', 'a', 'thing' ] },
          { "type": "Network", "name": "primary", "value": "home" }
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

    it('command array', function() {
      const dc = `
        version: '3'
        services:
          web:
            command: [
              'do',
              'a',
              'thing'
            ]
        `;
      const sk = {
        "name": "web",
        "description": "",
        "image": undefined,
        "tags": [
          "App"
        ],
        "actions": [],
        "properties": [
          { "type": "Arguments", "value": [ 'do', 'a', 'thing' ] },
          { "type": "Network", "name": "primary", "value": "home" }
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

    it('guess volumes are files or directories', function() {
      const dc = `
        version: '3'
        services:
          web:
            volumes:
            - /a:/config
            - /b:/config/
            - /c:/config.d
            - /d:/config.dir
            - /f:/config.json
            - /g:/config.conf
            - /h:/config.ini
            - /i:/config.xml
            - /j:/config.yml
            - /k:/config.xyz
        `;
      const sk = {
        "name": "web",
        "description": "",
        "image": undefined,
        "tags": [
          "App"
        ],
        "actions": [],
        "properties": [
          { "type": "Directory", "name": "/config" },
          { "type": "Directory", "name": "/config" },
          { "type": "Directory", "name": "/config.d" },
          { "type": "Directory", "name": "/config.dir" },
          { "type": "File", "name": "/config.json" },
          { "type": "File", "name": "/config.conf" },
          { "type": "File", "name": "/config.ini" },
          { "type": "File", "name": "/config.xml" },
          { "type": "File", "name": "/config.yml" },
          { "type": "File", "name": "/config.xyz" },
          { "type": "Network", "name": "primary", "value": "home" }
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
