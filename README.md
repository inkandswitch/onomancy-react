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
only one loaded. `@inkandswitch/onomancy` is an optional peer dependency,
supplied the same way, for [DNS names](#dns-names).

## What is in it

| Component           | For                                                  |
| ------------------- | ---------------------------------------------------- |
| `AccountView`       | Display name, avatar, and the local contact card     |
| `AccessEditor`      | Adding and removing members on a document or a group |
| `DirectoryProvider` | Putting a name directory in scope                    |
| `DnsNameBadge`      | A claimed DNS name with its verification state       |

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

## DNS names

An entry can claim a DNS name (`entry.dnsName`), giving an identity a
memorable, globally shareable spelling like `@expede.wtf`. The claim is
self-asserted until it is verified through
[onomancy](https://github.com/inkandswitch/onomancy): the domain publishes a
DNSSEC-protected `_onomancy` TXT record whose `p=` field is the identity's
ed25519 verifying key, and the record is validated locally from the IANA root
— no registry, no certificate authority, and no trust in whoever relayed it.

Like keyhive, onomancy is Wasm-backed, so the application supplies its own
copy through a runtime and this package imports nothing:

```tsx
import * as onomancy from "@inkandswitch/onomancy";
import {
  createOnomancyRuntime,
  useOnomancyDirectory,
} from "@automerge/keyhive-react";

const onomancyRuntime = createOnomancyRuntime(onomancy);

function App({ baseDirectory }) {
  // Decorates entries that claim a dnsName with a verification status.
  const directory = useOnomancyDirectory(baseDirectory, onomancyRuntime);
  return <DirectoryProvider directory={directory}>{/* … */}</DirectoryProvider>;
}
```

A claim is checked once, lazily, the first time its entry is read, and the
result lands on the entry as `dnsNameStatus`: `verified`, `mismatch`,
`unreachable`, `unsynced`, `pending`, or `invalid`. `ContactBook`,
`AccessEditor`, and `ProfileEditor` render the claim as a `DnsNameBadge`; a
directory without the wrapper renders claims as exactly that — claims,
visually no stronger than a self-asserted display name.

Verification is two layers. DNS proves `hostname → root document ids`; a
_designation_ decides whether those documents belong to the entry's identity.
The default designation requires the bound id to be the identity itself — the
solo case. Domains are meant to bind a shared root namestore document instead,
whose admins own the name (ownership is shared by inviting more admins; the
DNS record never changes):

```tsx
const designation = createKeyhiveDesignation(keyhiveRuntime, hive);
const directory = useOnomancyDirectory(baseDirectory, onomancyRuntime, {
  designation,
});
```

The keyhive designation accepts both anchor shapes: a bound id that is the
identity verifies directly, and otherwise the designated document's members
are consulted (admin access by default). A designated document this device has
not synced reads `unsynced` — not evidence either way — until a replica
arrives.

`AccountView` offers the field for claiming a name (turn it off with
`showDnsName={false}`). Publishing an empty string withdraws the claim.

A verified badge proves that the domain, as attested by a DNSSEC chain from
the IANA root during the chain's signature window, designated this identity.
It proves nothing about the domain owner's intentions, and nothing about any
other name.

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
npm publish --dry-run --tag next   # check what ships
npm publish --tag next             # publishConfig.access is already public
```

Bump `version` in `package.json` and tag the commit `v<version>`.

## Notes on the keyhive API

Import keyhive types from `@automerge/automerge-repo-keyhive`, which re-exports
them, rather than from `@keyhive/keyhive`. Two import paths can resolve to two
module instances.
