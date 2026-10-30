// Lemonade Stand V2: deterministic game rules (no persistence or MCP transport).
// Original game copyright (c) 2025 Jim McQuillan, MIT license.
export const SUPPLY_PRICES_CENTS = Object.freeze({ cups: 5, lemons: 10, sugar: 8, ice: 2 });
export const MAX_PRICE_CENTS = 10000;
const VALID_WEATHER = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy'];

const money = (cents) => Math.round(cents) / 100;
const cents = (dollars) => Math.round(dollars * 100);

function requireStage(state, allowed) {
  if (!allowed.includes(state.status)) {
    throw new Error('Action not allowed when game status is ' + state.status);
  }
}

function requireMoney(value, label, maxCents = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      value <= 0 || Math.abs(value * 100 - Math.round(value * 100)) > 1e-7 ||
      cents(value) > maxCents) {
    throw new Error(label + ' must be a positive dollar amount with at most two decimals');
  }
}

export function generateWeather(random = Math.random) {
  const temperature = Math.floor(random() * 40) + 50;
  const condition = VALID_WEATHER[Math.floor(random() * VALID_WEATHER.length)];
  return { temp: temperature, condition };
}

export function newGame(random = Math.random) {
  return {
    day: 1,
    money: 20,
    inventory: { cups: 0, lemons: 0, sugar: 0, ice: 0 },
    purchaseHistory: [],
    salesHistory: [],
    dailyResults: null,
    pricePerCup: 0.25,
    weather: generateWeather(random),
    status: 'buying'
  };
}

export function buySupplies(state, quantities) {
  requireStage(state, ['buying', 'pricing']);
  if (!quantities || typeof quantities !== 'object' || Array.isArray(quantities)) {
    throw new Error('Supplies must be an object');
  }
  for (const key of Object.keys(quantities)) {
    if (!Object.hasOwn(SUPPLY_PRICES_CENTS, key)) {
      throw new Error('Unknown supply: ' + key);
    }
  }

  const purchased = {};
  let totalCents = 0;
  for (const item of Object.keys(SUPPLY_PRICES_CENTS)) {
    const amount = quantities[item] ?? 0;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(item + ' must be a nonnegative integer');
    }
    const cost = amount * SUPPLY_PRICES_CENTS[item];
    if (!Number.isSafeInteger(cost)) throw new Error('Purchase amount too large');
    totalCents += cost;
    if (!Number.isSafeInteger(totalCents)) throw new Error('Purchase total too large');
    purchased[item] = amount;
  }
  if (totalCents === 0) throw new Error('Purchase at least one supply');
  if (totalCents > cents(state.money)) throw new Error('Not enough money');

  const nextInventory = { ...state.inventory };
  for (const [item, amount] of Object.entries(purchased)) {
    const nextCount = nextInventory[item] + amount;
    if (!Number.isSafeInteger(nextCount)) throw new Error('Inventory too large');
    nextInventory[item] = nextCount;
  }
  return {
    ...state,
    money: money(cents(state.money) - totalCents),
    inventory: nextInventory,
    purchaseHistory: [
      ...state.purchaseHistory,
      { date: state.day, ...purchased, totalCost: money(totalCents) }
    ],
    status: 'pricing'
  };
}

export function setPrice(state, price) {
  requireStage(state, ['buying', 'pricing', 'selling']);
  requireMoney(price, 'Price', MAX_PRICE_CENTS);
  return { ...state, pricePerCup: price, status: 'selling' };
}

export function potentialCustomers(weather, price) {
  let customers = Math.floor(weather.temp / 3);
  if (weather.condition === 'Sunny') customers += 15;
  if (weather.condition === 'Partly Cloudy') customers += 10;
  if (weather.condition === 'Cloudy') customers += 5;
  if (weather.condition === 'Rainy') customers -= 10;
  if (price <= 0.15) customers += 10;
  if (price > 0.50) customers -= Math.floor((price - 0.50) * 30);
  return Math.max(0, customers);
}

export function sellLemonade(state) {
  requireStage(state, ['selling']);
  const inventory = state.inventory;
  const pitchersAvailable = Math.min(
    Math.floor(inventory.lemons / 4),
    Math.floor(inventory.sugar / 4),
    Math.floor(inventory.ice / 15)
  );
  const maxCups = Math.min(inventory.cups, pitchersAvailable * 10);
  const potential = potentialCustomers(state.weather, state.pricePerCup);
  const sales = Math.min(maxCups, potential);
  const pitchersUsed = Math.ceil(sales / 10);
  const revenueCents = sales * cents(state.pricePerCup);
  // Cost of sold cups plus each whole pitcher made; purchased supplies were paid for earlier.
  const costCents = sales * 5 + pitchersUsed * (4 * 10 + 4 * 8 + 15 * 2);
  const results = {
    day: state.day, sales,
    revenue: money(revenueCents),
    cost: money(costCents),
    profit: money(revenueCents - costCents),
    potentialCustomers: potential,
    unsatisfiedCustomers: Math.max(0, potential - sales),
    pitchersUsed
  };
  return {
    ...state,
    money: money(cents(state.money) + revenueCents),
    inventory: {
      cups: inventory.cups - sales,
      lemons: inventory.lemons - pitchersUsed * 4,
      sugar: inventory.sugar - pitchersUsed * 4,
      ice: 0
    },
    dailyResults: results,
    salesHistory: [...state.salesHistory, results],
    status: 'reporting'
  };
}

export function nextDay(state, random = Math.random) {
  requireStage(state, ['reporting']);
  if (state.day >= 14) return { ...state, status: 'gameOver' };
  return {
    ...state, day: state.day + 1, status: 'buying',
    weather: generateWeather(random),
    dailyResults: null,
    inventory: { ...state.inventory, ice: 0 }
  };
}
