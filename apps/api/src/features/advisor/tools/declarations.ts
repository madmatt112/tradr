// Provider tool-declaration derivation & filtering (design §Component 1/2,
// REQ-1.3, REQ-1.6, REQ-13.1).
//
// `buildDeclarations` turns the registry into the subset of tools the model may
// be offered on a given provider round-trip: only tools whose `requires` is
// satisfied by the current snapshot AND only when the model supports tool use
// (`caps.toolUse === true`). `toolUse === false` → `[]` → plain chat (REQ-13.1).
//
// Each declaration's JSON Schema is derived from the tool's `inputSchema` (the
// same Zod object `safeParse`d on dispatch), so the declared and validated
// contracts cannot drift. We use the `zod-to-json-schema` package with the
// real `jsonSchema7` target and `$refStrategy:'none'`; because every tool's
// `inputSchema` is a flat object of scalar fields (HARD CONSTRAINT in types.ts),
// no `$ref`/`$defs` is emitted. The advisor uses NON-STRICT OpenAI
// function-calling, so a single draft-07 schema with optional fields is valid
// for both Anthropic `input_schema` and OpenAI `function.parameters` — we do
// NOT opt into OpenAI strict mode.

import { zodToJsonSchema } from 'zod-to-json-schema';

import { toolRegistry } from './registry';
import type { ToolDefinition } from './types';

/**
 * The current-snapshot model capabilities (design §Component 3 `caps`).
 * `toolUse` is per-model and immutable within a turn (read once at `prepare`).
 */
export interface ToolCaps {
  toolUse: boolean;
}

/**
 * A single tool declaration carried into the provider adapter. Mirrors the
 * `ProviderToolDecl` contract (design §Component 2): the adapter maps
 * `inputJsonSchema` onto Anthropic `input_schema` / OpenAI `function.parameters`.
 */
export interface ToolDeclaration {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
}

/**
 * Is `def.requires` satisfied by the current snapshot? (REQ-1.3, hint not the
 * boundary — dispatch re-checks authoritatively.)
 */
function isRequirementSatisfied(def: ToolDefinition, consent: boolean, hasUwKey: boolean): boolean {
  switch (def.requires) {
    case 'none':
      return true;
    case 'trade-data-consent':
      return consent;
    case 'unusual-whales-key':
      return hasUwKey;
    default:
      // Unknown requirement → fail closed (never offer the tool).
      return false;
  }
}

/**
 * Derive a flat draft-07 JSON Schema for a tool's `inputSchema`, stripped to the
 * provider-accepted top-level key set.
 *
 * `zod-to-json-schema` emits a top-level `$schema`
 * (`"http://json-schema.org/draft-07/schema#"`) which neither provider accepts
 * as a parameters-object key, so we delete it. We keep only `type`,
 * `properties`, `required` (when present — absent when all fields are optional),
 * and `additionalProperties` (kept `false` on objects). The flat-object
 * constraint (types.ts) guarantees no `$ref`/`$defs` is produced.
 */
export function deriveInputJsonSchema(def: ToolDefinition): Record<string, unknown> {
  const schema = zodToJsonSchema(def.inputSchema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  // Strip the top-level $schema dialect marker.
  delete schema.$schema;

  const flat: Record<string, unknown> = {
    type: schema.type,
    properties: schema.properties,
    additionalProperties: schema.additionalProperties,
  };
  // `required` is omitted by the converter when every field is optional.
  if ('required' in schema) {
    flat.required = schema.required;
  }
  return flat;
}

/**
 * Build the declarations offered to the model for the current round-trip.
 *
 * Returns tools whose `requires` is satisfied by the snapshot AND only when
 * `caps.toolUse === true`. `caps.toolUse === false` → `[]` (plain chat,
 * REQ-13.1). This is the offering HINT (REQ-1.3); the dispatcher re-checks
 * authoritatively (REQ-1.7/1.8).
 */
export function buildDeclarations(
  caps: ToolCaps,
  consent: boolean,
  hasUwKey: boolean,
): ToolDeclaration[] {
  if (!caps.toolUse) return [];

  const decls: ToolDeclaration[] = [];
  for (const def of Object.values(toolRegistry)) {
    if (!isRequirementSatisfied(def, consent, hasUwKey)) continue;
    decls.push({
      name: def.name,
      description: def.description,
      inputJsonSchema: deriveInputJsonSchema(def),
    });
  }
  return decls;
}
