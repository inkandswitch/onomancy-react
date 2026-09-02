import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useDirectory, useDirectoryEntry } from "../directory/context.js";
import type { DirectoryEntry, DirectoryEntryKind } from "../directory/types.js";
import { Avatar } from "./primitives/Avatar.js";
import { DnsNameBadge } from "./primitives/DnsNameBadge.js";

export interface ProfileEditorProps {
  /** Hex-encoded keyhive id whose directory entry this edits. */
  id: string;
  /** Recorded on the entry so a search can tell a group from a person. */
  kind: DirectoryEntryKind;
  /** Published with the entry when supplied. Individuals only. */
  contactCardJson?: string;
  peerId?: string;
  nameLabel?: string;
  namePlaceholder?: string;
  /**
   * Offer a field for claiming a DNS name (an onomancy `@` name). The claim
   * is self-asserted here; a verifying directory checks it against the
   * domain's DNSSEC-protected `_onomancy` TXT record.
   */
  showDnsName?: boolean;
  /**
   * Canonicalise a typed claim, throwing on anything that is not a DNS
   * name; the message is shown to the user and nothing is published.
   *
   * Pass `runtime.normalizeDnsName` from
   * `@automerge/keyhive-react/onomancy` to reject bad claims at entry
   * against the real grammar. Without it this field still canonicalises
   * spelling — trimming, lowercasing, dropping a leading `@` and a trailing
   * dot — but cannot tell a hostname from a typo, and an unparseable claim
   * is stored and later rendered `invalid` by whatever verifies it.
   *
   * Spelling is presentation; grammar is not. This component owns the first
   * and takes the second from you.
   */
  normalizeDnsName?: (raw: string) => string;
  dnsNameLabel?: string;
  dnsNamePlaceholder?: string;
  saveLabel?: string;
  /** Rendered between the name field and the buttons. */
  children?: ReactNode;
  /** Called after the entry has been written to the directory. */
  onSaved?: (entry: DirectoryEntry) => void;
  /** Renders a Cancel button when supplied. */
  onCancel?: () => void;
  fallbackAvatarSrc?: string;
  className?: string;
}

/**
 * Spelling, not grammar: what a field can canonicalise without knowing what
 * a hostname is. The default when no `normalizeDnsName` is supplied.
 */
function canonicaliseSpelling(raw: string): string {
  let claim = raw.trim().toLowerCase();
  if (claim.startsWith("@")) claim = claim.slice(1);
  if (claim.endsWith(".")) claim = claim.slice(0, -1);
  return claim;
}

/**
 * Edit the name and avatar the directory holds for one keyhive id.
 *
 * A group is named the same way a person is.
 */
export function ProfileEditor({
  id,
  kind,
  contactCardJson,
  peerId,
  nameLabel = "Name",
  namePlaceholder = "Enter a name",
  showDnsName = false,
  normalizeDnsName = canonicaliseSpelling,
  dnsNameLabel = "DNS name",
  dnsNamePlaceholder = "@example.com",
  saveLabel = "Save",
  children,
  onSaved,
  onCancel,
  fallbackAvatarSrc,
  className = "",
}: ProfileEditorProps) {
  const directory = useDirectory();
  const entry = useDirectoryEntry(id);
  const fieldId = useId();

  const [name, setName] = useState(entry?.name ?? "");
  const [dnsName, setDnsName] = useState(entry?.dnsName ?? "");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const nameEdited = useRef(false);
  const dnsNameEdited = useRef(false);
  useEffect(() => {
    nameEdited.current = false;
    dnsNameEdited.current = false;
    setName(entry?.name ?? "");
    setDnsName(entry?.dnsName ?? "");
    // Only when the subject changes, so typing is not interrupted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!nameEdited.current && entry?.name) setName(entry.name);
  }, [entry?.name]);

  useEffect(() => {
    if (!dnsNameEdited.current && entry?.dnsName) setDnsName(entry.dnsName);
  }, [entry?.dnsName]);

  useEffect(() => {
    if (!avatarFile) {
      setFilePreview(null);
      return;
    }
    const url = URL.createObjectURL(avatarFile);
    setFilePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!directory.publish) return;

    setError(null);
    setIsSaving(true);
    try {
      const avatar = avatarFile
        ? new Uint8Array(await avatarFile.arrayBuffer())
        : (entry?.avatar ?? null);
      // The empty string clears an existing claim; a hidden field leaves it be.
      const claimed = showDnsName
        ? dnsName.trim()
          ? normalizeDnsName(dnsName)
          : entry?.dnsName
            ? ""
            : undefined
        : undefined;
      const updated: DirectoryEntry = {
        id,
        name,
        avatar,
        kind,
        ...(peerId !== undefined ? { peerId } : {}),
        ...(contactCardJson !== undefined
          ? { contactCard: contactCardJson }
          : {}),
        ...(claimed !== undefined ? { dnsName: claimed } : {}),
      };
      await directory.publish(updated);
      setAvatarFile(null);
      onSaved?.(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save profile.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className={`kh-space-y-6 ${className}`}
    >
      <div className="kh-flex kh-flex-col kh-items-center kh-space-y-4">
        {filePreview ? (
          <img
            src={filePreview}
            alt="Avatar preview"
            className="kh-w-20 kh-h-20 kh-rounded-full kh-object-cover kh-border-4 kh-border-border"
          />
        ) : (
          <Avatar
            avatar={entry?.avatar}
            name={name}
            sizeClassName="kh-w-20 kh-h-20"
            fallbackSrc={fallbackAvatarSrc}
            className="kh-border-4 kh-border-border"
          />
        )}

        <div>
          <label
            htmlFor={`${fieldId}-avatar`}
            className="kh-cursor-pointer kh-inline-flex kh-items-center kh-px-4 kh-py-2 kh-border kh-border-border kh-rounded-md kh-shadow-sm kh-text-sm kh-font-medium kh-text-secondary-foreground kh-bg-secondary hover:kh-bg-accent focus:kh-outline-none focus:kh-ring-2 focus:kh-ring-offset-2 focus:kh-ring-ring"
          >
            <svg
              className="kh-w-4 kh-h-4 kh-mr-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            Upload Avatar
          </label>
          <input
            id={`${fieldId}-avatar`}
            type="file"
            accept="image/*"
            onChange={(e) => setAvatarFile(e.target.files?.[0] ?? null)}
            className="kh-hidden"
          />
        </div>
      </div>

      <div>
        <label
          htmlFor={`${fieldId}-name`}
          className="kh-block kh-text-sm kh-font-medium kh-text-foreground kh-mb-2"
        >
          {nameLabel}
        </label>
        <input
          type="text"
          id={`${fieldId}-name`}
          value={name}
          onChange={(e) => {
            nameEdited.current = true;
            setName(e.target.value);
          }}
          className="kh-w-full kh-px-3 kh-py-2 kh-border kh-border-border kh-rounded-md kh-shadow-sm focus:kh-outline-none focus:kh-ring-2 focus:kh-ring-ring focus:kh-border-ring kh-bg-background kh-text-foreground"
          placeholder={namePlaceholder}
        />
      </div>

      {showDnsName && (
        <div>
          <label
            htmlFor={`${fieldId}-dns-name`}
            className="kh-block kh-text-sm kh-font-medium kh-text-foreground kh-mb-2"
          >
            {dnsNameLabel}
            {entry?.dnsName && (
              <DnsNameBadge
                dnsName={entry.dnsName}
                status={entry.dnsNameStatus}
                freshness={entry.dnsNameFreshness}

                lapsedSeconds={entry.dnsNameLapsedSeconds}
                className="kh-ml-2"
              />
            )}
          </label>
          <input
            type="text"
            id={`${fieldId}-dns-name`}
            value={dnsName}
            onChange={(e) => {
              dnsNameEdited.current = true;
              setDnsName(e.target.value);
            }}
            className="kh-w-full kh-px-3 kh-py-2 kh-border kh-border-border kh-rounded-md kh-shadow-sm focus:kh-outline-none focus:kh-ring-2 focus:kh-ring-ring focus:kh-border-ring kh-bg-background kh-text-foreground kh-font-mono"
            placeholder={dnsNamePlaceholder}
          />
          <p className="kh-mt-1 kh-text-xs kh-text-muted-foreground">
            A domain that names this identity through an <code>_onomancy</code>{" "}
            DNS record. The claim is only trustworthy once verified.
          </p>
        </div>
      )}

      {children}

      {!directory.writable && (
        <p className="kh-text-sm kh-text-muted-foreground">
          The name directory is read-only, so this name and avatar cannot be
          changed here.
        </p>
      )}

      {directory.notice && (
        <p className="kh-text-xs kh-text-muted-foreground">
          {directory.notice}
        </p>
      )}

      {error && (
        <p role="alert" className="kh-text-sm kh-text-destructive">
          {error}
        </p>
      )}

      <div className="kh-flex kh-justify-end kh-space-x-3 kh-pt-4">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="kh-px-4 kh-py-2 kh-border kh-border-border kh-rounded-md kh-shadow-sm kh-text-sm kh-font-medium kh-text-secondary-foreground kh-bg-secondary hover:kh-bg-accent focus:kh-outline-none focus:kh-ring-2 focus:kh-ring-offset-2 focus:kh-ring-ring"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={!directory.writable || isSaving}
          className="kh-px-4 kh-py-2 kh-border kh-border-transparent kh-rounded-md kh-shadow-sm kh-text-sm kh-font-medium kh-text-primary-foreground kh-bg-primary hover:kh-opacity-90 focus:kh-outline-none focus:kh-ring-2 focus:kh-ring-offset-2 focus:kh-ring-ring disabled:kh-opacity-50"
        >
          {isSaving ? "Saving…" : saveLabel}
        </button>
      </div>
    </form>
  );
}
