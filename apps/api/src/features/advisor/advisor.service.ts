// Advisor service façade (design §Architecture, structure.md service-layer
// separation). This is a PURE re-export barrel: it adds NO logic and imports
// NO HTTP-shape types. Its sole purpose is to give the route handlers
// (Tasks 24–26) one-line imports for the streaming orchestration, persistence,
// and query helpers:
//
//   import { prepare, runStreaming, persistExchange, insertConversation }
//     from '../advisor.service';

export * from './streaming';
export * from './persistence';
export * from './advisor.query';
