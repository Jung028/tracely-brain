// Shared vocabulary and row-shape types for the Company Brain.
//
// `Domain` and `RelationshipType` are controlled vocabularies (see
// specs/01-company-brain.md FR-2/FR-3, NFR-16) — the literal values here
// must match the Postgres CHECK constraints in migrations/0001_init.sql
// exactly. New values require an explicit schema review, never a runtime
// addition.

export const Domain = [
  "Code",
  "Runtime",
  "Data",
  "Business",
  "Organization",
  "Operational Knowledge",
] as const;

export type Domain = (typeof Domain)[number];

export const RelationshipType = [
  "CONTAINS",
  "CALLS",
  "DEPENDS_ON",
  "READS",
  "WRITES",
  "PUBLISHES",
  "CONSUMES",
  "TRIGGERS",
  "TRANSITIONS_TO",
  "IMPLEMENTS",
  "STORED_IN",
  "OWNED_BY",
  "PART_OF",
  "CAUSED",
  "RESOLVED_BY",
  "RELATED_TO",
  "CHANGED_BY",
  "OBSERVED_IN",
] as const;

export type RelationshipType = (typeof RelationshipType)[number];

/** Maps to the `entities` table. */
export interface Entity {
  id: string;
  domain: Domain;
  entityType: string;
  name: string;
  sourceSystem: string;
  sourceRef: string;
  attributes: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Maps to the `relationships` table. */
export interface Relationship {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relationshipType: RelationshipType;
  attributes: Record<string, unknown>;
  confidence: number | null;
  status: "current" | "historical";
  validFrom: Date;
  validUntil: Date | null;
  supersededBy: string | null;
  createdAt: Date;
}

/** Maps to the `relationship_provenance` table. */
export interface Provenance {
  id: string;
  relationshipId: string;
  sourceSystem: string;
  sourceRef: string;
  confidence: number | null;
  observedAt: Date;
  notes: string | null;
  createdAt: Date;
}
