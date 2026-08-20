// Domain-specific errors for the Company Brain, so callers can distinguish
// "not found" / "invalid vocabulary" from generic thrown errors.

export class InvalidRelationshipTypeError extends Error {
  constructor(value: string) {
    super(`Invalid relationship type: ${JSON.stringify(value)}`);
    this.name = "InvalidRelationshipTypeError";
  }
}

export class EntityNotFoundError extends Error {
  constructor(id: string) {
    super(`Entity not found: ${id}`);
    this.name = "EntityNotFoundError";
  }
}

export class RelationshipNotFoundError extends Error {
  constructor(id: string) {
    super(`Relationship not found: ${id}`);
    this.name = "RelationshipNotFoundError";
  }
}
