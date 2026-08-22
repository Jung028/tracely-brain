# Sequence Diagrams

Companion to [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md). Two flows: ingestion (GitHub → Brain) and
consumption (Investigation Agent → Brain). Diagrams render natively on GitHub and in any
Mermaid-aware viewer.

---

## 1. Ingestion — `syncGitHubRepository`

Fetch-before-write ordering: both GitHub calls must succeed before anything is written to the
Brain. The loop over files is collapsed to one representative iteration.

```mermaid
sequenceDiagram
    participant Caller
    participant Sync as sync.ts<br/>syncGitHubRepository
    participant Client as client.ts
    participant GH as GitHub API
    participant Brain as brain/index.ts
    participant Ent as entities.ts
    participant Rel as relationships.ts
    participant DB as Postgres

    Caller->>Sync: syncGitHubRepository({ owner, repo })

    Sync->>Client: getRepo(owner, repo)
    Client->>GH: GET /repos/{owner}/{repo}
    alt fetch fails
        GH-->>Client: non-2xx
        Client-->>Sync: ConnectionFailure
        Sync-->>Caller: ConnectionFailure (zero writes)
    else fetch ok
        GH-->>Client: 200 { default_branch, ... }
        Client-->>Sync: { ok: true, data }
    end

    Sync->>Client: getTreeRecursive(owner, repo, ref)
    Client->>GH: GET /git/trees/{sha}?recursive=1
    alt fetch fails or truncated
        GH-->>Client: non-2xx / truncated: true
        Client-->>Sync: ConnectionFailure
        Sync-->>Caller: ConnectionFailure (zero writes)
    else fetch ok
        GH-->>Client: 200 { tree: [...] }
        Client-->>Sync: { ok: true, data: entries[] }
    end

    Note over Sync: filter entries to type === "blob"<br/>all GitHub-side risk is now over

    Sync->>Brain: upsertEntity(Repository)
    Brain->>Ent: upsertEntity(...)
    Ent->>DB: INSERT ... ON CONFLICT (source_system, source_ref) DO UPDATE
    DB-->>Ent: repository row
    Ent-->>Brain: Entity
    Brain-->>Sync: repositoryEntity

    loop for each file blob
        Sync->>Brain: upsertEntity(File, attributes: { sha })
        Brain->>Ent: upsertEntity(...)
        Ent->>DB: INSERT ... ON CONFLICT DO UPDATE
        DB-->>Ent: file row
        Ent-->>Brain: Entity
        Brain-->>Sync: fileEntity

        Sync->>Brain: recordRelationshipObservation(CONTAINS)
        Brain->>Rel: recordRelationshipObservation(...)
        Rel->>DB: SELECT current row for (from, to, type)
        DB-->>Rel: existing row or none
        alt no current row
            Rel->>DB: INSERT relationship + provenance (tx)
            Note right of Rel: outcome: created
        else attributes unchanged, same source
            Rel->>DB: INSERT provenance ON CONFLICT DO NOTHING (no row)
            Note right of Rel: outcome: retained
        else attributes unchanged, new source
            Rel->>DB: INSERT provenance (row inserted)
            Note right of Rel: outcome: corroborated
        else attributes changed
            Rel->>DB: retire old row + INSERT new current row (tx)
            Note right of Rel: outcome: versioned
        end
        Rel-->>Brain: { action, relationship }
        Brain-->>Sync: result
    end

    Sync-->>Caller: { status: "ok", repositoryEntityId, filesWritten }
```

---

## 2. Consumption — Investigation Agent using the Brain

One investigation turn: bootstrap via search, traverse the graph, read live source, then move a
hypothesis's state. `hypotheses.ts` is the only code path allowed to change `status`/`confidence`
— the model only supplies evidence.

```mermaid
sequenceDiagram
    participant LLM as LLM (tool-calling loop)
    participant Tools as agent/tools.ts
    participant Brain as brain/index.ts
    participant Query as brain/query.ts
    participant DB as Postgres
    participant GHClient as github/client.ts
    participant GH as GitHub API
    participant Hyp as agent/hypotheses.ts
    participant State as InvestigationState

    LLM->>Tools: query_brain({ mode: "search", domain: "Code", entityType: "Repository" })
    Tools->>Brain: findEntities({ domain, entityType })
    Brain->>Query: (entities.ts) findEntities(filter)
    Query->>DB: SELECT * FROM entities WHERE ...
    DB-->>Query: rows
    Query-->>Brain: Entity[]
    Brain-->>Tools: Entity[]
    Tools-->>LLM: JSON entities (repo id found)

    LLM->>Tools: query_brain({ mode: "traverse", startEntityId, relationshipTypes: ["CONTAINS"], maxDepth })
    Tools->>Brain: traverse(params)
    Brain->>Query: traverse(params)
    Query->>DB: WITH RECURSIVE walk AS (...) SELECT ...
    DB-->>Query: relationship + entity rows
    Query-->>Brain: { entities, relationships }
    Brain-->>Tools: TraverseResult
    Tools-->>LLM: JSON file list

    LLM->>Tools: search_code({ pathContains: "auth" })
    Tools->>Brain: findEntities({ domain: "Code", entityType: "File" })
    Brain-->>Tools: Entity[] (filtered client-side by path substring)
    Tools->>GHClient: getFileContent(owner, repo, sha)
    GHClient->>GH: GET /git/blobs/{sha}
    GH-->>GHClient: { content: base64, encoding: "base64" }
    GHClient-->>Tools: { ok: true, data: { content } }
    Tools-->>LLM: file content text

    LLM->>Tools: propose_hypothesis({ statement })
    Tools->>Hyp: proposeHypothesis(statement)
    Hyp-->>Tools: Hypothesis { status: INVESTIGATING, confidence: 0 }
    Tools->>State: push hypothesis
    Tools-->>LLM: "created hypothesis {id}"

    LLM->>Tools: update_hypothesis({ hypothesisId, direction: "supporting", description, toolSource })
    Tools->>Hyp: addSupportingEvidence(hypothesis, evidence)
    Note right of Hyp: confidence = min(1, count * 0.2)<br/>CONFIRMED only if confidence >= 0.75<br/>AND zero contradicting evidence
    Hyp-->>Tools: updated Hypothesis
    Tools->>State: replace hypothesis
    Tools-->>LLM: "hypothesis {id} is now {status} (confidence X)"

    Note over LLM,State: loop continues until a hypothesis reaches<br/>CONFIRMED or REFUTED, or evidence runs out
```

---

## Notes

- Both diagrams reflect the codebase as of this writing — `query_database` and `search_logs` are
  omitted from the consumption diagram since they are stubs that never reach a real data source.
- The `traverse` step shown is `direction: "outgoing"` (the default). See
  `company-brain-query-interface.md` for the `incoming`/`both` variants and why `both` is a union
  of two direction-consistent walks, not full undirected reachability.
