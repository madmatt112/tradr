// The tool registry (design §Component 1, REQ-1.1, REQ-1.2).
//
// Maps each tool's `name` to its `ToolDefinition`. The dispatcher (task 5)
// looks up `toolRegistry[call.name]`; `buildDeclarations` (task 6) iterates it
// to offer the subset whose `requires` is currently satisfied.
//
// Empty for now; individual tools are registered by their implementation tasks.

import { marketDataTools } from './market-data';
import { tradeDataTools } from './trade-data';
import type { ToolDefinition } from './types';

/** Frozen lookup of every available tool, keyed by `ToolDefinition.name`. */
export const toolRegistry: Readonly<Record<string, ToolDefinition>> = Object.freeze(
  Object.fromEntries([...marketDataTools, ...tradeDataTools].map((tool) => [tool.name, tool])),
);
