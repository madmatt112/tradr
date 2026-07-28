import type { CsvPreset } from '../schemas/csv-import';

/**
 * In-repo broker presets (REQ-3). NOT database rows — pure config shipped with
 * the app. Each preset pre-fills a {@link CsvPreset} mapping (Tradr field → CSV
 * column) that a user can adopt and then adjust (REQ-3.4). Adding a preset =
 * a config entry here + a committed real-export sample fixture under
 * `__fixtures__/csv-import-samples/` + a test that resolves the mapping against
 * it and asserts the declared row shape (REQ-3.5). No DB migration, no engine
 * change.
 *
 * Row shape: ALL shipped presets are `execution` — the common journaling-tool
 * generic exports (TradeZella, Tradervue) and broker statements (IBKR Flex) are
 * one-row-per-fill, not round-trip (deferral d-b394aea7). `round-trip` is
 * reachable only via the manual row-shape selector (Task 21); no preset ships
 * with that shape.
 *
 * Headers are sourced from real export samples (committed fixtures), never
 * invented:
 *   - interactive-brokers: IBKR Trades Flex Query field codes
 *     (Symbol, DateTime, Buy/Sell, Quantity, TradePrice, IBCommission, AssetClass).
 *   - tradezella: TradeZella generic CSV upload template
 *     (Date, Time, Symbol, Buy/Sell, Quantity, Price, Spread, …, Commission, Fees).
 *   - tradervue: Tradervue generic import format
 *     (Time, Date, Quantity, Symbol, Side, Price, Option, Commission, …).
 *   - generic-execution: Tradr's own canonical one-row-per-fill template.
 */
export const CSV_IMPORT_PRESETS: CsvPreset[] = [
  {
    id: 'generic-manual',
    label: 'Generic / manual mapping',
    rowShape: 'execution',
    dateFormat: 'iso',
    numberFormat: 'us',
    mapping: {
      rowShape: 'execution',
      // No pre-filled mapping — the user maps every column by hand (REQ-3.2).
      columns: {},
    },
  },
  {
    id: 'interactive-brokers',
    label: 'Interactive Brokers (Flex Query — Trades)',
    rowShape: 'execution',
    dateFormat: 'iso-datetime',
    numberFormat: 'us',
    mapping: {
      rowShape: 'execution',
      columns: {
        symbol: 'Symbol',
        assetType: 'AssetClass',
        action: 'Buy/Sell',
        quantity: 'Quantity',
        price: 'TradePrice',
        filledAt: 'DateTime',
        fees: 'IBCommission',
      },
    },
  },
  {
    id: 'tradezella',
    label: 'TradeZella (generic CSV)',
    rowShape: 'execution',
    dateFormat: 'us',
    numberFormat: 'us',
    mapping: {
      rowShape: 'execution',
      columns: {
        symbol: 'Symbol',
        assetType: 'Spread',
        action: 'Buy/Sell',
        quantity: 'Quantity',
        price: 'Price',
        filledAt: 'Date',
        fees: 'Commission',
      },
    },
  },
  {
    id: 'tradervue',
    label: 'Tradervue (generic import)',
    rowShape: 'execution',
    dateFormat: 'us',
    numberFormat: 'us',
    mapping: {
      rowShape: 'execution',
      // Tradervue's generic format has no plain asset-type column (the `Option`
      // column only carries an option descriptor when present), so `assetType`
      // is left unmapped for the user to complete (REQ-3.4).
      columns: {
        symbol: 'Symbol',
        action: 'Side',
        quantity: 'Quantity',
        price: 'Price',
        filledAt: 'Date',
        fees: 'Commission',
      },
    },
  },
  {
    id: 'generic-execution',
    label: 'Generic execution (one row per fill)',
    rowShape: 'execution',
    dateFormat: 'iso-datetime',
    numberFormat: 'us',
    mapping: {
      rowShape: 'execution',
      columns: {
        symbol: 'Symbol',
        assetType: 'AssetType',
        action: 'Action',
        quantity: 'Quantity',
        price: 'Price',
        filledAt: 'FilledAt',
        fees: 'Fees',
      },
    },
  },
];
