// ship-watch.test.ts — the 15-day storm-page watch: its window, its signed links, the emails
// it sends (on, alert, ended), and which past-end watches get the "keep tracking?" email.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  addDays, formatWatchDate, makeWatchSig, planWatchEndings, rollingWindow, trackingEmail, watchEndedEmail,
  watchRestartUrl, watchStopUrl, WATCH_WINDOW_DAYS, type EndingWatch,
} from "./ship-watch";
import { renderAlertEmail } from "./wms-alerts";

const ID = "0b6f7a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

describe("the 15-day window", () => {
  it("counts today as day one, across month and year ends", () => {
    assert.equal(WATCH_WINDOW_DAYS, 15);
    assert.deepEqual(rollingWindow("2026-09-15"), { start: "2026-09-15", end: "2026-09-29" });
    assert.deepEqual(rollingWindow("2026-12-25"), { start: "2026-12-25", end: "2027-01-08" });
    assert.deepEqual(rollingWindow("2026-09-15", 1), { start: "2026-09-15", end: "2026-09-15" });
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });

  it("writes the last day the way each language reads it", () => {
    assert.equal(formatWatchDate("2026-09-29", "en"), "September 29");
    assert.equal(formatWatchDate("2026-09-29", "es"), "29 de septiembre");
    assert.equal(formatWatchDate("2027-01-08", null), "January 8");
  });
});

describe("signed links", () => {
  it("keeps the stop signature every stop link already in an inbox was made with", () => {
    const secret = process.env["UNSUBSCRIBE_SECRET"] || "still-afloat-unsub-v1";
    const before = crypto.createHmac("sha256", secret).update(`watch:${ID}`).digest("hex").slice(0, 24);
    assert.equal(makeWatchSig(ID), before);
    assert.equal(watchStopUrl(ID), `https://stillafloatcruising.com/api/wms/watch/stop?id=${ID}&sig=${before}`);
  });

  it("signs a restart differently, and opens the sign-up page in the subscriber's language", () => {
    const sig = makeWatchSig(ID, "restart");
    assert.match(sig, /^[0-9a-f]{24}$/);
    assert.notEqual(sig, makeWatchSig(ID));
    assert.equal(watchRestartUrl(ID, "Carnival Panorama", "en"),
      `https://stillafloatcruising.com/track-ship.html?ship=Carnival%20Panorama&restart=${ID}&sig=${sig}`);
    assert.equal(watchRestartUrl(ID, "Carnival Panorama", "es"),
      `https://stillafloatcruising.com/es/track-ship.html?ship=Carnival%20Panorama&restart=${ID}&sig=${sig}`);
  });
});

describe("the email that says a watch is on", () => {
  const base = { shipName: "Carnival Panorama", sailingStart: "2026-09-15", sailingEnd: "2026-09-29", subscriberName: "Pat Cruiser", stopUrl: "https://stop.example/w1" };

  it("tells a 15-day watcher how long it runs, that we ask before it ends, and how to stop sooner", () => {
    const en = trackingEmail({ ...base, lang: "en", windowDays: 15 });
    assert.equal(en.subject, "You're tracking Carnival Panorama — Still Afloat");
    for (const text of [
      "Hey Pat,",
      "You're all set — we're watching <strong>Carnival Panorama</strong> for you for the next 15 days, through September 29.",
      "When the 15 days are up, we'll email you, and you can keep tracking for another 15 days.",
      `Done sooner? <a href="https://stop.example/w1" style="color:#0077b6;font-weight:700;">Stop tracking Carnival Panorama</a>. Every ship watch email has this link.`,
      `<a href="https://stop.example/w1" style="color:#9ca3af;font-size:11px;">Stop tracking this ship</a>`,
    ]) assert.ok(en.html.includes(text), text);
    assert.ok(!en.html.includes("from 2026-09-15"));

    const es = trackingEmail({ ...base, lang: "es", windowDays: 15 });
    assert.equal(es.subject, "Estás siguiendo a Carnival Panorama — Still Afloat");
    for (const text of [
      "Hola Pat,",
      "Listo — estamos vigilando a <strong>Carnival Panorama</strong> por ti durante los próximos 15 días, hasta el 29 de septiembre.",
      "Cuando pasen los 15 días te escribiremos, y podrás seguirlo otros 15 días.",
      ">Deja de seguir a Carnival Panorama</a>. Cada correo de vigilancia trae este enlace.",
      ">Dejar de seguir este barco</a>",
    ]) assert.ok(es.html.includes(text), text);
  });

  it("gives a sailing watch from the tracker page the email it always had", () => {
    const en = trackingEmail({ ...base, sailingEnd: "2026-09-20", lang: "en" });
    assert.ok(en.html.includes("we're watching <strong>Carnival Panorama</strong> for you from 2026-09-15 to 2026-09-20."));
    assert.ok(en.html.includes(">Stop tracking this sailing</a>"));
    assert.ok(!en.html.includes("15 days") && !en.html.includes("Done sooner"));
    assert.equal(trackingEmail({ ...base, sailingEnd: "2026-09-20", lang: "en", windowDays: null }).html, en.html);
  });
});

describe("the email a 15-day watch sends when it ends", () => {
  it("offers another 15 days behind a button, and says doing nothing is fine", () => {
    const url = watchRestartUrl(ID, "Carnival Panorama", "en");
    const en = watchEndedEmail({ shipName: "Carnival Panorama", subscriberName: "Pat Cruiser", lang: "en", windowDays: 15, restartUrl: url });
    assert.equal(en.subject, "Your ship watch on Carnival Panorama has ended — Still Afloat");
    for (const text of [
      "Hey Pat,",
      "We watched <strong>Carnival Panorama</strong> for you for 15 days. That watch has now ended, so we won't send more updates about her.",
      "Still want to hear if a storm, an itinerary change or cruise-line news affects her? Keep tracking and we'll watch her for another 15 days.",
      `<a href="${url}" style=`,
      ">Keep Tracking for 15 More Days →</a>",
      "Nothing to do if you're done. Your weekly Still Afloat newsletter keeps coming.",
    ]) assert.ok(en.html.includes(text), text);

    const esUrl = watchRestartUrl(ID, "Carnival Panorama", "es");
    const es = watchEndedEmail({ shipName: "Carnival Panorama", subscriberName: "Pat Cruiser", lang: "es", windowDays: 15, restartUrl: esUrl });
    assert.equal(es.subject, "Terminó tu vigilancia de Carnival Panorama — Still Afloat");
    for (const text of [
      "Hola Pat,",
      "Vigilamos a <strong>Carnival Panorama</strong> por ti durante 15 días. Esa vigilancia ya terminó, así que no te enviaremos más novedades sobre este barco.",
      "Renueva la vigilancia y lo seguiremos otros 15 días.",
      `<a href="${esUrl}" style=`,
      ">Seguirlo 15 días más →</a>",
      "Si ya terminaste, no tienes que hacer nada. Tu boletín semanal de Still Afloat sigue llegando.",
    ]) assert.ok(es.html.includes(text), text);
  });
});

describe("alert emails", () => {
  const events = [{ kind: "weather" as const, hash: "h1", title: "Storm watch: Hurricane Norbert", body: "Details." }];

  it("tell a 15-day watcher when the watch ends, with a stop link in plain sight", () => {
    const en = renderAlertEmail("Pat Cruiser", "Carnival Panorama", events, "https://stop.example/w1", "en", "2026-09-29");
    assert.equal(en.subject, "Storm watch: Hurricane Norbert");
    assert.ok(en.html.includes("An update on <strong>Carnival Panorama</strong>, the ship you're tracking:"));
    assert.ok(en.html.includes(`We're watching Carnival Panorama for you through September 29. <a href="https://stop.example/w1" style="color:#0077b6;font-weight:700;">Stop tracking now</a>`));
    assert.ok(en.html.includes(">Stop tracking this ship</a>"));
    const es = renderAlertEmail("Pat Cruiser", "Carnival Panorama", events, "https://stop.example/w1", "es", "2026-09-29");
    assert.ok(es.html.includes("Novedades sobre <strong>Carnival Panorama</strong>, el barco que estás siguiendo:"));
    assert.ok(es.html.includes(`Vigilamos a Carnival Panorama por ti hasta el 29 de septiembre. <a href="https://stop.example/w1" style="color:#0077b6;font-weight:700;">Dejar de seguirlo ahora</a>`));
    assert.ok(es.html.includes(">Dejar de seguir este barco</a>"));
  });

  it("stay as they were for a sailing watch", () => {
    const en = renderAlertEmail("Pat Cruiser", "Carnival Panorama", events, "https://stop.example/w1", "en");
    assert.ok(en.html.includes("An update on <strong>Carnival Panorama</strong>, the sailing you're tracking:"));
    assert.ok(renderAlertEmail("Pat Cruiser", "Carnival Panorama", events, "https://stop.example/w1", "es").html
      .includes("Novedades sobre <strong>Carnival Panorama</strong>, el crucero que estás siguiendo:"));
    assert.ok(!en.html.includes("We're watching") && !en.html.includes("Stop tracking now"));
    assert.ok(en.html.includes(">Stop tracking this sailing</a>"));
    assert.equal(renderAlertEmail("Pat Cruiser", "Carnival Panorama", events, "https://stop.example/w1", "en", null).html, en.html);
  });
});

describe("planWatchEndings", () => {
  const sub = (status: string) => ({ email: "pat@example.com", name: "Pat", lang: "en", status });
  const row = (id: string, sailing_end: string, over: Partial<EndingWatch> = {}): EndingWatch =>
    ({ id, ship_name: "Carnival Panorama", sailing_end, window_days: 15, subscribers: sub("confirmed"), ...over });

  it("emails confirmed subscribers whose watch ended, retries for three days, and closes the rest quietly", () => {
    const today = "2026-09-30";
    const { notify, close } = planWatchEndings([
      row("yesterday", "2026-09-29"),
      row("three-days-of-retries", "2026-09-27"),
      row("gave-up", "2026-09-26"),
      row("unsubscribed", "2026-09-29", { subscribers: sub("unsubscribed") }),
      row("no-subscriber", "2026-09-29", { subscribers: null }),
      row("sailing-watch", "2026-09-29", { window_days: null }),
      row("last-day-today", "2026-09-30"),
    ], today);
    assert.deepEqual(notify.map((w) => w.id), ["yesterday", "three-days-of-retries"]);
    assert.deepEqual(close.map((w) => w.id), ["gave-up", "unsubscribed", "no-subscriber", "sailing-watch"]);
  });
});
