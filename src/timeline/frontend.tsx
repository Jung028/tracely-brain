// React entrypoint for the timeline UI (src/timeline/index.html). Thin by
// design (task-3-brief.md): fetches the demo timeline and hands it to
// TimelineView, which owns all rendering logic.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TimelineView } from "./TimelineView";
import type { TimelineStep } from "./types";

function App() {
  const [steps, setSteps] = useState<readonly TimelineStep[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/timeline/demo")
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Request failed with status ${res.status}`);
        }
        return res.json();
      })
      .then((data: { steps: TimelineStep[] }) => setSteps(data.steps))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) {
    return <div className="timeline-error">Failed to load investigation timeline: {error}</div>;
  }
  if (steps === null) {
    return <div className="timeline-loading">Loading investigation timeline…</div>;
  }
  return <TimelineView steps={steps} />;
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}
createRoot(container).render(<App />);
