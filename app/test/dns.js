const assert = require('assert');

describe('DNS', async function() {

  require('./fixture/system.fixture')();
  require('./fixture/dns.fixture')();

  describe('PrivateDNS', function() {

    it('setHostname', function() {
      this.dns.setHostname('myself', '10.10.1.2');
    });

    it('setDomainName', function() {
      this.dns.setDomainName('myhome');
    });

    it('registerHost', function() {
      this.dns.registerHost('ahost', '862fff1a-ce59-478d-8e8d-895f3303cb1e.minkebox.net', '10.10.1.3', null);
    });

    it('unregisterHost', function() {
      this.dns.unregisterHost('myhost');
    });

  });

  describe('DNS queries without domain', function() {

    beforeEach(function() {
      this.dns.setHostname('myself', '10.10.1.2');
      this.dns.setDomainName('');
      this.dns.registerHost('ahost', '862fff1a-ce59-478d-8e8d-895f3303cb1e.minkebox.net', '10.10.1.3', null);
    });

    it('query myself', async function() {
      const request = {
        id: 1,
        type: 'query',
        flags: 0,
        questions: [ { name: 'myself', type: 'A' }],
        answers: [],
        authorities: [],
        additionals: []
      };
      const response = {
        id: 0,
        type: 'response',
        flags: 0,
        questions: [],
        answers: [],
        authorities: [],
        additionals: []
      };
      const rinfo = {
      };
      await this.dns.query(request, response, rinfo);
      assert.equal(response.answers[0].data, '10.10.1.2');
    });

    it('query another host', async function() {
      const request = {
        id: 1,
        type: 'query',
        flags: 0,
        questions: [ { name: 'ahost', type: 'A' }],
        answers: [],
        authorities: [],
        additionals: []
      };
      const response = {
        id: 0,
        type: 'response',
        flags: 0,
        questions: [],
        answers: [],
        authorities: [],
        additionals: []
      };
      const rinfo = {
      };
      await this.dns.query(request, response, rinfo);
      assert.equal(response.answers[0].data, '10.10.1.3');
    });

    it('reverse query myself', async function() {
      const request = {
        id: 1,
        type: 'query',
        flags: 0,
        questions: [ { name: '2.1.10.10.in-addr.arpa', type: 'PTR' }],
        answers: [],
        authorities: [],
        additionals: []
      };
      const response = {
        id: 0,
        type: 'response',
        flags: 0,
        questions: [],
        answers: [],
        authorities: [],
        additionals: []
      };
      const rinfo = {
      };
      await this.dns.query(request, response, rinfo);
      assert.equal(response.answers[0].data, 'myself');
    });

  });

  describe('DNS queries with domain', function() {

    beforeEach(function() {
      this.dns.setHostname('myself', '10.10.1.2');
      this.dns.setDomainName('myhome');
      this.dns.registerHost('ahost', '862fff1a-ce59-478d-8e8d-895f3303cb1e.minkebox.net', '10.10.1.3', null);
    });

    it('query myself', async function() {
      const request = {
        id: 1,
        type: 'query',
        flags: 0,
        questions: [ { name: 'myself.myhome', type: 'A' }],
        answers: [],
        authorities: [],
        additionals: []
      };
      const response = {
        id: 0,
        type: 'response',
        flags: 0,
        questions: [],
        answers: [],
        authorities: [],
        additionals: []
      };
      const rinfo = {
      };
      await this.dns.query(request, response, rinfo);
      assert.equal(response.answers[0].data, '10.10.1.2');
    });

    it('query myself after domain change', async function() {
      this.dns.setDomainName('mynewhome');
      const request = {
        id: 1,
        type: 'query',
        flags: 0,
        questions: [ { name: 'myself.mynewhome', type: 'A' }],
        answers: [],
        authorities: [],
        additionals: []
      };
      const response = {
        id: 0,
        type: 'response',
        flags: 0,
        questions: [],
        answers: [],
        authorities: [],
        additionals: []
      };
      const rinfo = {
      };
      await this.dns.query(request, response, rinfo);
      assert.equal(response.answers[0].data, '10.10.1.2');
    });

    it('query another host', async function() {
      const request = {
        id: 1,
        type: 'query',
        flags: 0,
        questions: [ { name: 'ahost.myhome', type: 'A' }],
        answers: [],
        authorities: [],
        additionals: []
      };
      const response = {
        id: 0,
        type: 'response',
        flags: 0,
        questions: [],
        answers: [],
        authorities: [],
        additionals: []
      };
      const rinfo = {
      };
      await this.dns.query(request, response, rinfo);
      assert.equal(response.answers[0].data, '10.10.1.3');
    });

    it('query global host', async function() {
      const request = {
        id: 1,
        type: 'query',
        flags: 0,
        questions: [ { name: '862fff1a-ce59-478d-8e8d-895f3303cb1e.minkebox.net', type: 'A' }],
        answers: [],
        authorities: [],
        additionals: []
      };
      const response = {
        id: 0,
        type: 'response',
        flags: 0,
        questions: [],
        answers: [],
        authorities: [],
        additionals: []
      };
      const rinfo = {
      };
      await this.dns.query(request, response, rinfo);
      assert.equal(response.answers[0].data, '10.10.1.3');
    });

    it('query global host (uppercase)', async function() {
      const request = {
        id: 1,
        type: 'query',
        flags: 0,
        questions: [ { name: '862FFF1A-CE59-478D-8E8D-895F3303CB1E.minkebox.net', type: 'A' }],
        answers: [],
        authorities: [],
        additionals: []
      };
      const response = {
        id: 0,
        type: 'response',
        flags: 0,
        questions: [],
        answers: [],
        authorities: [],
        additionals: []
      };
      const rinfo = {
      };
      await this.dns.query(request, response, rinfo);
      assert.equal(response.answers[0].data, '10.10.1.3');
    });

    it('reverse query myself', async function() {
      const request = {
        id: 1,
        type: 'query',
        flags: 0,
        questions: [ { name: '2.1.10.10.in-addr.arpa', type: 'PTR' }],
        answers: [],
        authorities: [],
        additionals: []
      };
      const response = {
        id: 0,
        type: 'response',
        flags: 0,
        questions: [],
        answers: [],
        authorities: [],
        additionals: []
      };
      const rinfo = {
      };
      await this.dns.query(request, response, rinfo);
      assert.equal(response.answers[0].data, 'myself.myhome');
    });

  });

  describe('DNS queries which fail', function() {

    it('query something which doesnt exist', async function() {
      const request = {
        id: 1,
        type: 'query',
        flags: 0,
        questions: [ { name: 'something.somewhere', type: 'A' }],
        answers: [],
        authorities: [],
        additionals: []
      };
      const response = {
        id: 0,
        type: 'response',
        flags: 0,
        questions: [],
        answers: [],
        authorities: [],
        additionals: []
      };
      const rinfo = {
      };
      await this.dns.query(request, response, rinfo);
      assert.equal(response.answers.length, 0);
    });

  });

});
