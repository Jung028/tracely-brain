// Public barrel export for the Company Brain module.
//
// This is the surface a future module (03, Investigation Agent — not part
// of this plan) imports from. It re-exports the write-path
// (entities.ts, relationships.ts) and read-path (query.ts) functions, plus
// the domain types (types.ts) and errors (errors.ts), and adds the NFR-10
// audit-hook scaffold.
//
// Hook wiring approach — barrel-level wrapper, not internal edits:
// entities.ts/relationships.ts/query.ts are left completely untouched.
// Instead, this file re-exports thin wrapper functions with the same names
// and signatures that call straight through to the underlying
// implementation and then fire the appropriate hook. This was chosen over
// adding hook calls inside the three existing modules because:
//   - It guarantees zero risk to the 44 existing tests in tests/, which
//     import directly from entities.ts/relationships.ts/query.ts and never
//     go through this barrel — those modules' behavior is provably
//     unchanged.
//   - It keeps the write-path/read-path modules focused purely on their
//     documented algorithms (versioning/corroboration, recursive traversal,
//     etc.), with no cross-cutting concern mixed in.
//   - A future module 03 is expected to import from this barrel (per the
//     task brief), so wrapping here still guarantees onRead/onWrite fires
//     for every call made through the actual public surface.
//
// Hooks fire once, after the wrapped call resolves successfully (i.e. the
// operation actually happened). If the underlying call throws, the hook
// does not fire and the error propagates unchanged — this keeps the seam
// simple (no try/catch/rethrow semantics to get wrong) and matches "audit
// what happened", not "audit what was attempted".
//
// isValidRelationshipType is a pure in-memory vocabulary check — it never
// touches the database — so it is re-exported directly, unwrapped, rather
// than firing a spurious onRead for a non-read operation.

import * as entitiesModule from "./entities";
import * as relationshipsModule from "./relationships";
import * as queryModule from "./query";

export * from "./types";
export * from "./errors";

export type {
  RecordRelationshipObservationInput,
  RecordRelationshipObservationResult,
  SupersedeRelationshipInput,
} from "./relationships";

export type {
  QueryRelationshipsFilter,
  TraverseParams,
  TraverseResult,
} from "./query";

// ---------------------------------------------------------------------------
// Audit hook scaffold (NFR-10)
//
// This is a seam only, per the user's explicit decision: no logging
// backend, no storage, no retention policy. Two callback types (onRead,
// onWrite) is the entire scope — this is deliberately not a generic
// middleware/interceptor framework.
// ---------------------------------------------------------------------------

export interface BrainHookEvent {
  operation: string;
  actor?: string;
  timestamp: Date;
}

export interface BrainHooks {
  onRead?: (event: BrainHookEvent) => void;
  onWrite?: (event: BrainHookEvent) => void;
}

const noop = () => {};

let activeHooks: Required<BrainHooks> = {
  onRead: noop,
  onWrite: noop,
};

/**
 * Register audit hooks for the Company Brain. Both callbacks are optional;
 * an omitted callback falls back to a no-op. Calling this again replaces
 * the previously registered hooks (module-level, process-wide) rather than
 * merging with them.
 */
export function configureBrainHooks(hooks: BrainHooks): void {
  activeHooks = {
    onRead: hooks.onRead ?? noop,
    onWrite: hooks.onWrite ?? noop,
  };
}

function emitRead(operation: string): void {
  activeHooks.onRead({ operation, timestamp: new Date() });
}

function emitWrite(operation: string): void {
  activeHooks.onWrite({ operation, timestamp: new Date() });
}

// ---------------------------------------------------------------------------
// Write path — entities.ts, relationships.ts (onWrite)
// ---------------------------------------------------------------------------

export async function upsertEntity(
  input: Parameters<typeof entitiesModule.upsertEntity>[0],
): ReturnType<typeof entitiesModule.upsertEntity> {
  const result = await entitiesModule.upsertEntity(input);
  emitWrite("upsertEntity");
  return result;
}

export async function recordRelationshipObservation(
  obs: Parameters<typeof relationshipsModule.recordRelationshipObservation>[0],
): ReturnType<typeof relationshipsModule.recordRelationshipObservation> {
  const result = await relationshipsModule.recordRelationshipObservation(obs);
  emitWrite("recordRelationshipObservation");
  return result;
}

export async function supersedeRelationship(
  input: Parameters<typeof relationshipsModule.supersedeRelationship>[0],
): ReturnType<typeof relationshipsModule.supersedeRelationship> {
  const result = await relationshipsModule.supersedeRelationship(input);
  emitWrite("supersedeRelationship");
  return result;
}

export async function updateRelationshipConfidence(
  id: string,
  confidence: number,
  reason: string,
): ReturnType<typeof relationshipsModule.updateRelationshipConfidence> {
  const result = await relationshipsModule.updateRelationshipConfidence(
    id,
    confidence,
    reason,
  );
  emitWrite("updateRelationshipConfidence");
  return result;
}

// ---------------------------------------------------------------------------
// Read path — entities.ts, query.ts (onRead)
// ---------------------------------------------------------------------------

export async function getEntity(
  id: Parameters<typeof entitiesModule.getEntity>[0],
): ReturnType<typeof entitiesModule.getEntity> {
  const result = await entitiesModule.getEntity(id);
  emitRead("getEntity");
  return result;
}

export async function findEntities(
  filter: Parameters<typeof entitiesModule.findEntities>[0],
): ReturnType<typeof entitiesModule.findEntities> {
  const result = await entitiesModule.findEntities(filter);
  emitRead("findEntities");
  return result;
}

export async function queryRelationships(
  filter: Parameters<typeof queryModule.queryRelationships>[0],
): ReturnType<typeof queryModule.queryRelationships> {
  const result = await queryModule.queryRelationships(filter);
  emitRead("queryRelationships");
  return result;
}

export async function getRelationshipHistory(
  fromEntityId: string,
  toEntityId: string,
  relationshipType: Parameters<typeof queryModule.getRelationshipHistory>[2],
): ReturnType<typeof queryModule.getRelationshipHistory> {
  const result = await queryModule.getRelationshipHistory(
    fromEntityId,
    toEntityId,
    relationshipType,
  );
  emitRead("getRelationshipHistory");
  return result;
}

export async function getProvenance(
  relationshipId: string,
): ReturnType<typeof queryModule.getProvenance> {
  const result = await queryModule.getProvenance(relationshipId);
  emitRead("getProvenance");
  return result;
}

export async function traverse(
  params: Parameters<typeof queryModule.traverse>[0],
): ReturnType<typeof queryModule.traverse> {
  const result = await queryModule.traverse(params);
  emitRead("traverse");
  return result;
}

// Pure vocabulary check — no database access, so no onRead hook. See file
// header for rationale.
export const isValidRelationshipType = queryModule.isValidRelationshipType;
