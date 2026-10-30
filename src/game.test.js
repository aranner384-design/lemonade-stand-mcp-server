import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame, buySupplies, setPrice, sellLemonade, nextDay,
  potentialCustomers
} from './game.js';

const sunny = () => 0;
const game = () => newGame(sunny);

test('new game starts on day one with $20 and fresh weather', () => {
  const state = game();
  assert.equal(state.day, 1);
  assert.equal(state.money, 20);
  assert.equal(state.status, 'buying');
  assert.deepEqual(state.inventory, { cups: 0, lemons: 0, sugar: 0, ice: 0 });
  assert.deepEqual(state.weather, { temp: 50, condition: 'Sunny' });
});

test('purchase deducts dollars in cents and updates inventory', () => {
  const s = buySupplies(game(), { cups: 10, lemons: 4, sugar: 4, ice: 15 });
  assert.equal(s.money, 18.48);
  assert.deepEqual(s.inventory, { cups: 10, lemons: 4, sugar: 4, ice: 15 });
  assert.equal(s.status, 'pricing');
  assert.equal(s.purchaseHistory[0].totalCost, 1.52);
});

test('purchase rejects negative, fraction, unknown and unaffordable items', () => {
  for (const purchase of [
    { cups: -1 }, { ice: 0.5 }, { cups: NaN },
    { cups: Infinity }, { bananas: 1 }, { cups: 10000 }, {}
  ]) {
    assert.throws(() => buySupplies(game(), purchase));
  }
});

test('prices require positive finite two-decimal dollars', () => {
  for (const price of [-0.1, 0, NaN, Infinity, 0.001, 101, '0.30']) {
    assert.throws(() => setPrice(game(), price));
  }
  assert.equal(setPrice(game(), 0.29).pricePerCup, 0.29);
});

test('sell a partial pitcher consumes whole pitcher ingredients and melts ice', () => {
  let s = buySupplies(game(), { cups: 5, lemons: 4, sugar: 4, ice: 15 });
  s = setPrice(s, 0.25);
  s = sellLemonade(s);
  assert.equal(s.dailyResults.sales, 5);
  assert.equal(s.dailyResults.pitchersUsed, 1);
  assert.deepEqual(s.inventory, { cups: 0, lemons: 0, sugar: 0, ice: 0 });
  assert.equal(s.dailyResults.cost, 1.27);
  assert.equal(s.dailyResults.revenue, 1.25);
  assert.equal(s.money, 20 - 1.27 + 1.25);
  assert.equal(s.status, 'reporting');
  assert.throws(() => sellLemonade(s), /not allowed/i);
});

test('cannot skip a day without selling; day 14 finishes', () => {
  let s = game();
  assert.throws(() => nextDay(s), /not allowed/i);
  for (let i = 1; i <= 14; i++) {
    s = setPrice(s, 0.25);
    s = sellLemonade(s);
    assert.equal(s.status, 'reporting');
    s = nextDay(s, sunny);
  }
  assert.equal(s.day, 14);
  assert.equal(s.status, 'gameOver');
  assert.equal(s.salesHistory.length, 14);
  assert.throws(() => setPrice(s, 0.25), /not allowed/i);
});

test('original weather and price demand behavior preserved', () => {
  assert.equal(potentialCustomers({ temp: 75, condition: 'Sunny' }, 0.25), 40);
  assert.equal(potentialCustomers({ temp: 75, condition: 'Rainy' }, 0.25), 15);
});
