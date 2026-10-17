// group-journey-wire.ts — the engine's real dependencies: Supabase, the mailer, Mark's action queue, the logger and this box's
// environment. The routes and the daily job both build their RunDeps here so they cannot drift apart.

import { sendMail } from "./mailer";
import { logger } from "./logger";
import { createAction, resolveActionsForSource } from "./actions";
import { BUSINESS, hubKey } from "./group-secure";
import { HUB_SITE } from "./group-journey-facts";
import { KIND_LABEL } from "./group-journey";
import type { RunDeps } from "./group-journey-run";
import { supabaseJourneyStore } from "./group-journey-store";

export const ACTION_TYPE = "group_journey";

export function journeyDeps(): RunDeps {
  return {
    store: supabaseJourneyStore(),
    now: () => new Date(),
    tz: process.env["TIMEZONE"] || "America/New_York",
    site: HUB_SITE(),
    linkKey: hubKey(),
    allow: process.env["GROUP_FORMS_MAIL_ALLOW"],
    send: (m) => sendMail({ to: m.to, subject: m.subject, html: m.html, text: m.text, fromName: BUSINESS.agentName, replyTo: BUSINESS.email }),
    // Mark's rule (2026-10-08): an approval is a dashboard action plus one notification, never a file.
    requestApproval: async (a) => {
      await createAction({
        type: ACTION_TYPE,
        title: `Approve the "${KIND_LABEL[a.kind]}" email: ${a.groupName}`.slice(0, 200),
        body: `${a.count} ${a.count === 1 ? "traveler is" : "travelers are"} due to get it and nothing goes out until you approve it. Open the group file, read the preview in the Journey card (English and Spanish), then approve.`,
        buttons: [{ label: "Open the group file", href: `/groups/${a.groupId}` }],
        source_ref: `${a.groupId}:${a.kind}`,
      });
    },
    clearApproval: async (groupId, kinds) => { for (const k of kinds) await resolveActionsForSource(ACTION_TYPE, `${groupId}:${k}`); },
    warn: (obj, msg) => logger.warn(obj, msg),
  };
}
