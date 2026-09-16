import { Background, BackgroundVariant } from "@xyflow/react";

/** Graph-paper grid for every canvas: fine lines every 20px and heavier lines every 100px. */
export function PaperBackground() {
  return (
    <>
      <Background id="paper-minor" variant={BackgroundVariant.Lines} gap={20} lineWidth={0.5} color="var(--paper-minor)" />
      <Background id="paper-major" variant={BackgroundVariant.Lines} gap={100} lineWidth={1} color="var(--paper-major)" />
    </>
  );
}
