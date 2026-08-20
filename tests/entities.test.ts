import { afterEach, describe, expect, test } from "bun:test";
import { EntityNotFoundError } from "../src/brain/errors";
import { findEntities, getEntity, upsertEntity } from "../src/brain/entities";
import { truncateAll } from "./db-helpers";

afterEach(async () => {
  await truncateAll();
});

describe("upsertEntity", () => {
  test("creates a new entity with all fields populated correctly", async () => {
    const entity = await upsertEntity({
      domain: "Code",
      entityType: "Repository",
      name: "acme/repo",
      sourceSystem: "github",
      sourceRef: "github:acme/repo",
      attributes: { language: "TypeScript" },
    });

    expect(entity.id).toBeString();
    expect(entity.domain).toBe("Code");
    expect(entity.entityType).toBe("Repository");
    expect(entity.name).toBe("acme/repo");
    expect(entity.sourceSystem).toBe("github");
    expect(entity.sourceRef).toBe("github:acme/repo");
    expect(entity.attributes).toEqual({ language: "TypeScript" });
    expect(entity.createdAt).toBeInstanceOf(Date);
    expect(entity.updatedAt).toBeInstanceOf(Date);
  });

  test("defaults attributes to an empty object when omitted", async () => {
    const entity = await upsertEntity({
      domain: "Code",
      entityType: "Repository",
      name: "acme/repo",
      sourceSystem: "github",
      sourceRef: "github:acme/repo",
    });

    expect(entity.attributes).toEqual({});
  });

  test("calling again with the same (sourceSystem, sourceRef) updates the row in place, no duplicate", async () => {
    const first = await upsertEntity({
      domain: "Code",
      entityType: "Repository",
      name: "acme/repo",
      sourceSystem: "github",
      sourceRef: "github:acme/repo",
      attributes: { language: "TypeScript" },
    });

    // Ensure a measurable time gap so updated_at strictly advances.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await upsertEntity({
      domain: "Code",
      entityType: "Repository",
      name: "acme/repo-renamed",
      sourceSystem: "github",
      sourceRef: "github:acme/repo",
      attributes: { language: "Rust" },
    });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("acme/repo-renamed");
    expect(second.attributes).toEqual({ language: "Rust" });
    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());

    const all = await findEntities({});
    const matching = all.filter(
      (e) => e.sourceSystem === "github" && e.sourceRef === "github:acme/repo",
    );
    expect(matching.length).toBe(1);
  });

  test("rejects a domain outside the controlled vocabulary before hitting the DB", async () => {
    await expect(
      upsertEntity({
        // deliberately invalid — cast through unknown to bypass the TS literal type
        domain: "NotARealDomain" as unknown as Parameters<typeof upsertEntity>[0]["domain"],
        entityType: "Repository",
        name: "bad-domain",
        sourceSystem: "manual",
        sourceRef: "test:invalid-domain",
      }),
    ).rejects.toThrow(/Invalid domain/);
  });
});

describe("getEntity", () => {
  test("returns the entity for a known id", async () => {
    const created = await upsertEntity({
      domain: "Runtime",
      entityType: "Service",
      name: "payments-service",
      sourceSystem: "manual",
      sourceRef: "test:get-entity",
    });

    const fetched = await getEntity(created.id);
    expect(fetched).toEqual(created);
  });

  test("throws EntityNotFoundError for a nonexistent id", async () => {
    const missingId = "00000000-0000-0000-0000-000000000000";
    await expect(getEntity(missingId)).rejects.toThrow(EntityNotFoundError);
  });
});

describe("findEntities", () => {
  test("filters by domain", async () => {
    await upsertEntity({
      domain: "Code",
      entityType: "Repository",
      name: "repo-1",
      sourceSystem: "manual",
      sourceRef: "test:find-domain:1",
    });
    await upsertEntity({
      domain: "Runtime",
      entityType: "Service",
      name: "service-1",
      sourceSystem: "manual",
      sourceRef: "test:find-domain:2",
    });

    const codeEntities = await findEntities({ domain: "Code" });
    expect(codeEntities.length).toBe(1);
    expect(codeEntities[0]?.name).toBe("repo-1");

    const runtimeEntities = await findEntities({ domain: "Runtime" });
    expect(runtimeEntities.length).toBe(1);
    expect(runtimeEntities[0]?.name).toBe("service-1");
  });

  test("filters by entityType", async () => {
    await upsertEntity({
      domain: "Code",
      entityType: "Repository",
      name: "repo-1",
      sourceSystem: "manual",
      sourceRef: "test:find-type:1",
    });
    await upsertEntity({
      domain: "Code",
      entityType: "Class",
      name: "SomeClass",
      sourceSystem: "manual",
      sourceRef: "test:find-type:2",
    });

    const repos = await findEntities({ entityType: "Repository" });
    expect(repos.length).toBe(1);
    expect(repos[0]?.name).toBe("repo-1");

    const classes = await findEntities({ entityType: "Class" });
    expect(classes.length).toBe(1);
    expect(classes[0]?.name).toBe("SomeClass");
  });

  test("with no filter returns all entities", async () => {
    await upsertEntity({
      domain: "Code",
      entityType: "Repository",
      name: "repo-1",
      sourceSystem: "manual",
      sourceRef: "test:find-all:1",
    });
    await upsertEntity({
      domain: "Runtime",
      entityType: "Service",
      name: "service-1",
      sourceSystem: "manual",
      sourceRef: "test:find-all:2",
    });

    const all = await findEntities({});
    expect(all.length).toBe(2);
  });
});
