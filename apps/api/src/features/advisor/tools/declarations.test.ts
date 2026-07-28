import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildDeclarations, deriveInputJsonSchema } from './declarations';
import type { ToolDefinition, ToolResult } from './types';

// The registry is empty until individual tool tasks land, so we exercise schema
// derivation with local flat-object fixtures that obey the types.ts HARD
// CONSTRAINT (scalar fields only: string / number / boolean / enum).

const okResult: ToolResult = { status: 'ok', content: null };

function fixture(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'market_data_stock_quote',
    description: 'Get a stock quote.',
    category: 'market-data',
    requires: 'unusual-whales-key',
    inputSchema: z.object({
      symbol: z.string().describe('Ticker symbol'),
      limit: z.number().int().optional(),
      side: z.enum(['call', 'put']).optional(),
    }),
    handler: async () => okResult,
    ...overrides,
  };
}

const ALLOWED_TOP_LEVEL = ['additionalProperties', 'properties', 'required', 'type'];

describe('deriveInputJsonSchema (REQ-1.6)', () => {
  it('emits no $ref / $defs for a flat object schema', () => {
    const json = JSON.stringify(deriveInputJsonSchema(fixture()));
    expect(json).not.toContain('$ref');
    expect(json).not.toContain('$defs');
    expect(json).not.toContain('definitions');
  });

  it('strips the top-level $schema dialect key', () => {
    const schema = deriveInputJsonSchema(fixture());
    expect('$schema' in schema).toBe(false);
  });

  it('exposes exactly the provider-accepted top-level key set', () => {
    const schema = deriveInputJsonSchema(fixture());
    // symbol is required → `required` present.
    expect(Object.keys(schema).sort()).toEqual(ALLOWED_TOP_LEVEL);
  });

  it('keeps additionalProperties:false on the object', () => {
    const schema = deriveInputJsonSchema(fixture());
    expect(schema.additionalProperties).toBe(false);
  });

  it('is a valid draft-07 object schema (type + properties)', () => {
    const schema = deriveInputJsonSchema(fixture()) as {
      type: string;
      properties: Record<string, { type: string }>;
    };
    expect(schema.type).toBe('object');
    expect(schema.properties.symbol.type).toBe('string');
    // enum maps to a string with an enum list (draft-07), not a $ref.
    expect(schema.properties.side).toEqual({ type: 'string', enum: ['call', 'put'] });
    // z.number().int() → integer.
    expect(schema.properties.limit.type).toBe('integer');
  });

  it('omits `required` entirely when every field is optional', () => {
    const allOptional = fixture({
      inputSchema: z.object({ foo: z.string().optional(), bar: z.boolean().optional() }),
    });
    const schema = deriveInputJsonSchema(allOptional);
    expect('required' in schema).toBe(false);
    expect(Object.keys(schema).sort()).toEqual(['additionalProperties', 'properties', 'type']);
  });

  it('lists only non-optional fields in `required`', () => {
    const schema = deriveInputJsonSchema(fixture()) as { required: string[] };
    // symbol is required; limit + side are optional.
    expect(schema.required).toEqual(['symbol']);
  });
});

describe('declaration round-trips through both provider shapes (REQ-1.6, non-strict)', () => {
  const def = fixture();
  const inputJsonSchema = deriveInputJsonSchema(def);

  it('produces an Anthropic input_schema with optional fields preserved (not forced required)', () => {
    const anthropicTool = {
      name: def.name,
      description: def.description,
      input_schema: inputJsonSchema,
    };
    const params = anthropicTool.input_schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(params.properties).sort()).toEqual(['limit', 'side', 'symbol']);
    // Optional fields exist as properties but are NOT in required.
    expect(params.required).not.toContain('limit');
    expect(params.required).not.toContain('side');
  });

  it('produces an OpenAI non-strict function.parameters (optional fields not forced required)', () => {
    const openaiTool = {
      type: 'function' as const,
      function: {
        name: def.name,
        description: def.description,
        // NON-STRICT: no `strict: true`, so optional fields stay optional.
        parameters: inputJsonSchema,
      },
    };
    const params = openaiTool.function.parameters as {
      type: string;
      required: string[];
      additionalProperties: boolean;
    };
    expect('strict' in openaiTool.function).toBe(false);
    expect(params.type).toBe('object');
    // Non-strict OpenAI does NOT require every key in `required`.
    expect(params.required).toEqual(['symbol']);
    expect(params.additionalProperties).toBe(false);
  });
});

describe('buildDeclarations filtering (REQ-1.3, REQ-13.1)', () => {
  it('returns [] when the model cannot use tools (toolUse=false → plain chat)', () => {
    expect(buildDeclarations({ toolUse: false }, true, true)).toEqual([]);
  });

  it('offers every tool when capable, consented, and the key is present', () => {
    const names = buildDeclarations({ toolUse: true }, true, true)
      .map((d) => d.name)
      .sort();
    expect(names).toEqual([
      'market_data_options_chain',
      'market_data_options_flow',
      'market_data_stock_quote',
      'trade_data_account_summary',
      'trade_data_open_positions',
      'trade_data_pnl_summary',
      'trade_data_recent_closed',
    ]);
  });

  it('withholds UW-key tools when no key is present, keeping consented trade-data tools (REQ-1.3 hint)', () => {
    const names = buildDeclarations({ toolUse: true }, true, false)
      .map((d) => d.name)
      .sort();
    expect(names).toEqual([
      'trade_data_account_summary',
      'trade_data_open_positions',
      'trade_data_pnl_summary',
      'trade_data_recent_closed',
    ]);
  });

  it('withholds trade-data tools when consent is absent, keeping UW-key tools', () => {
    const names = buildDeclarations({ toolUse: true }, false, true)
      .map((d) => d.name)
      .sort();
    expect(names).toEqual([
      'market_data_options_chain',
      'market_data_options_flow',
      'market_data_stock_quote',
    ]);
  });

  it('offers nothing when neither consent nor key is present', () => {
    expect(buildDeclarations({ toolUse: true }, false, false)).toEqual([]);
  });
});
