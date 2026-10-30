import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GameStore } from './store.js';
import { newGame, buySupplies, setPrice, sellLemonade } from './game.js';

const zero = () => 0;
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'lemonade-v2-'));
  const path = join(dir, 'game.sqlite');
  try { fn(path); } finally { rmSync(dir, { force: true, recursive: true }); }
}

test('game saves and reloads after process store closes', () => withStore(path => {
  const first = new GameStore(path);
  const started = first.startOrResume('game1', () => newGame(zero));
  assert.equal(started.gameState.money, 20);
  first.apply('game1', 'op1', 'buy_supplies', { cups: 10 }, s => buySupplies(s, { cups: 10 }));
  first.close();
  const reopened = new GameStore(path);
  const restored = reopened.getActive();
  assert.equal(restored.gameId, 'game1');
  assert.equal(restored.gameState.money, 19.5);
  assert.equal(restored.gameState.inventory.cups, 10);
  reopened.close();
}));

test('startOrResume does not create a new save when an active one exists', () => {
  const db = new GameStore();
  try {
    db.startOrResume('a', () => newGame(zero));
    const existing = db.startOrResume('b', () => { throw Error('must not create'); });
    assert.equal(existing.gameId, 'a');
    assert.equal(db.listGames().length, 1);
  } finally { db.close(); }
});

test('new game archives previous save without deleting it', () => {
  const db = new GameStore();
  try {
    db.startOrResume('old', () => newGame(zero));
    db.startFresh('new', () => newGame(zero));
    assert.equal(db.getActive().gameId, 'new');
    assert.equal(db.get('old').gameState.day, 1);
    assert.equal(db.listGames().length, 2);
    assert.throws(() => db.apply('old', randomUUID(), 'set_price', { price: 0.3 }, s => setPrice(s, 0.3)), /read-only/);
  } finally { db.close(); }
});

test('idempotent sale cannot earn money twice', () => {
  const db = new GameStore();
  try {
    db.startOrResume('g', () => newGame(zero));
    const purchases = { cups: 10, lemons: 4, sugar: 4, ice: 15 };
    db.apply('g', 'buy', 'buy_supplies', purchases, s => buySupplies(s, purchases));
    db.apply('g', 'price', 'set_price', { price: 0.25 }, s => setPrice(s, 0.25));
    const first = db.apply('g', 'sell', 'sell_lemonade', {}, sellLemonade);
    const replay = db.apply('g', 'sell', 'sell_lemonade', {}, sellLemonade);
    assert.deepEqual(replay, first);
    assert.equal(db.get('g').version, 4);
    assert.throws(() => db.apply('g', 'another-sale', 'sell_lemonade', {}, sellLemonade), /not allowed/);
    assert.throws(() => db.apply('g', 'sell', 'set_price', { price: 0.3 }, s => setPrice(s, 0.3)), /already used/);
  } finally { db.close(); }
});

test('invalid operations roll back without a partial write', () => {
  const db = new GameStore();
  try {
    db.startOrResume('g', () => newGame(zero));
    assert.throws(() => db.apply('g', 'bad', 'buy_supplies', { cups: -1 }, s => buySupplies(s, { cups: -1 })));
    assert.equal(db.get('g').version, 1);
    assert.equal(db.get('g').gameState.money, 20);
  } finally { db.close(); }
});
