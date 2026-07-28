export const SUPPORTED_CURRENCIES = [
  { code: 'USD', name: 'US Dollar', minorUnits: 2 },
  { code: 'EUR', name: 'Euro', minorUnits: 2 },
  { code: 'GBP', name: 'British Pound', minorUnits: 2 },
  { code: 'CAD', name: 'Canadian Dollar', minorUnits: 2 },
  { code: 'AUD', name: 'Australian Dollar', minorUnits: 2 },
  { code: 'JPY', name: 'Japanese Yen', minorUnits: 0 },
  { code: 'CHF', name: 'Swiss Franc', minorUnits: 2 },
  { code: 'HKD', name: 'Hong Kong Dollar', minorUnits: 2 },
  { code: 'SGD', name: 'Singapore Dollar', minorUnits: 2 },
  { code: 'NZD', name: 'New Zealand Dollar', minorUnits: 2 },
  { code: 'SEK', name: 'Swedish Krona', minorUnits: 2 },
  { code: 'NOK', name: 'Norwegian Krone', minorUnits: 2 },
  { code: 'DKK', name: 'Danish Krone', minorUnits: 2 },
  { code: 'MXN', name: 'Mexican Peso', minorUnits: 2 },
  { code: 'BRL', name: 'Brazilian Real', minorUnits: 2 },
  { code: 'INR', name: 'Indian Rupee', minorUnits: 2 },
  { code: 'KRW', name: 'South Korean Won', minorUnits: 0 },
  { code: 'TWD', name: 'New Taiwan Dollar', minorUnits: 2 },
  { code: 'ZAR', name: 'South African Rand', minorUnits: 2 },
] as const;

export const CURRENCY_CODES = SUPPORTED_CURRENCIES.map((c) => c.code);

export function getCurrencyMinorUnits(code: string): number {
  const currency = SUPPORTED_CURRENCIES.find((c) => c.code === code);
  if (!currency) {
    throw new Error(`Unsupported currency code: ${code}`);
  }
  return currency.minorUnits;
}
