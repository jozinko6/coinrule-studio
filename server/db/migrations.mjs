/**
 * migrations.mjs — forward-only SQLite migrations (built-in node:sqlite).
 *
 * Each migration runs exactly once inside a transaction and is recorded in
 * `schema_migrations`. A failing migration rolls back completely, so the
 * database can never be left half-migrated.
 */

export const SCHEMA_VERSION = 2;

export const MIGRATIONS = [
  {
    id: 2,
    name: 'live_orders_client_id_unique',
    up(db) {
      // One order per clientOrderId — the database-level guard for idempotent submission.
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_live_orders_client_id ON live_orders (client_order_id) WHERE client_order_id IS NOT NULL;');
    },
  },
  {
    id: 1,
    name: 'init',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS strategies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          symbol TEXT NOT NULL,
          timeframe TEXT NOT NULL,
          family TEXT,
          risk_level INTEGER,
          document_json TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'user',
          archived INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS strategy_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          strategy_id TEXT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          document_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (strategy_id, version)
        );

        CREATE TABLE IF NOT EXISTS backtest_runs (
          id TEXT PRIMARY KEY,
          strategy_id TEXT,
          strategy_name TEXT NOT NULL,
          strategy_snapshot_json TEXT NOT NULL,
          symbol TEXT NOT NULL,
          timeframe TEXT NOT NULL,
          data_source TEXT NOT NULL,
          date_from INTEGER,
          date_to INTEGER,
          starting_cash REAL NOT NULL,
          fee_pct REAL NOT NULL DEFAULT 0,
          maker_fee_pct REAL NOT NULL DEFAULT 0,
          slippage_pct REAL NOT NULL DEFAULT 0,
          participation_rate REAL NOT NULL DEFAULT 0.25,
          execution_model TEXT NOT NULL DEFAULT 'conservative',
          risk_json TEXT NOT NULL DEFAULT '{}',
          assumptions_json TEXT NOT NULL DEFAULT '{}',
          metrics_json TEXT NOT NULL DEFAULT '{}',
          trade_count INTEGER NOT NULL DEFAULT 0,
          note TEXT,
          created_at INTEGER NOT NULL,
          finished_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS backtest_trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          qty REAL NOT NULL,
          entry_price REAL NOT NULL,
          exit_price REAL NOT NULL,
          gross_pnl REAL NOT NULL,
          entry_fee REAL NOT NULL,
          exit_fee REAL NOT NULL,
          total_fees REAL NOT NULL,
          net_pnl REAL NOT NULL,
          net_pnl_pct REAL NOT NULL,
          opened_at INTEGER,
          closed_at INTEGER,
          reason TEXT,
          rule_id TEXT,
          strategy_id TEXT
        );

        CREATE TABLE IF NOT EXISTS backtest_equity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          time INTEGER NOT NULL,
          equity REAL NOT NULL,
          price REAL
        );

        CREATE TABLE IF NOT EXISTS paper_sessions (
          id TEXT PRIMARY KEY,
          symbol TEXT NOT NULL,
          timeframe TEXT NOT NULL,
          starting_cash REAL NOT NULL,
          cash REAL NOT NULL,
          equity REAL,
          status TEXT NOT NULL DEFAULT 'running',
          settings_json TEXT NOT NULL DEFAULT '{}',
          started_at INTEGER NOT NULL,
          ended_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS paper_orders (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          type TEXT NOT NULL,
          qty REAL NOT NULL,
          filled_qty REAL NOT NULL DEFAULT 0,
          price REAL,
          stop_price REAL,
          status TEXT NOT NULL,
          reason TEXT,
          rule_id TEXT,
          strategy_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS paper_trades (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
          seq INTEGER,
          symbol TEXT NOT NULL,
          qty REAL NOT NULL,
          entry_price REAL NOT NULL,
          exit_price REAL NOT NULL,
          gross_pnl REAL NOT NULL DEFAULT 0,
          entry_fee REAL NOT NULL DEFAULT 0,
          exit_fee REAL NOT NULL DEFAULT 0,
          total_fees REAL NOT NULL DEFAULT 0,
          net_pnl REAL NOT NULL DEFAULT 0,
          net_pnl_pct REAL NOT NULL DEFAULT 0,
          opened_at INTEGER,
          closed_at INTEGER,
          reason TEXT,
          rule_id TEXT,
          strategy_id TEXT
        );

        CREATE TABLE IF NOT EXISTS paper_equity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES paper_sessions(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          time INTEGER NOT NULL,
          equity REAL NOT NULL,
          cash REAL
        );

        CREATE TABLE IF NOT EXISTS live_sessions (
          id TEXT PRIMARY KEY,
          environment TEXT NOT NULL DEFAULT 'paper',
          account_id TEXT,
          symbol TEXT,
          status TEXT NOT NULL DEFAULT 'stopped',
          reconciliation_state TEXT NOT NULL DEFAULT 'ok',
          kill_switch INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER,
          ended_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS live_orders (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          client_order_id TEXT,
          exchange_order_id TEXT,
          intent_id TEXT,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          type TEXT NOT NULL,
          qty REAL NOT NULL,
          price REAL,
          status TEXT NOT NULL,
          submitted_at INTEGER,
          updated_at INTEGER,
          raw_json TEXT
        );

        CREATE TABLE IF NOT EXISTS live_fills (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          order_id TEXT,
          exchange_trade_id TEXT,
          symbol TEXT NOT NULL,
          qty REAL NOT NULL,
          price REAL NOT NULL,
          fee REAL NOT NULL DEFAULT 0,
          fee_asset TEXT,
          filled_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS live_trades (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
          symbol TEXT NOT NULL,
          qty REAL NOT NULL,
          entry_price REAL NOT NULL,
          exit_price REAL NOT NULL,
          gross_pnl REAL NOT NULL DEFAULT 0,
          total_fees REAL NOT NULL DEFAULT 0,
          net_pnl REAL NOT NULL DEFAULT 0,
          opened_at INTEGER,
          closed_at INTEGER,
          reason TEXT,
          rule_id TEXT,
          strategy_id TEXT
        );

        CREATE TABLE IF NOT EXISTS exchange_accounts (
          id TEXT PRIMARY KEY,
          environment TEXT NOT NULL,
          api_key_masked TEXT NOT NULL,
          api_key_fingerprint TEXT,
          permissions_json TEXT NOT NULL DEFAULT '{}',
          account_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'disconnected',
          connected_at INTEGER,
          last_sync_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- append-only: the application never updates or deletes these rows
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          session_id TEXT,
          event TEXT NOT NULL,
          ref TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS risk_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          session_id TEXT,
          rule TEXT NOT NULL,
          level TEXT NOT NULL,
          message TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_strategy_versions ON strategy_versions (strategy_id, version);
        CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades (run_id, seq);
        CREATE INDEX IF NOT EXISTS idx_backtest_equity_run ON backtest_equity (run_id, seq);
        CREATE INDEX IF NOT EXISTS idx_backtest_created ON backtest_runs (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_paper_trades_session ON paper_trades (session_id, seq);
        CREATE INDEX IF NOT EXISTS idx_paper_equity_session ON paper_equity (session_id, seq);
        CREATE INDEX IF NOT EXISTS idx_live_orders_session ON live_orders (session_id, submitted_at);
        CREATE INDEX IF NOT EXISTS idx_live_fills_session ON live_fills (session_id, filled_at);
        CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
      `);
    },
  },
];

export const TABLE_NAMES = [
  'strategies', 'strategy_versions', 'backtest_runs', 'backtest_trades', 'backtest_equity',
  'paper_sessions', 'paper_orders', 'paper_trades', 'paper_equity',
  'live_sessions', 'live_orders', 'live_fills', 'live_trades',
  'exchange_accounts', 'app_settings', 'audit_log', 'risk_events',
];