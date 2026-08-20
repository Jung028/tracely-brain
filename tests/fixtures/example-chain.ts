// Seeds the spec's 12-hop / 13-entity example chain used to exercise
// `traverse`'s multi-hop graph walk in tests/query.test.ts:
//
//   Chargeback -> CB Center -> ICB Center -> WAIT_JUDGE -> Liability Assignment
//     -> Scheduler -> Service -> Repository -> Class -> Method
//     -> Database Table -> Event -> Downstream Service
//
// The spec (task-5-brief.md) names the entities in the chain but doesn't
// prescribe a domain/entityType/relationshipType for every hop — those are
// chosen here using judgment, constrained to the controlled vocabulary in
// src/brain/types.ts. Rationale per hop:
//   - Chargeback -> CB Center -> ICB Center -> WAIT_JUDGE: a chargeback case
//     moving through business-process states -> TRANSITIONS_TO.
//   - WAIT_JUDGE -> Liability Assignment: the pending-judgment state gets
//     resolved by a liability decision -> RESOLVED_BY.
//   - Liability Assignment -> Scheduler -> Service: the business decision
//     triggers a runtime job, which triggers a service -> TRIGGERS, TRIGGERS.
//   - Service -> Repository: the service's code lives in this repo -> PART_OF.
//   - Repository -> Class -> Method: containment in the codebase -> CONTAINS.
//   - Method -> Database Table: the method persists the decision -> WRITES.
//   - Database Table -> Event: a change on the table publishes a domain
//     event (e.g. outbox/CDC) -> PUBLISHES.
//   - Event -> Downstream Service: another service consumes that event
//     -> CONSUMES.

import { upsertEntity } from "../../src/brain/entities";
import { recordRelationshipObservation } from "../../src/brain/relationships";
import type { Entity, RelationshipType } from "../../src/brain/types";

export interface ExampleChainEntities {
  chargebackId: string;
  cbCenterId: string;
  icbCenterId: string;
  waitJudgeId: string;
  liabilityAssignmentId: string;
  schedulerId: string;
  serviceId: string;
  repositoryId: string;
  classId: string;
  methodId: string;
  databaseTableId: string;
  eventId: string;
  downstreamServiceId: string;
}

export async function seedExampleChain(): Promise<ExampleChainEntities> {
  const chargeback = await upsertEntity({
    domain: "Business",
    entityType: "Chargeback",
    name: "Chargeback",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:chargeback",
  });
  const cbCenter = await upsertEntity({
    domain: "Business",
    entityType: "State",
    name: "CB Center",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:cb-center",
  });
  const icbCenter = await upsertEntity({
    domain: "Business",
    entityType: "State",
    name: "ICB Center",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:icb-center",
  });
  const waitJudge = await upsertEntity({
    domain: "Business",
    entityType: "State",
    name: "WAIT_JUDGE",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:wait-judge",
  });
  const liabilityAssignment = await upsertEntity({
    domain: "Business",
    entityType: "Decision",
    name: "Liability Assignment",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:liability-assignment",
  });
  const scheduler = await upsertEntity({
    domain: "Runtime",
    entityType: "Scheduler",
    name: "Liability Scheduler",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:scheduler",
  });
  const service = await upsertEntity({
    domain: "Runtime",
    entityType: "Service",
    name: "Liability Service",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:service",
  });
  const repository = await upsertEntity({
    domain: "Code",
    entityType: "Repository",
    name: "liability-service",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:repository",
  });
  const klass = await upsertEntity({
    domain: "Code",
    entityType: "Class",
    name: "LiabilityAssignmentHandler",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:class",
  });
  const method = await upsertEntity({
    domain: "Code",
    entityType: "Method",
    name: "assignLiability()",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:method",
  });
  const databaseTable = await upsertEntity({
    domain: "Data",
    entityType: "Table",
    name: "liability_assignments",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:table",
  });
  const event = await upsertEntity({
    domain: "Data",
    entityType: "Event",
    name: "liability.assigned",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:event",
  });
  const downstreamService = await upsertEntity({
    domain: "Runtime",
    entityType: "Service",
    name: "Notification Service",
    sourceSystem: "manual",
    sourceRef: "fixture:chain:downstream-service",
  });

  async function hop(
    from: Entity,
    to: Entity,
    relationshipType: RelationshipType,
    sourceRef: string,
  ): Promise<void> {
    await recordRelationshipObservation({
      fromEntityId: from.id,
      toEntityId: to.id,
      relationshipType,
      sourceSystem: "manual",
      sourceRef,
    });
  }

  await hop(chargeback, cbCenter, "TRANSITIONS_TO", "fixture:chain:hop:1");
  await hop(cbCenter, icbCenter, "TRANSITIONS_TO", "fixture:chain:hop:2");
  await hop(icbCenter, waitJudge, "TRANSITIONS_TO", "fixture:chain:hop:3");
  await hop(
    waitJudge,
    liabilityAssignment,
    "RESOLVED_BY",
    "fixture:chain:hop:4",
  );
  await hop(
    liabilityAssignment,
    scheduler,
    "TRIGGERS",
    "fixture:chain:hop:5",
  );
  await hop(scheduler, service, "TRIGGERS", "fixture:chain:hop:6");
  await hop(service, repository, "PART_OF", "fixture:chain:hop:7");
  await hop(repository, klass, "CONTAINS", "fixture:chain:hop:8");
  await hop(klass, method, "CONTAINS", "fixture:chain:hop:9");
  await hop(method, databaseTable, "WRITES", "fixture:chain:hop:10");
  await hop(databaseTable, event, "PUBLISHES", "fixture:chain:hop:11");
  await hop(event, downstreamService, "CONSUMES", "fixture:chain:hop:12");

  return {
    chargebackId: chargeback.id,
    cbCenterId: cbCenter.id,
    icbCenterId: icbCenter.id,
    waitJudgeId: waitJudge.id,
    liabilityAssignmentId: liabilityAssignment.id,
    schedulerId: scheduler.id,
    serviceId: service.id,
    repositoryId: repository.id,
    classId: klass.id,
    methodId: method.id,
    databaseTableId: databaseTable.id,
    eventId: event.id,
    downstreamServiceId: downstreamService.id,
  };
}
