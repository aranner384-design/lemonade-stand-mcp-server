// SQLite persistence and idempotency for Lemonade Stand V2.
// Uses node:sqlite, shipped with Node.js >= 22.13 (experimental in Node 22).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class GameStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        game_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_game
        ON games (is_active) WHERE is_active = 1;
      CREATE TABLE IF NOT EXISTS operations (
        game_id TEXT NOT NULL REFERENCES games(game_id),
        operation_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (game_id, operation_id)
      );
      CREATE TABLE IF NOT EXISTS new_game_requests (
        operation_id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(game_id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const version = this.db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();
    if (version && version.value !== '1') throw new Error('Unsupported database schema version');
    if (!version) this.db.prepare("INSERT INTO settings (key, value) VALUES ('schema_version', '1')").run();
  }

  close() { this.db.close(); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  unpack(row) {
    if (!row) return null;
    return {
      gameId: row.game_id,
      gameState: JSON.parse(row.state_json),
      version: row.version
    };
  }

  getActive() {
    return this.unpack(this.db.prepare('SELECT * FROM games WHERE is_active = 1').get());
  }

  get(gameId) {
    return this.unpack(this.db.prepare('SELECT * FROM games WHERE game_id = ?').get(gameId));
  }

  listGames() {
    return this.db.prepare(
      'SELECT game_id AS gameId, is_active AS active, created_at AS createdAt, archived_at AS archivedAt FROM games ORDER BY created_at DESC'
    ).all();
  }

  // Start is safe to call on reconnect: it returns the active game when one exists.
  startOrResume(gameId, createState) {
    return this.transaction(() => {
      const existing = this.getActive();
      if (existing) return existing;
      const now = new Date().toISOString();
      const state = createState();
      this.db.prepare(
        'INSERT INTO games (game_id, state_json, is_active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)'
      ).run(gameId, JSON.stringify(state), now, now);
      return this.get(gameId);
    });
  }

  // A new game never deletes old saves. Call only after explicit user confirmation.
  startFresh(gameId, createState, operationId) {
    if (typeof operationId !== 'string' || !operationId || operationId.length > 128) {
      throw new Error('operationId is required for new_game');
    }
    return this.transaction(() => {
      const prior = this.db.prepare(
        'SELECT game_id FROM new_game_requests WHERE operation_id = ?'
      ).get(operationId);
      if (prior) return this.get(prior.game_id);
      const now = new Date().toISOString();
      this.db.prepare(
        'UPDATE games SET is_active = 0, archived_at = ?, updated_at = ? WHERE is_active = 1'
      ).run(now, now);
      const state = createState();
      this.db.prepare(
        'INSERT INTO games (game_id, state_json, is_active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)'
      ).run(gameId, JSON.stringify(state), now, now);
      this.db.prepare(
        'INSERT INTO new_game_requests (operation_id, game_id, created_at) VALUES (?, ?, ?)'
      ).run(operationId, gameId, now);
      return this.get(gameId);
    });
  }

  // Each logical operation needs a stable, client-provided operationId.
  // Replaying it returns the original result; reusing it with different arguments is rejected.
  apply(gameId, operationId, toolName, args, updateFn) {
    if (typeof gameId !== 'string' || !gameId ||
        typeof operationId !== 'string' || !operationId || operationId.length > 128) {
      throw new Error('gameId and operationId are required');
    }
    return this.transaction(() => {
      const previous = this.db.prepare(
        'SELECT * FROM operations WHERE game_id = ? AND operation_id = ?'
      ).get(gameId, operationId);
      const argsJson = JSON.stringify(args);
      if (previous) {
        if (previous.tool_name !== toolName || previous.args_json !== argsJson) {
          throw new Error('operationId already used for different parameters');
        }
        return JSON.parse(previous.result_json);
      }
      const game = this.get(gameId);
      if (!game) throw new Error('Game not found');
      const record = this.db.prepare('SELECT is_active FROM games WHERE game_id = ?').get(gameId);
      if (record.is_active !== 1) throw new Error('Archived games are read-only');
      const updatedState = updateFn(game.gameState);
      if (!updatedState || typeof updatedState !== 'object') {
        throw new Error('Invalid state transition');
      }
      const result = { gameId, gameState: updatedState, version: game.version + 1 };
      const now = new Date().toISOString();
      this.db.prepare(
        'UPDATE games SET state_json = ?, version = version + 1, updated_at = ? WHERE game_id = ?'
      ).run(JSON.stringify(updatedState), now, gameId);
      this.db.prepare(
        'INSERT INTO operations (game_id, operation_id, tool_name, args_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(gameId, operationId, toolName, argsJson, JSON.stringify(result), now);
      return result;
    });
  }
}
