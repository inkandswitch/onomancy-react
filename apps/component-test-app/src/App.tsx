import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ImmutableString,
  isValidAutomergeUrl,
  useDocument,
  type AutomergeUrl,
  type Repo,
} from "@automerge/react/slim";
import type {
  AutomergeRepoKeyhive,
  Group,
} from "@automerge/automerge-repo-keyhive";
import {
  AccountView,
  bytesToHex,
  CopyableField,
  createDocumentTarget,
  bindEdge,
  createGroupTarget,
  DirectoryProvider,
  type DirectoryDoc,
  type NameDirectory,
  AccessEditor,
  ProfileEditor,
  useAutomergeDocDirectory,
  useKeyhiveUpdates,
} from "@inkandswitch/onomancy-react";
import {
  createKeyhiveDesignation,
  createOnomancyRuntime,
  idEqualityDesignation,
  useOnomancyDirectory,
  type DnsDesignation,
} from "@inkandswitch/onomancy-react/onomancy";

import { DocumentPanel, LoadDocument } from "./DocumentPanel";
import {
  hostnameRoot,
  parseLookup,
  resolveLookup,
  type Resolution,
} from "./nameResolution";
import { createStubOnomancy } from "./onomancyStub";
import { keyhiveRuntime } from "./keyhiveRuntime";

const DIRECTORY_URL_KEY = "keyhive-test-app-directory-url";
/** "auto" when this profile created the directory, "loaded" when pasted in. */
const DIRECTORY_ORIGIN_KEY = "keyhive-test-app-directory-origin";

function storedDirectoryUrl(): AutomergeUrl | null {
  const raw = localStorage.getItem(DIRECTORY_URL_KEY);
  return raw && isValidAutomergeUrl(raw) ? raw : null;
}

function base64FromHex(hex: string): string {
  let binary = "";
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(binary);
}

interface AppProps {
  hive: AutomergeRepoKeyhive;
  repo: Repo;
}

/**
 * A test app for the onomancy-react components.
 */
export default function App({ hive, repo }: AppProps) {
  // The shared directory document: the root doc a domain can bind (its id
  // goes in the TXT record's p= field), created on first run or loaded from
  // another profile.
  const [directoryUrl, setDirectoryUrl] = useState<AutomergeUrl | null>(
    storedDirectoryUrl
  );

  useEffect(() => {
    if (directoryUrl) return;
    let cancelled = false;
    void (async () => {
      // Seeded with an empty certificate list: a completely empty initial
      // document never reaches the ready state in the current stack, and
      // the list is the flat layout's own protocol key — a non-reference
      // value, absent from name matching and from the directory's entries.
      const handle = await repo.create2<Record<string, unknown>>({
        ".well-known/onomancy/certificates": [],
      });
      await hive.addSyncServerRelayToDoc(handle.url);
      if (!cancelled) {
        localStorage.setItem(DIRECTORY_URL_KEY, handle.url);
        localStorage.setItem(DIRECTORY_ORIGIN_KEY, "auto");
        setDirectoryUrl(handle.url);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [directoryUrl, hive, repo]);

  const loadDirectory = useCallback((url: AutomergeUrl) => {
    localStorage.setItem(DIRECTORY_URL_KEY, url);
    localStorage.setItem(DIRECTORY_ORIGIN_KEY, "loaded");
    setDirectoryUrl(url);
  }, []);

  // Re-render as the directory document loads: useDocument alone can miss
  // the handle becoming ready (DocumentPanel leans on the same nudge via
  // useReRenderOnDocProgress, which requires a non-null url).
  const directoryProgress = useMemo(
    () => (directoryUrl ? repo.findWithProgress(directoryUrl) : null),
    [repo, directoryUrl]
  );
  useSyncExternalStore(
    (onChange) =>
      directoryProgress ? directoryProgress.subscribe(onChange) : () => {},
    () => (directoryProgress ? directoryProgress.peek().state : "none")
  );

  const [directoryDoc, changeDirectoryDoc] = useDocument<DirectoryDoc>(
    directoryUrl ?? undefined,
    { suspense: false }
  );

  // Self-heal: an auto-created directory that never becomes ready is a dead
  // document (an earlier build created them empty, and empty documents never
  // load in the current stack). Recreate it. Manually loaded directories are
  // left alone: theirs is ordinary sync latency.
  useEffect(() => {
    if (!directoryUrl || directoryDoc) return;
    // A missing origin predates the marker: those urls were, at best,
    // auto-created empty documents. Only "loaded" is protected.
    if (localStorage.getItem(DIRECTORY_ORIGIN_KEY) === "loaded") return;
    const timer = setTimeout(() => {
      localStorage.removeItem(DIRECTORY_URL_KEY);
      setDirectoryUrl(null);
    }, 10_000);
    return () => clearTimeout(timer);
  }, [directoryUrl, directoryDoc]);
  const docDirectory = useAutomergeDocDirectory(
    directoryDoc,
    directoryDoc ? changeDirectoryDoc : undefined,
    {
      source: "directory-doc",
      notice:
        "Names are shared through a directory document and sync between profiles that can read it.",
    }
  );

  // The shared document is the only name store: its local Automerge replica
  // is already the offline copy, so a second cache would only shadow it.
  // Before the document is ready, the directory reads empty and reports
  // non-writable, and the profile editor says so — an honest window, where
  // a fallback accepted writes nobody else would ever see.
  const directory: NameDirectory = docDirectory;

  // A real app imports @inkandswitch/onomancy here instead of the stub.
  const onomancyRuntime = useMemo(
    () =>
      createOnomancyRuntime(
        createStubOnomancy(bytesToHex(hive.active.individual.id.toBytes()))
      ),
    [hive]
  );
  // Domains may bind the identity directly or a shared root document whose
  // admins own the name; the keyhive designation accepts both. The stub's
  // `.test` names stay on plain id equality so the e2e outcomes are
  // deterministic without any keyhive documents behind them.
  const designation = useMemo(() => {
    const keyhiveDesignation = createKeyhiveDesignation(keyhiveRuntime, hive);
    const compose: DnsDesignation = (entry, boundIds, hostname) =>
      hostname.endsWith(".test")
        ? idEqualityDesignation(entry, boundIds, hostname)
        : keyhiveDesignation(entry, boundIds, hostname);
    return compose;
  }, [hive]);
  const verifyingDirectory = useOnomancyDirectory(directory, onomancyRuntime, {
    designation,
  });

  // Namestore edges: path keys mapping to bare automerge: references in the
  // document's own top-level map, per the path-resolution spec's namestore
  // layout (flat, multi-segment keys, shared with protocol and directory
  // data). The bind path's anchor selects WHICH namestore the edge is
  // written into: `~`/bare into our own directory, `@hostname` into whatever
  // root document the domain designates, `automerge:` into that document
  // directly. Once the anchor picks the document, the write is identical —
  // anchors only decide where a walk (or a bind) starts.
  const bindName = useCallback(
    async (rawPath: string, url: AutomergeUrl): Promise<string> => {
      // Segment hygiene comes with the parse: `parseLookup` goes through
      // the onomancy grammar, so what is bound is exactly what resolves.
      const { root, segments } = parseLookup(rawPath);
      if (segments.length === 0) {
        throw new Error("Nothing to bind: add at least one path segment.");
      }
      const key = segments.join("/");

      let targetUrl: AutomergeUrl;
      let spelling: string;
      if (root === "self") {
        if (!directoryUrl) throw new Error("No directory document yet.");
        targetUrl = directoryUrl;
        spelling = `~/${key}`;
      } else if ("hostname" in root) {
        targetUrl = await hostnameRoot(onomancyRuntime, root.hostname);
        spelling = `@${root.hostname}/${key}`;
      } else {
        targetUrl = root.url;
        spelling = `${root.url}/${key}`;
      }

      let handle;
      try {
        handle = await repo.find<Record<string, unknown>>(targetUrl);
      } catch {
        throw new Error(
          `The target namestore is not available locally and could not be fetched from the sync server: ${targetUrl}`
        );
      }
      handle.change((doc) => {
        // The library helper carries the layout rules — reserved-path
        // refusal, the flat top-level write, the legacy-container cleanup.
        // The scalar-string encoding is ours to inject because it is the
        // substrate's: a plain JS string assigned into an Automerge map
        // becomes `Text`, which a conforming reader refuses.
        bindEdge(doc, key, url, (target) => new ImmutableString(target));
      });
      return spelling;
    },
    [directoryUrl, onomancyRuntime, repo]
  );

  const resolveName = useCallback(
    (raw: string): Promise<Resolution> => {
      if (!directoryUrl) return Promise.reject(new Error("No directory yet."));
      return resolveLookup(repo, onomancyRuntime, directoryUrl, raw);
    },
    [repo, onomancyRuntime, directoryUrl]
  );

  return (
    <DirectoryProvider directory={verifyingDirectory}>
      <TestApp
        hive={hive}
        repo={repo}
        directoryUrl={directoryUrl}
        onLoadDirectory={loadDirectory}
        onBindName={bindName}
        onResolveName={resolveName}
        bindReady={directoryDoc !== undefined}
        normalizeDnsName={onomancyRuntime.normalizeDnsName}
      />
    </DirectoryProvider>
  );
}

interface TestAppProps extends AppProps {
  directoryUrl: AutomergeUrl | null;
  onLoadDirectory: (url: AutomergeUrl) => void;
  onBindName: (path: string, url: AutomergeUrl) => Promise<string>;
  onResolveName: (raw: string) => Promise<Resolution>;
  bindReady: boolean;
  /**
   * The onomancy grammar, so a typed claim is rejected at entry rather than
   * stored and later rendered `invalid`. The library's components know what
   * a claim is; only the app holds the parser that decides one.
   */
  normalizeDnsName: (raw: string) => string;
}

function TestApp({
  hive,
  repo,
  directoryUrl,
  onLoadDirectory,
  onBindName,
  onResolveName,
  bindReady,
  normalizeDnsName,
}: TestAppProps) {
  const keyhiveVersion = useKeyhiveUpdates(hive);
  const [docUrl, setDocUrl] = useState<AutomergeUrl | null>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createDocument = useCallback(async () => {
    setError(null);
    try {
      const handle = await repo.create2<{ title: string }>({
        title: "Test app document",
      });
      await hive.addSyncServerRelayToDoc(handle.url);
      setDocUrl(handle.url);
    } catch (err) {
      setError(
        `Could not create a document: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, [hive, repo]);

  const createGroup = useCallback(async () => {
    setError(null);
    try {
      setGroup(await hive.generateGroup());
    } catch (err) {
      setError(
        `Could not create a group: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, [hive]);

  const documentTarget = useMemo(
    () => (docUrl ? createDocumentTarget(keyhiveRuntime, hive, docUrl) : null),
    [hive, docUrl]
  );
  const groupTarget = useMemo(
    () => (group ? createGroupTarget(keyhiveRuntime, hive, group) : null),
    [hive, group]
  );
  const directoryTarget = useMemo(
    () =>
      directoryUrl
        ? createDocumentTarget(keyhiveRuntime, hive, directoryUrl)
        : null,
    [hive, directoryUrl]
  );

  // The ready-to-publish TXT binding record: p= is the directory document
  // (the root doc a domain designates), g= is this identity's key (the
  // delegation-chain chokepoint; this identity is the doc's first admin).
  const dnsRecord = useMemo(() => {
    if (!directoryUrl) return null;
    const docIdHex = bytesToHex(
      keyhiveRuntime.docIdFromAutomergeUrl(directoryUrl).toBytes()
    );
    const selfHex = bytesToHex(hive.active.individual.id.toBytes());
    return `v=ONO0;k=ed25519;n=${Date.now()};g=${base64FromHex(selfHex)};p=${base64FromHex(docIdHex)}`;
  }, [directoryUrl, hive]);

  const addGroupToDocument = useCallback(async () => {
    setError(null);
    if (!documentTarget || !group) return;
    try {
      // A group has no contact card so it is added as an agent.
      await documentTarget.addAgent(
        group.toAgent(),
        keyhiveRuntime.Access.edit()
      );
    } catch (err) {
      setError(
        `Could not add the group: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, [documentTarget, group]);

  return (
    <div className="page">
      <header className="page-header">
        <h1>onomancy-react test app</h1>
      </header>

      {error && (
        <p role="alert" className="page-error">
          {error}
        </p>
      )}

      <section>
        <h2>Account</h2>
        <p className="hint">
          Names are written to the shared directory document below, with a local
          copy kept in this browser.
        </p>
        <AccountView
          hive={hive}
          publishContactCard
          normalizeDnsName={normalizeDnsName}
        />
      </section>

      <section>
        <h2>Name directory</h2>
        <p className="hint">
          The shared document names live in. It is also the root document a
          domain can designate: publish the DNS record below, and every admin of
          this directory verifies as the domain.
        </p>
        {directoryUrl ? (
          <>
            <CopyableField
              label="Directory id"
              value={directoryUrl}
              help="Load this in another profile to share one set of names."
            />
            {dnsRecord && (
              <CopyableField
                label="DNS record"
                value={dnsRecord}
                help="Publish as a TXT record at _onomancy.<your-domain> to bind the domain to this directory."
              />
            )}
            <AccessEditor
              target={directoryTarget!}
              refreshToken={keyhiveVersion}
            />
          </>
        ) : (
          <p className="hint">Creating a directory document…</p>
        )}
        <LoadDirectory onLoad={onLoadDirectory} />
      </section>

      <section>
        <h2>Names</h2>
        <p className="hint">
          Bind a path to a document, then look documents up by name. The anchor
          picks the namestore: <code>~/pics</code> (or bare <code>pics</code>)
          is this directory, <code>@example.com/pics</code> is whatever root
          document that domain designates, and <code>automerge:…/pics</code> is
          that document itself. After the anchor, every name walks the same way.
        </p>
        <NamesSection
          onBind={onBindName}
          onResolve={onResolveName}
          onOpen={setDocUrl}
          bindReady={bindReady}
        />
      </section>

      <section>
        <h2>Document</h2>
        {docUrl ? (
          <DocumentPanel
            hive={hive}
            docUrl={docUrl}
            keyhiveVersion={keyhiveVersion}
          />
        ) : (
          <>
            <p className="hint">
              Create a new document or load one another profile has shared.
            </p>
            <button type="button" onClick={() => void createDocument()}>
              Create a document
            </button>
          </>
        )}
        <LoadDocument onLoad={setDocUrl} />
      </section>

      <section>
        <h2>Document access</h2>
        {documentTarget ? (
          <AccessEditor target={documentTarget} refreshToken={keyhiveVersion} />
        ) : (
          <p className="hint">No document yet.</p>
        )}
      </section>

      <section>
        <h2>Group access</h2>
        <p className="hint">Set access levels of members in a group.</p>
        {groupTarget && group ? (
          <>
            <ProfileEditor
              id={bytesToHex(group.id.toBytes())}
              kind="group"
              nameLabel="Group name"
              namePlaceholder="Name this group"
              saveLabel="Save group"
            />
            <AccessEditor target={groupTarget} refreshToken={keyhiveVersion} />
            <button
              type="button"
              className="plain-button"
              disabled={!documentTarget}
              onClick={() => void addGroupToDocument()}
            >
              Delegate this group edit access to the document
            </button>
          </>
        ) : (
          <button type="button" onClick={() => void createGroup()}>
            Create a group
          </button>
        )}
      </section>
    </div>
  );
}

interface NamesSectionProps {
  /** Resolves to the canonical spelling of the bound edge. */
  onBind: (path: string, url: AutomergeUrl) => Promise<string>;
  onResolve: (raw: string) => Promise<Resolution>;
  onOpen: (url: AutomergeUrl) => void;
  /** False until the directory document is loaded and writable. */
  bindReady: boolean;
}

/** Bind namestore edges and resolve names against them. */
function NamesSection({
  onBind,
  onResolve,
  onOpen,
  bindReady,
}: NamesSectionProps) {
  const [bindPath, setBindPath] = useState("");
  const [bindUrl, setBindUrl] = useState("");
  const [bindError, setBindError] = useState<string | null>(null);
  const [bound, setBound] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<Resolution | null>(null);
  // The hostname this outcome came from, captured at submit — never read
  // from `query` at render, which keeps taking keystrokes while the resolve
  // is in flight and would caption one result with another name. The caption
  // makes a security claim, so a mismatched hostname is a lie, not a slip.
  // Capture only prevents the mismatch; deriving caption and document from
  // one route object would make it unrepresentable. Guarded, not solved.
  const [resolvedHostname, setResolvedHostname] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBindError(null);
          setBound(null);
          const path = bindPath.trim();
          const raw = bindUrl.trim();
          const url = raw.startsWith("automerge:") ? raw : `automerge:${raw}`;
          if (!path) return;
          if (!isValidAutomergeUrl(url)) {
            setBindError("That is not a valid Automerge document id.");
            return;
          }
          onBind(path, url)
            .then((spelling) => {
              setBound(spelling);
              setBindPath("");
              setBindUrl("");
            })
            .catch((err: unknown) => {
              setBindError(err instanceof Error ? err.message : String(err));
            });
        }}
        style={{ display: "flex", gap: "0.5rem" }}
      >
        <input
          type="text"
          value={bindPath}
          onChange={(e) => setBindPath(e.target.value)}
          placeholder="pics/vacation"
          aria-label="Name path"
          style={{ flex: 1, padding: "0.5rem", font: "inherit" }}
        />
        <input
          type="text"
          value={bindUrl}
          onChange={(e) => setBindUrl(e.target.value)}
          placeholder="automerge:…"
          aria-label="Named document id"
          style={{ flex: 2, padding: "0.5rem", font: "inherit" }}
        />
        <button type="submit" disabled={!bindReady}>
          Bind
        </button>
      </form>
      {bindError && (
        <p role="alert" className="page-error">
          {bindError}
        </p>
      )}
      {bound && <p className="hint">Bound {bound}.</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const raw = query.trim();
          if (!raw) return;
          setResolveError(null);
          setOutcome(null);
          // Only a `@hostname` root makes a DNS claim. `~` and bare paths
          // start from our own directory, which asserts nothing about a
          // domain.
          setResolvedHostname(
            raw.startsWith("@") ? raw.slice(1).split("/")[0]! : null
          );
          setResolving(true);
          onResolve(raw)
            .then(setOutcome)
            .catch((err: unknown) => {
              setResolveError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => setResolving(false));
        }}
        style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="~/pics/vacation or @example.com/pics"
          aria-label="Name to resolve"
          style={{ flex: 1, padding: "0.5rem", font: "inherit" }}
        />
        <button type="submit" disabled={resolving}>
          {resolving ? "Resolving…" : "Resolve"}
        </button>
      </form>
      {resolveError && (
        <p role="alert" className="page-error">
          {resolveError}
        </p>
      )}
      {outcome?.status === "resolved" && (
        <p className="hint">
          Resolved to <code>{outcome.url}</code>{" "}
          <button type="button" onClick={() => onOpen(outcome.url)}>
            Open
          </button>
        </p>
      )}
      {outcome?.status === "resolved" && resolvedHostname !== null && (
        // Shown only for a resolved `@hostname` route. DNS reached a
        // document; nothing proved the document accepts the domain — that
        // needs the onomancy certificate. Certificates arrive by replication
        // inside the bound document, so the verb is *hold*, not *fetch*.
        // The wording is shared with keyhive-todo-app-demo; keep them in
        // step if it changes.
        <p role="note" className="hint">
          Resolved through DNS. Nothing here proves this document accepts{" "}
          <strong>{resolvedHostname}</strong> — that check needs the onomancy
          certificate, which this app does not yet hold.
        </p>
      )}
      {outcome?.status === "partial" && (
        <p className="hint">
          Partial: consumed {outcome.consumed} of {outcome.total} segment(s),
          then{" "}
          {outcome.reason === "unsynced-target"
            ? "the next document is not synced here:"
            : "no edge matched the remaining segments in:"}{" "}
          <code>{outcome.at}</code>
          {outcome.reason === "unsynced-target" && outcome.consumed === 0 && (
            <>
              {" "}
              If this is your own domain, compare it with the Directory id
              above: an older published record may designate a document that no
              longer exists.
            </>
          )}
        </p>
      )}
    </>
  );
}

interface LoadDirectoryProps {
  onLoad: (url: AutomergeUrl) => void;
}

/** Switch to a directory document another profile shared. */
function LoadDirectory({ onLoad }: LoadDirectoryProps) {
  const [input, setInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = input.trim();
        if (!trimmed) return;
        const url = trimmed.startsWith("automerge:")
          ? trimmed
          : `automerge:${trimmed}`;
        if (!isValidAutomergeUrl(url)) {
          setLoadError("That is not a valid Automerge document id.");
          return;
        }
        setLoadError(null);
        setInput("");
        onLoad(url);
      }}
      style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}
    >
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Directory id"
        aria-label="Load directory id"
        style={{ flex: 1, padding: "0.5rem", font: "inherit" }}
      />
      <button type="submit">Load</button>
      {loadError && (
        <p role="alert" className="page-error">
          {loadError}
        </p>
      )}
    </form>
  );
}
