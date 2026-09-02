import type { DnsNameStatus } from "../../directory/types.js";

export interface DnsNameBadgeProps {
  /** The claimed hostname, without the `@` sigil. */
  dnsName: string;
  /** Absent when the directory in scope does not verify claims. */
  status?: DnsNameStatus;
  className?: string;
}

const STATUS_GLYPH: Record<DnsNameStatus, string> = {
  verified: "\u2713",
  pending: "\u2026",
  mismatch: "\u2717",
  unreachable: "?",
  unsynced: "?",
  invalid: "\u2717",
};

const STATUS_TITLE: Record<DnsNameStatus, string> = {
  verified: "DNSSEC-verified: this domain designates this identity.",
  pending: "Checking this domain's DNS binding.",
  mismatch: "This domain's DNS binding designates a different identity.",
  unreachable: "This domain's DNS binding could not be resolved.",
  unsynced:
    "This domain designates a document this device has not synced, so the claim cannot be checked yet.",
  invalid: "Not a valid DNS name.",
};

const STATUS_TONE: Record<DnsNameStatus, string> = {
  verified: "kh-text-primary kh-border-primary",
  pending: "kh-text-muted-foreground kh-border-border",
  mismatch: "kh-text-destructive kh-border-destructive",
  unreachable: "kh-text-muted-foreground kh-border-border",
  unsynced: "kh-text-muted-foreground kh-border-border",
  invalid: "kh-text-destructive kh-border-destructive",
};

/**
 * A claimed DNS name, such as `@expede.wtf`, with its verification state.
 *
 * Without a status the claim renders as exactly that: a claim, visually no
 * stronger than a self-asserted display name.
 */
export function DnsNameBadge({
  dnsName,
  status,
  className = "",
}: DnsNameBadgeProps) {
  const tone = status
    ? STATUS_TONE[status]
    : "kh-text-muted-foreground kh-border-border";

  return (
    <span
      title={status && STATUS_TITLE[status]}
      className={`kh-inline-flex kh-items-center kh-gap-1 kh-px-1.5 kh-py-0.5 kh-rounded kh-text-xs kh-font-mono kh-border ${tone} ${className}`}
    >
      @{dnsName}
      {status && <span aria-hidden="true">{STATUS_GLYPH[status]}</span>}
      {status && <span className="kh-sr-only">({status})</span>}
    </span>
  );
}
