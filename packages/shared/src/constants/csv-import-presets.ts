import type { CsvPreset, Mapping } from '../schemas/csv-import';

/**
 * In-repo broker presets (REQ-3). NOT database rows — pure config shipped with
 * the app. Each preset pre-fills a {@link CsvPreset} mapping (Tradr field → CSV
 * column) that a user can adopt and then adjust (REQ-3.4). Adding a preset =
 * a config entry here + a committed documented-format sample fixture under
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
 * Headers are sourced from documented-format samples (committed fixtures), never
 * invented:
 *   - interactive-brokers: IBKR Trades Flex Query field codes (Symbol,
 *     Description, UnderlyingSymbol, Strike, Expiry, Put/Call, Multiplier,
 *     AssetClass, Buy/Sell, Open/CloseIndicator, Quantity, TradePrice,
 *     IBCommission, DateTime, Notes/Codes). The preset maps Multiplier and
 *     Notes/Codes; the composed contract columns (UnderlyingSymbol, Strike,
 *     Expiry, Put/Call) sit in the sample unmapped so a user can switch the
 *     contract form in the mapper. A stock row's Multiplier `1` is an inferred
 *     vendor value (the Trades Flex fields page documents no stock multiplier);
 *     it drives no assertion, since the multiplier check is option-only.
 *   - tradezella: TradeZella generic CSV upload template
 *     (Date, Time, Symbol, Buy/Sell, Quantity, Price, Spread, Expiration,
 *     Strike, Call/Put, Commission, Fees).
 *   - tradervue: Tradervue generic import format
 *     (Time, Date, Quantity, Symbol, Side, Price, Option, Commission, …).
 *   - generic-execution: Tradr's own canonical one-row-per-fill template.
 *   - tastytrade: tastytrade transactions CSV, per the Help Center article
 *     "Export Transaction Data to a Spreadsheet (CSV File)" (Date, Type, Action,
 *     Symbol, Instrument Type, Description, Value, Quantity, Average Price,
 *     Commissions, Fees, Multiplier, Underlying Symbol, Expiration Date, Strike
 *     Price, Call or Put). Recorded omission (REQ-1.5, D5): the fixture carries
 *     no option lifecycle row, because the documented format names no lifecycle
 *     value and an invented one would breach the documented-format rule; a real
 *     expiration/assignment row has a Type other than `Trade`, so the row filter
 *     skips and counts it rather than importing it.
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
      contractForm: 'occ-symbol',
      // Flex signs Quantity (negative = sold) and IBCommission (negative =
      // paid); the magnitude is stored either way (REQ-3.1).
      signedQuantity: true,
      signedFees: true,
      columns: {
        symbol: 'Symbol',
        assetType: 'AssetClass',
        action: 'Buy/Sell',
        quantity: 'Quantity',
        price: 'TradePrice',
        filledAt: 'DateTime',
        fees: 'IBCommission',
        multiplier: 'Multiplier',
        eventCode: 'Notes/Codes',
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
      contractForm: 'composed',
      expiryFormat: 'dd-mon-yy',
      // The `Spread` column carries the asset type; `Single` is TradeZella's
      // label for a single-leg option (REQ-3.4). `Stock` is canonical stock;
      // Future/Forex/Crypto stay unmatched (unrepresentable). The synonym lives
      // in `mapping.transforms`, the path `applyPreset` forwards.
      transforms: { assetType: { Single: 'option' } },
      columns: {
        symbol: 'Symbol',
        assetType: 'Spread',
        action: 'Buy/Sell',
        quantity: 'Quantity',
        price: 'Price',
        filledAt: 'Date',
        fees: 'Commission',
        expiry: 'Expiration',
        strike: 'Strike',
        right: 'Call/Put',
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
      contractForm: 'descriptor',
      // Tradervue's `Option` column carries a per-row option descriptor
      // (e.g. `JAN 12 125 CALL`) that supplies the asset type, so `assetType`
      // stays unmapped by design (REQ-2.8).
      columns: {
        symbol: 'Symbol',
        action: 'Side',
        quantity: 'Quantity',
        price: 'Price',
        filledAt: 'Date',
        fees: 'Commission',
        descriptor: 'Option',
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
      contractForm: 'occ-symbol',
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
  {
    id: 'tastytrade',
    label: 'tastytrade (transactions CSV)',
    rowShape: 'execution',
    dateFormat: 'iso-datetime',
    numberFormat: 'us',
    mapping: {
      rowShape: 'execution',
      contractForm: 'occ-symbol',
      signedFees: true,
      signedPrice: true,
      optionPriceIsContractValue: true,
      rowFilter: { column: 'Type', values: ['Trade'] },
      extraFeeColumns: ['Fees'],
      transforms: {
        assetType: { Equity: 'stock', 'Equity Option': 'option' },
        action: {
          BUY_TO_OPEN: 'buy',
          BUY_TO_CLOSE: 'buy',
          SELL_TO_OPEN: 'sell',
          SELL_TO_CLOSE: 'sell',
        },
      },
      positionEffect: {
        BUY_TO_OPEN: 'entry',
        SELL_TO_OPEN: 'entry',
        BUY_TO_CLOSE: 'exit',
        SELL_TO_CLOSE: 'exit',
      },
      columns: {
        symbol: 'Symbol',
        assetType: 'Instrument Type',
        action: 'Action',
        quantity: 'Quantity',
        price: 'Average Price',
        filledAt: 'Date',
        fees: 'Commissions',
        multiplier: 'Multiplier',
      },
    },
  },
];

/**
 * Every CSV column a mapping reads (design C2): the values of `columns`, then
 * `extraFeeColumns`, then `rowFilter.column`, deduplicated, in that order. The
 * grounding check and the header suggestion both resolve a mapping's columns
 * through this one helper (REQ-1.2 / 2.3 / 2.4).
 */
export function mappingColumns(mapping: Mapping): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (column: string) => {
    if (!seen.has(column)) {
      seen.add(column);
      result.push(column);
    }
  };
  for (const column of Object.values(mapping.columns)) add(column);
  for (const column of mapping.extraFeeColumns ?? []) add(column);
  if (mapping.rowFilter) add(mapping.rowFilter.column);
  return result;
}
