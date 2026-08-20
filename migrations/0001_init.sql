CREATE TABLE IF NOT EXISTS schema_migrations (
  id          text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain         text NOT NULL CHECK (domain IN (
                    'Code','Runtime','Data','Business','Organization','Operational Knowledge'
                  )),
  entity_type    text NOT NULL,        -- free text: 'Repository','Service','Table','Class',
                                        -- 'Method','Event','Scheduler', etc. NOT controlled
                                        -- vocabulary — FR-3 only restricts relationship types.
  name           text NOT NULL,
  source_system  text NOT NULL,        -- 'github' | 'postgres' | 'datadog' | 'pagerduty' | 'slack' | 'manual'
  source_ref     text NOT NULL,        -- FR-7 back-reference, e.g. 'github:acme/repo@<sha>:path#Class'
  attributes     jsonb NOT NULL DEFAULT '{}',  -- small derived facts only, never full source content
                                                -- (NFR-12). No byte-size CHECK — a numeric limit would
                                                -- be an invented number; enforced by review in module 02.
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, source_ref)
);
CREATE INDEX entities_domain_idx ON entities (domain);
CREATE INDEX entities_entity_type_idx ON entities (entity_type);

CREATE TABLE relationships (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity_id     uuid NOT NULL REFERENCES entities(id),
  to_entity_id       uuid NOT NULL REFERENCES entities(id),
  relationship_type  text NOT NULL CHECK (relationship_type IN (
                        'CONTAINS','CALLS','DEPENDS_ON','READS','WRITES','PUBLISHES','CONSUMES',
                        'TRIGGERS','TRANSITIONS_TO','IMPLEMENTS','STORED_IN','OWNED_BY','PART_OF',
                        'CAUSED','RESOLVED_BY','RELATED_TO','CHANGED_BY','OBSERVED_IN'
                      )),
  attributes         jsonb NOT NULL DEFAULT '{}',  -- the VERSIONED payload — see Task 4 write-path
  confidence         numeric(3,2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
                                                    -- nullable, never defaulted (no invented numbers)
  status             text NOT NULL DEFAULT 'current' CHECK (status IN ('current','historical')),
  valid_from         timestamptz NOT NULL DEFAULT now(),
  valid_until        timestamptz,               -- NULL = still open/valid
  superseded_by      uuid REFERENCES relationships(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

-- Core versioning invariant: at most one CURRENT relationship per identity triple.
CREATE UNIQUE INDEX relationships_current_identity_uniq
  ON relationships (from_entity_id, to_entity_id, relationship_type)
  WHERE status = 'current';

CREATE INDEX relationships_from_idx     ON relationships (from_entity_id) WHERE status = 'current';
CREATE INDEX relationships_to_idx       ON relationships (to_entity_id)   WHERE status = 'current';
CREATE INDEX relationships_type_idx     ON relationships (relationship_type);
CREATE INDEX relationships_validity_idx ON relationships (valid_from, valid_until);

CREATE TABLE relationship_provenance (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id  uuid NOT NULL REFERENCES relationships(id),
  source_system    text NOT NULL,
  source_ref       text NOT NULL,     -- commit sha, Datadog query id, PagerDuty incident id, Slack permalink
  confidence       numeric(3,2) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  observed_at      timestamptz NOT NULL DEFAULT now(),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (relationship_id, source_system, source_ref)   -- idempotent re-ingestion guard
);
CREATE INDEX provenance_relationship_idx ON relationship_provenance (relationship_id);
