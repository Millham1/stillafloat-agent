import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileCheck2, Link2, Mail, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ANALYTICS_KEY, api } from "@/lib/group-api";
import { signedCopies, type WPaperwork, type WTraveler, type WorkspaceData } from "@/lib/group-workspace";
import { LinkBox } from "./group-paperwork";

// Mark 2026-10-25: "Add the paperwork actions to the Group Workspace: email the link, make a link, open the signed copy, per traveler."
// The workspace is the workhorse (Mark 2026-10-19), so the paperwork is worked from here too. These are the same calls the group's
// file page makes; a click inside an action cell never opens the group's file (the row's own click).

const btn = "text-xs px-2 py-1 rounded border bg-card hover:bg-muted/40 disabled:opacity-50 inline-flex items-center gap-1 whitespace-nowrap";
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

/** Opens a signed copy: a 10-minute link to the private bucket, fetched on the click (a blank tab first, so no pop-up blocker stops it). */
async function openCopy(groupId: string, signatureId: string): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const r = await api<{ url: string }>(`/groups/${groupId}/signatures/${signatureId}/file`);
    if (tab) tab.location.href = r.url; else window.location.href = r.url;
  } catch (e) {
    tab?.close();
    throw e;
  }
}

export function TravelerActions({ row }: { row: WTraveler }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCopies, setShowCopies] = useState(false);
  const data = qc.getQueryData<WorkspaceData>(ANALYTICS_KEY);
  const copies = signedCopies(data?.paperwork ?? [], row.id);

  const run = async (fn: () => Promise<void>, failTitle: string) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast({ variant: "destructive", title: failTitle, description: (e as Error).message }); }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: ANALYTICS_KEY });
  };
  const emailLink = () => {
    if (!window.confirm(`Email a new paperwork link to ${row.name} (${row.email})? Any earlier link for this traveler stops working.`)) return;
    void run(async () => {
      const r = await api<{ sentTo: string }>(`/groups/${row.groupId}/travelers/${row.id}/form-link/send`, "POST", {});
      setUrl(null);
      toast({ title: "Paperwork link emailed", description: `Sent to ${r.sentTo}` });
    }, "The email did not go out");
  };
  const makeLink = () => run(async () => {
    const r = await api<{ url: string }>(`/groups/${row.groupId}/travelers/${row.id}/form-link`, "POST", {});
    setUrl(r.url);
    toast({ title: "Link made", description: "Copy it now: it is shown only this once." });
  }, "Could not make the link");

  return (
    <div className="space-y-1 whitespace-normal" onClick={stop} onKeyDown={stop}>
      <div className="flex gap-1 flex-wrap">
        <button type="button" className={btn} disabled={busy || !row.email} onClick={emailLink}
          title={row.email ? `Email the paperwork link to ${row.email}` : "This traveler has no email address on the file"}><Mail className="w-3 h-3" /> Email link</button>
        <button type="button" className={btn} disabled={busy} onClick={() => void makeLink()} title="Make a link you can text or read out"><Link2 className="w-3 h-3" /> Make link</button>
        <button type="button" className={btn} disabled={!copies.length} onClick={() => setShowCopies((v) => !v)} aria-expanded={showCopies}
          title={copies.length ? "Open a signed copy" : "Nothing signed yet"}><FileCheck2 className="w-3 h-3" /> Signed copies ({copies.length})</button>
      </div>
      {showCopies && copies.length > 0 && (
        <ul className="text-xs border rounded bg-muted/30 p-1.5 space-y-0.5 min-w-[16rem]">
          {copies.map((c) => (
            <li key={c.signatureId}>
              <button type="button" className="underline text-left inline-flex items-center gap-1"
                onClick={() => void openCopy(c.groupId, c.signatureId).catch((e) => toast({ variant: "destructive", title: "Could not open the signed copy", description: (e as Error).message }))}>
                {c.sealed && <ShieldCheck className="w-3 h-3 text-green-700" aria-label="sealed" />}{c.docTitle}
              </button>
            </li>
          ))}
        </ul>
      )}
      {url && <LinkBox url={url} />}
    </div>
  );
}

/** The paperwork grid's own action: open the signed copy of this one document. */
export function CopyButton({ row }: { row: WPaperwork }) {
  const { toast } = useToast();
  if (row.status !== "signed" || !row.hasCopy || !row.signatureId) return <span className="text-muted-foreground">—</span>;
  const id = row.signatureId;
  return (
    <span onClick={stop} onKeyDown={stop}>
      <button type="button" className={btn} title={row.sealed ? "Open the signed copy (sealed with our certificate)" : "Open the signed copy"}
        onClick={() => void openCopy(row.groupId, id).catch((e) => toast({ variant: "destructive", title: "Could not open the signed copy", description: (e as Error).message }))}>
        {row.sealed ? <ShieldCheck className="w-3 h-3 text-green-700" /> : <FileCheck2 className="w-3 h-3" />} Open copy
      </button>
    </span>
  );
}
