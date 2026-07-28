import { z } from 'zod';

export const SymbolSearchItemSchema = z.object({
  ticker: z.string(),
  name: z.string(),
  exchange: z.string(),
});
export const SymbolSearchResponseSchema = z.object({
  results: z.array(SymbolSearchItemSchema),
});

// Search-query (`q`) + quote-symbol sanitizers. Charset is [A-Z.-]: real
// NYSE/NASDAQ tickers use a HYPHEN for class/preferred/unit shares (BRK-B, BF-A,
// KCAC-UN, ICR-PA) and NEVER a dot — verified against the live SEC file (the only
// non-[A-Z] character across the whole file is '-'). This DEVIATES from REQ-3.4's
// literal "[A-Z.]", which is wrong against the data source REQ-2 names. Hyphen is
// placed last in the class (a literal, not a range) and is not a LIKE
// metacharacter, so prefix-injection safety is preserved; the '.' is kept but is
// vestigial (never matches an SEC ticker).
export const SymbolQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z.-]{0,16}$/)
    .default(''),
});
export const QuoteSymbolParamSchema = z.object({
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z.-]{1,16}$/),
});

// Quote response — envelope mirrors the options-chain { configured } union.
export const StockQuoteSchema = z.object({
  configured: z.literal(true),
  symbol: z.string(),
  lastPrice: z.string(), // decimal string → feeds calculator entryPrice
  change: z.string().nullable(), // null for API Ninjas (no day-change field)
  delayed: z.literal(true),
});
export const StockQuoteResponseSchema = z.union([
  z.object({ configured: z.literal(false) }),
  StockQuoteSchema,
]);

export const StockQuoteConfigSchema = z.object({ stockQuoteConfigured: z.boolean() });

export type SymbolSearchItem = z.infer<typeof SymbolSearchItemSchema>;
export type SymbolSearchResponse = z.infer<typeof SymbolSearchResponseSchema>;
export type StockQuote = z.infer<typeof StockQuoteSchema>;
export type StockQuoteResponse = z.infer<typeof StockQuoteResponseSchema>;
