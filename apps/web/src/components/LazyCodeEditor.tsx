// The code editor loads on first use, so the app starts without it.
import { lazy, Suspense, type ComponentProps } from "react";
import { Spinner } from "./ui";

const Editor = lazy(() => import("./CodeEditor"));

export function CodeEditor(props: ComponentProps<typeof Editor>) {
  return (
    <Suspense fallback={<Spinner />}>
      <Editor {...props} />
    </Suspense>
  );
}
