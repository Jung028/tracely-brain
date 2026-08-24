// React entrypoint for the timeline UI (src/timeline/index.html). Thin by
// design (task-3-brief.md): fetches the timeline payload and hands it to
// TimelineView, which owns all rendering logic. problemDescription/status/
// summary are only present for a real investigation
// (GET /api/timeline/:id) — the demo route (GET /api/timeline/demo) omits
// them, and TimelineView treats all three as optional for that reason.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TimelineView } from "./TimelineView";
import type { TimelineStep } from "./types";
import type { InvestigationSummary } from "./summary";

interface TimelinePayload {
  steps: TimelineStep[];
  problemDescription?: string;
  status?: string;
  summary?: InvestigationSummary;
}

function App() {
  const [payload, setPayload] = useState<TimelinePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const investigationId = new URLSearchParams(window.location.search).get("investigation");
    const url = investigationId ? `/api/timeline/${investigationId}` : "/api/timeline/demo";

    fetch(url)
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Request failed with status ${res.status}`);
        }
        return res.json();
      })
      .then((data: TimelinePayload) => setPayload(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) {
    return <div className="timeline-error">Failed to load investigation timeline: {error}</div>;
  }
  if (payload === null) {
    return <div className="timeline-loading">Loading investigation timeline…</div>;
  }
  return (
    <TimelineView
      steps={payload.steps}
      problemDescription={payload.problemDescription}
      status={payload.status}
      summary={payload.summary}
    />
  );
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}
createRoot(container).render(<App />);
