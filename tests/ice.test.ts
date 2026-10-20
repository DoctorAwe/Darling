import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { TurnConfig, issueIce } from '../apps/server/src/ice';
import { IceConfig } from '../packages/protocol/src/index';

test('TURN credentials expire, bind user, and never disclose the signing secret', () => {
  const config = TurnConfig.parse({ publicIp: '203.0.113.10', secret: 'ab'.repeat(32) });
  const ice = IceConfig.parse(issueIce(config, 'dva', 1700000000123));
  assert.equal(ice.expiresAt, 1700003600000);
  const relay = ice.iceServers[1];
  assert.equal(relay.username, '1700003600:dva');
  assert.equal(relay.credential, createHmac('sha1', config.secret).update('1700003600:dva').digest('base64'));
  assert.deepEqual(relay.urls, ['turn:203.0.113.10:3478?transport=udp', 'turn:203.0.113.10:3478?transport=tcp']);
  assert.notEqual(issueIce(config, 'mercy', 1700000000123).iceServers[1].credential, relay.credential);
  assert.notEqual(issueIce(config, 'dva', 1700000010123).iceServers[1].credential, relay.credential);
  assert.equal(JSON.stringify(ice).includes(config.secret), false);
  assert.deepEqual(issueIce(undefined, 'dva'), { iceServers: [], expiresAt: null });
});

test('TURN configuration rejects bad addresses, secret, port and lifetime', () => {
  const base = { publicIp: '203.0.113.10', secret: 'ab'.repeat(32) };
  for (const patch of [{publicIp:'host/name'}, {secret:'replace-me'}, {port:0}, {ttlSeconds:10}, {ttlSeconds:86401}]) {
    assert.equal(TurnConfig.safeParse({...base,...patch}).success, false);
  }
});
