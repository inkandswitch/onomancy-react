# @automerge/keyhive-react

React components for applications that use keyhive.

Pre-alpha.

## Install

```
pnpm add @automerge/keyhive-react
```

`@automerge/automerge-repo-keyhive`, `@automerge/react` and `react` are peer
dependencies. The package imports none of them at runtime (see
[The keyhive runtime](#the-keyhive-runtime)), so the application's copy is the
only one loaded.

## What is in it

| Component           | For                                                  |
| ------------------- | ---------------------------------------------------- |
| `AccountView`       | Display name, avatar, and the local contact card     |
| `AccessEditor`      | Adding and removing members on a document or a group |
| `DirectoryProvider` | Putting a name directory in scope                    |

## Using it

```tsx
import * as ark from "@automerge/automerge-repo-keyhive";
import {
  createDocumentTarget,
  createKeyhiveRuntime,
  DirectoryProvider,
  AccessEditor,
  useKeyhiveUpdates,
} from "@automerge/keyhive-react";
import "@automerge/keyhive-react/styles.css";

const runtime = createKeyhiveRuntime(ark);

function Share({ hive, docUrl, directory }) {
  const keyhiveVersion = useKeyhiveUpdates(hive);
  const target = useMemo(
    () => createDocumentTarget(runtime, hive, docUrl),
    [hive, docUrl]
  );
  return (
    <DirectoryProvider directory={directory}>
      <AccessEditor target={target} refreshToken={keyhiveVersion} />
    </DirectoryProvider>
  );
}
```

Membership queries are async and keyhive has no per-document change
notification, so components re-read when `refreshToken` changes. Subscribe once
near the top of an app rather than per component.

## Access targets

A document and a group involve different APIs, so `AccessTarget` allows
one editor to interact with either.

```tsx
const target = createDocumentTarget(runtime, hive, docUrl);
const target = createGroupTarget(runtime, hive, group);
```

A group cannot be looked up from a stored id because `GroupId` has no public
constructor, so hold the handle from `generateGroup`. On a document,
`listMembers` reports the transitive closure, so a member holding access
through a group is marked as such and Remove is hidden for them.

## The keyhive runtime

`createKeyhiveRuntime(ark)` supplies the keyhive constructors from the
application's own copy of ARK. The package imports none of them itself so
there is no second module instance of a WASM-backed package to resolve wrongly.

`pnpm build` runs `scripts/check-isolation.mjs` which fails if the compiled
output imports anything but React.

## The name directory

Components look peers up in the directory in scope and know nothing about where
the answer comes from, so a name registry is swapped by passing a different
object to `DirectoryProvider`.

A directory declares what it cannot do: `writable`,
`enumerable`, and `trust`, with an optional `notice` the components display.
`subscribe` is optional, for directories whose contents live outside React.

`createAutomergeDocDirectory` covers a shared Automerge map document that each
peer writes its own entry into.

## Styling

```ts
import "@automerge/keyhive-react/styles.css";
```

Every class is prefixed `kh-` and every custom property `--kh-`, so the
stylesheet works in an application without Tailwind and alongside one with it.
There is no preflight. Override the tokens to restyle, and add the `dark` class
to a wrapper for the dark palette.

`scripts/check-prefix.mjs`, also part of `pnpm build`, fails if any unprefixed
Tailwind class is reachable from the source.

No images ship with the package. `Avatar` falls back to an initial, or `?` when
all it has is a hex id.

## Developing

```
pnpm install
pnpm build      # tsc, tailwind, then the two checks below
pnpm lint
pnpm tsc
```

## Releasing

Publishing is manual.

```
pnpm install
pnpm build
npm pack --dry-run     # check what ships
npm publish            # publishConfig.access is already public
```

Bump `version` in `package.json` and tag the commit `v<version>`.

## Notes on the keyhive API

Import keyhive types from `@automerge/automerge-repo-keyhive`, which re-exports
them, rather than from `@keyhive/keyhive`. Two import paths can resolve to two
module instances.
