import test from "node:test";
import assert from "node:assert/strict";
import { mergePflEvents, parsePflEventListing, parsePflEventPage, parsePflFighterPage, renderPflCalendar } from "../src/promotions/pfl/index.js";

test("discovers PFL events and converts published card times to UTC", () => {
  const listingHtml = `<script type="application/ld+json">${JSON.stringify({
    "@graph": [{
      "@type": "ItemList",
      itemListElement: [{ item: {
        "@type": "SportsEvent",
        name: "PFL Chicago 2",
        description: "Wintrust Arena",
        startDate: "2026-10-16T00:00:00-04:00",
        location: { name: "Wintrust Arena, Chicago" },
        url: "https://pflmma.com/event/2026-chicago2",
      } }],
    }],
  })}</script>`;
  const listing = parsePflEventListing(listingHtml)[0]!;
  assert.deepEqual(listing, {
    uid: "2026-chicago2",
    date: "2026-10-16",
    summary: "PFL Chicago 2",
    location: "Wintrust Arena, Chicago",
    url: "https://pflmma.com/event/2026-chicago2",
  });

  const visibleListing = parsePflEventListing(`
    <div id="nav-upcoming"><article class="event-hub"><div class="event-card-info">
      <h6>Fri, Oct 16</h6><h3>PFL Chicago 2</h3><p>Wintrust Arena</p>
      <a href="/event/pfl-chicago-2">Event details</a>
    </div></article></div>
    <div id="nav-past"><article class="event-hub"><div class="event-card-info">
      <h6>Sat, Sep 5</h6><h3>PFL Europe Paris</h3><p>Accor Arena</p>
      <a href="/event/pfl-europe-paris">Event details</a>
    </div></article></div>
  `, new Date("2026-09-13T12:00:00Z"));
  assert.deepEqual(visibleListing.map(({ date, summary }) => ({ date, summary })), [
    { date: "2026-09-05", summary: "PFL Europe Paris" },
    { date: "2026-10-16", summary: "PFL Chicago 2" },
  ]);

  const eventHtml = `<script type="application/ld+json">${JSON.stringify({
    "@graph": [{
      "@type": "SportsEvent",
      "@id": "https://pflmma.com/event/2026-chicago2#event",
      name: "PFL Chicago 2",
      startDate: "2026-10-16T00:00:00-04:00",
      eventStatus: "https://schema.org/EventScheduled",
      location: { name: "Wintrust Arena, Chicago" },
      subEvent: [{
        "@type": "SportsEvent",
        "@id": "https://pflmma.com/event/2026-chicago2#fight-42",
        name: "Liz Carmouche vs Jena Bishop",
        description: "Liz Carmouche vs Jena Bishop - Women's Flyweight Semifinal",
        eventStatus: "https://schema.org/EventScheduled",
        competitor: [
          { "@type": "Person", name: "Liz Carmouche", url: "https://pflmma.com/wt-fighter/liz-carmouche" },
          { "@type": "Person", name: "Jena Bishop", url: "https://pflmma.com/wt-fighter/jena-bishop" },
        ],
      }],
    }],
  })}</script>
  <p class="event-info-time">Main Card</p><p class="event-info-time-text">3:00 AM ET</p>
  <p class="event-info-time">Early Card</p><p class="event-info-time-text">11:00 PM ET</p>`;
  const event = parsePflEventPage(eventHtml, listing);
  assert.equal(event.start, "20261017T030000Z");
  assert.equal(event.end, "20261017T100000Z");
  assert.equal(event.status, "CONFIRMED");
  assert.equal(event.bouts[0]!.details, "125lbs/57kg Women's Flyweight · Semifinal");
});

test("formats PFL fighter details and tracks removed bouts", () => {
  const profile = parsePflFighterPage(`<script type="application/ld+json">${JSON.stringify({
    "@graph": [{
      "@type": "Person",
      name: "Liz Carmouche",
      nationality: "United States",
      birthDate: "1984-02-17T00:00:00+00:00",
      description: "A wrestler and submission grappler known for her ground game.",
    }],
  })}</script><h4>Career Record: 26-8-0</h4>`, new Date("2026-09-13T12:00:00Z"));
  assert.deepEqual(profile, {
    name: "Liz Carmouche",
    countryCode: "US",
    birthDate: "1984-02-17",
    record: "26-8-0",
    style: "Grappler",
    checkedAt: "2026-09-13T12:00:00.000Z",
  });

  const invalidBirthDate = parsePflFighterPage(`<script type="application/ld+json">${JSON.stringify({
    "@type": "Person", name: "Bad Source Date", birthDate: "2026-04-01T00:00:00+00:00",
  })}</script>`, new Date("2026-09-13T12:00:00Z"));
  assert.equal(invalidBirthDate.birthDate, null);

  const bout = {
    id: "42", order: 1, details: "125lbs/57kg Women's Flyweight",
    red: { ...profile, name: "Liz Carmouche", profileUrl: "https://pflmma.com/wt-fighter/liz-carmouche" },
    blue: { name: "Jena Bishop", countryCode: "US" },
  };
  const event = {
    uid: "chicago", date: "2026-10-16", summary: "PFL Chicago 2", location: "Wintrust Arena",
    url: "https://pflmma.com/event/2026-chicago2", start: "20261017T030000Z", end: "20261017T100000Z",
    status: "CONFIRMED" as const, bouts: [bout], cancelledBouts: [],
  };
  const output = renderPflCalendar([event], new Date("2026-09-13T12:00:00Z")).replace(/\r\n[ \t]/g, "");
  assert.match(output, /X-WR-CALNAME:Professional Fighters League/);
  assert.match(output, /DTSTART:20261017T030000Z/);
  assert.match(output, /🥊 1\. 𝗟𝗶𝘇 𝗖𝗮𝗿𝗺𝗼𝘂𝗰𝗵𝗲 🇺🇸 vs\. 𝗝𝗲𝗻𝗮 𝗕𝗶𝘀𝗵𝗼𝗽 🇺🇸/);
  assert.match(output, /• Carmouche: 26-8-0 \| 42yo \| Grappler/);

  const updated = { ...event, bouts: [], cancelledBouts: [] };
  const merged = mergePflEvents([event], [updated]);
  assert.equal(merged[0]!.bouts.length, 1);
  assert.equal(merged[0]!.cancelledBouts.length, 0);

  const placeholder = { ...event, uid: "future", start: null, end: null, status: "TENTATIVE" as const, bouts: [], cancelledBouts: [] };
  const placeholderOutput = renderPflCalendar([placeholder], new Date("2026-09-13T12:00:00Z")).replace(/\r\n[ \t]/g, "");
  assert.match(placeholderOutput, /DTSTART;VALUE=DATE:20261016/);
});
