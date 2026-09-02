import * as ark from "@automerge/automerge-repo-keyhive";
import { createKeyhiveRuntime } from "@inkandswitch/onomancy-react";

// The only route by which onomancy-react reaches the keyhive packages.
export const keyhiveRuntime = createKeyhiveRuntime(ark);
