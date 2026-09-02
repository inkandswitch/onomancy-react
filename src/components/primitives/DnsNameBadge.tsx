import type { DnsNameStatus } from "../../directory/types.js";

export interface DnsNameBadgeProps {
  /** The claimed hostname, without the `@` sigil. */
  dnsName: string;
  /** Absent when the directory in scope does not verify claims. */
  status?: DnsNameStatus;
  /**
   * How current the DNSSEC chain was when the claim was checked. Orthogonal
   * to `status` — it qualifies the verdict rather than replacing it. Absent
   * when no chain was obtained, which is not the same as failing the axis.
   */
  freshness?: "fresh" | "stale" | "deferred";
  /**
   * How far the proof had lapsed when checked, in seconds. Only meaningful
   * beside `freshness="stale"`, and often absent even then.
   */
  lapsedSeconds?: number;
  className?: string;
}

/**
 * A coarse, human-scaled age. Deliberately imprecise: the difference that
 * matters is hours versus months, and rendering "lapsed 3,847 seconds ago"
 * asks the reader to do arithmetic to reach a judgement the phrasing could
 * have handed them.
 */
function describeLapse(seconds: number): string {
  const hours = seconds / 3600;
  if (hours < 1) return "under an hour ago";
  if (hours < 48) return `about ${Math.round(hours)} hours ago`;

  const days = hours / 24;
  if (days < 60) return `about ${Math.round(days)} days ago`;
  return `about ${Math.round(days / 30)} months ago`;
}

const STATUS_GLYPH: Record<DnsNameStatus, string> = {
  verified: "\u2713",
  pending: "\u2026",
  mismatch: "\u2717",
  // A self-contradicting zone is not a refusal and not an absence. It gets
  // its own mark so it cannot be read as either.
  contested: "\u2260",
  offline: "?",
  malformed: "!",
  "no-claim": "\u2013",
  // The only failure here with a security reading, so it is the only one
  // that gets a warning mark rather than a neutral one.
  "chain-failed": "\u26a0",
  replayed: "\u26a0",
  deferred: "\u2026",
  unsynced: "?",
  invalid: "\u2717",
};

const STATUS_TITLE: Record<DnsNameStatus, string> = {
  // One direction only: DNS names a document this identity administers.
  // The document has never asserted the domain — that is the certificate,
  // and nothing here consults one — so the copy must not read as mutual.
  verified:
    "This domain's DNS records are DNSSEC-valid and designate a document that this identity administers. The document has not itself asserted this domain — that needs an onomancy certificate, which this check does not consult.",
  pending: "Checking this domain's DNS binding.",
  mismatch: "This domain's DNS binding designates a different identity.",
  contested:
    "This domain publishes two conflicting records of equal precedence, naming different documents. It has not said who it designates, which is not the same as saying it is not this identity.",
  offline:
    "This domain's DNS binding could not be reached. Nothing is proven either way — try again when you are back online.",
  // Names the remedy, and the remedy is not the network.
  malformed:
    "That is not a valid hostname, so no lookup was possible. Check the spelling of the claim.",
  "no-claim":
    "This domain answered and publishes no usable onomancy record. It is not claiming anyone — that is a statement about the domain, not about this identity.",
  // Accuses nobody and suggests no retry: a misconfigured zone and active
  // interference look the same from here, and the safe reading of both is
  // to believe nothing this domain says until it is repaired.
  "chain-failed":
    "This domain's DNS records failed cryptographic validation. That is a broken zone or interference with the answer — either way, nothing this domain currently says about anyone can be trusted. This is not a problem with your connection and not a problem with this identity.",
  replayed:
    "This domain served a record older than one already seen for it, carried by a proof that has aged. That is what a replayed, superseded record looks like. It may be a stale cache on the path rather than an attack, but the record cannot be accepted either way.",
  // Not a failure. Saying "check your clock" first is deliberate: the reader
  // can act on that, and it is the overwhelmingly likelier cause.
  deferred:
    "This domain's records are dated further ahead than this device's clock allows. Usually that means the clock here is behind. The records are not rejected — they become usable once the clock catches up.",
  unsynced:
    "This domain designates a document this device has not synced, so the claim cannot be checked yet.",
  invalid: "Not a valid DNS name.",
};

const STATUS_TONE: Record<DnsNameStatus, string> = {
  verified: "kh-text-primary kh-border-primary",
  pending: "kh-text-muted-foreground kh-border-border",
  mismatch: "kh-text-destructive kh-border-destructive",
  // Contested is not destructive: the zone is broken, the claimant is not
  // accused. Tone it as a warning rather than a refusal.
  contested: "kh-text-muted-foreground kh-border-border",
  offline: "kh-text-muted-foreground kh-border-border",
  malformed: "kh-text-destructive kh-border-destructive",
  "chain-failed": "kh-text-destructive kh-border-destructive",
  replayed: "kh-text-destructive kh-border-destructive",
  // Deferred is a wait, not a warning. Neutral tone.
  deferred: "kh-text-muted-foreground kh-border-border",
  "no-claim": "kh-text-muted-foreground kh-border-border",
  unsynced: "kh-text-muted-foreground kh-border-border",
  invalid: "kh-text-destructive kh-border-destructive",
};

const FRESHNESS_NOTE: Record<
  NonNullable<DnsNameBadgeProps["freshness"]>,
  string
> = {
  fresh: "",
  stale:
    " The proof has lapsed — it was valid once and has not been refreshed. " +
    "That is ordinary offline behaviour, not evidence of forgery.",
  deferred:
    " The proof's validity window has not opened yet, which usually means " +
    "this device's clock is ahead. Neither confirmed nor refuted.",
};

/**
 * A claimed DNS name, such as `@expede.wtf`, with its verification state.
 *
 * Without a status the claim renders as exactly that: a claim, visually no
 * stronger than a self-asserted display name.
 *
 * `freshness` grades the DNSSEC chain window and is **orthogonal** to the
 * status: it qualifies whatever the verdict was rather than replacing it. A
 * `stale` chain is a risk signal and never a forgery signal, so the binding
 * still shows and the badge stays passive — no blocking, no interruption.
 */
export function DnsNameBadge({
  dnsName,
  status,
  freshness,
  lapsedSeconds,
  className = "",
}: DnsNameBadgeProps) {
  const tone = status
    ? STATUS_TONE[status]
    : "kh-text-muted-foreground kh-border-border";

  // Only an aged or not-yet-open proof is worth marking. `fresh` is the
  // unremarkable case and adding a glyph for it would train the eye to look
  // for one, making its absence the signal instead.
  const aged = freshness === "stale" || freshness === "deferred";

  return (
    <span
      title={
        status
          ? STATUS_TITLE[status] +
            (freshness ? FRESHNESS_NOTE[freshness] : "") +
            (freshness === "stale" && lapsedSeconds !== undefined
              ? ` It lapsed ${describeLapse(lapsedSeconds)}.`
              : "")
          : undefined
      }
      className={`kh-inline-flex kh-items-center kh-gap-1 kh-px-1.5 kh-py-0.5 kh-rounded kh-text-xs kh-font-mono kh-border ${tone} ${className}`}
    >
      @{dnsName}
      {status && <span aria-hidden="true">{STATUS_GLYPH[status]}</span>}
      {aged && <span aria-hidden="true">⚠</span>}
      {status && (
        <span className="kh-sr-only">
          ({status}
          {aged ? `, ${freshness} proof` : ""})
        </span>
      )}
    </span>
  );
}
