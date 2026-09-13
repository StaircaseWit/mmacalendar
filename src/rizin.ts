import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { fetchText } from "./http.js";
import { absoluteUrl, ageOnDate, cleanText, flagEmoji, mapWithConcurrency, normalizedName, unicodeBold } from "./utils.js";
import {
  BEST_FIGHT_ODDS_URL,
  formatPromotionOdds,
  formatPromotionOddsHistory,
  type PromotionOddsSnapshot,
} from "./promotion-odds.js";

export const RIZIN_EVENTS_URL = "https://jp.rizinff.com/_tags/%E5%A4%A7%E4%BC%9A%E6%83%85%E5%A0%B1?fr=rel";

export interface RizinFighter {
  name: string;
  profileUrl?: string;
  countryCode?: string | null;
  birthDate?: string | null;
  record?: string | null;
  style?: string | null;
  odds?: string | null;
}

export interface RizinBout {
  order: number;
  section: "Main Card" | "Opening Fights";
  red: RizinFighter;
  blue: RizinFighter;
  details: string;
  note?: string;
  oddsHistory?: PromotionOddsSnapshot[];
}

export interface RizinEvent {
  uid: string;
  date: string;
  start: string | null;
  end: string | null;
  summary: string;
  location: string;
  url: string;
  cardUrl?: string;
  status: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
  timeIsTentative: boolean;
  bouts: RizinBout[];
  cancelledBouts: RizinBout[];
}

export interface RizinListing {
  uid: string;
  date: string;
  summary: string;
  url: string;
}

export interface RizinFighterProfile {
  name?: string;
  origin?: string;
  countryCode?: string | null;
  birthDate?: string | null;
  record?: string | null;
  style?: string | null;
  checkedAt: string;
}

export interface RizinFighterStore {
  profiles: Record<string, RizinFighterProfile>;
}

function escapeIcs(value: unknown = ""): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function foldLine(line: string): string {
  const output: string[] = [];
  let current = "";
  for (const character of line) {
    if (Buffer.byteLength(current + character, "utf8") > 75) {
      output.push(current);
      current = ` ${character}`;
    } else {
      current += character;
    }
  }
  output.push(current);
  return output.join("\r\n");
}

function basicUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function compactDate(value: string): string {
  return value.replaceAll("-", "");
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return dateOnly(date);
}

function contentId(url: string): string {
  return new URL(url).pathname.match(/\/_ct\/(\d+)/)?.[1] ?? new URL(url).pathname;
}

function fragmentLines(html: string): string[] {
  const withBreaks = html.replace(/<br\s*\/?\s*>/gi, "\n");
  const $ = cheerio.load(`<div id="fragment">${withBreaks}</div>`);
  return $("#fragment").text().split(/\n+/).map(cleanText).filter(Boolean);
}

export function parseRizinEventListing(source: string): RizinListing[] {
  const $ = cheerio.load(source);
  const listings: RizinListing[] = [];
  $("#member-list .person a[href*='/_ct/']").each((_, link) => {
    const url = absoluteUrl($(link).attr("href"), "https://jp.rizinff.com");
    const heading = $(link).find("h4").first();
    const lines = fragmentLines(heading.html() ?? heading.text());
    const dateMatch = lines.join(" ").match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
    if (!url || !dateMatch) return;
    const date = `${dateMatch[1]}-${dateMatch[2]!.padStart(2, "0")}-${dateMatch[3]!.padStart(2, "0")}`;
    const summary = cleanText(lines.join(" ").replace(dateMatch[0], ""));
    if (!summary) return;
    listings.push({ uid: contentId(url), date, summary, url });
  });
  return listings.sort((left, right) => left.date.localeCompare(right.date));
}

function sectionAfterHeading($: cheerio.CheerioAPI, label: string): cheerio.Cheerio<AnyNode> {
  const heading = $(".content-body-body.article h2, .content-body-body.article h3")
    .filter((_, element) => cleanText($(element).text()) === label)
    .first();
  return heading.nextUntil("h2, h3");
}

function parseJapaneseSchedule(value: string, fallbackDate: string): { date: string; start: string | null; end: string | null; tentative: boolean } {
  const dateMatch = value.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  const date = dateMatch
    ? `${dateMatch[1]}-${dateMatch[2]!.padStart(2, "0")}-${dateMatch[3]!.padStart(2, "0")}`
    : fallbackDate;
  const timeMatch = value.match(/(\d{1,2}):(\d{2})開始/);
  if (!timeMatch) return { date, start: null, end: null, tentative: true };
  const [year, month, day] = date.split("-").map(Number);
  const startDate = new Date(Date.UTC(year!, month! - 1, day!, Number(timeMatch[1]) - 9, Number(timeMatch[2])));
  const endDate = new Date(startDate.valueOf() + 6 * 60 * 60 * 1000);
  return { date, start: basicUtc(startDate), end: basicUtc(endDate), tentative: /予定|未定/.test(value) };
}

export function parseRizinEventPage(source: string, listing: RizinListing): RizinEvent {
  const $ = cheerio.load(source);
  const scheduleText = cleanText(sectionAfterHeading($, "開催日時").first().text());
  const schedule = parseJapaneseSchedule(scheduleText, listing.date);
  const venueSection = sectionAfterHeading($, "会場");
  const location = cleanText(venueSection.find("a, strong").first().text() || venueSection.first().text());
  const article = $(".content-body-body.article").first();
  const cardLink = article.find("a[href*='/_ct/']").filter((_, link) => {
    const text = cleanText($(link).closest(".cite-box").find("h4").text() || $(link).text());
    return text.includes("対戦カード");
  }).first();
  const cardUrl = absoluteUrl(cardLink.attr("href"), "https://jp.rizinff.com") ?? undefined;
  const eventCancelled = /中止|開催延期/.test(`${listing.summary} ${scheduleText}`);
  return {
    uid: listing.uid,
    date: schedule.date,
    start: schedule.start,
    end: schedule.end,
    summary: listing.summary,
    location,
    url: listing.url,
    cardUrl,
    status: eventCancelled ? "CANCELLED" : schedule.tentative ? "TENTATIVE" : "CONFIRMED",
    timeIsTentative: schedule.tentative,
    bouts: [],
    cancelledBouts: [],
  };
}

function matchupFromHeading(value: string): { order: number | null; redName: string; blueName: string; cancelled: boolean } | null {
  const text = cleanText(value);
  if (!/\s+vs\.?\s+/i.test(text) || /大会情報|試合結果一覧/.test(text)) return null;
  const cancelled = /試合中止|中止|延期/.test(text);
  const order = Number(text.match(/第(\d+)試合/)?.[1] ?? "") || null;
  const withoutPrefix = text.replace(/^.*?(?:試合[／/]|[】])/, "");
  const names = withoutPrefix.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
  if (!names?.[1] || !names[2]) return null;
  return { order, redName: cleanText(names[1]), blueName: cleanText(names[2]), cancelled };
}

function inferStyle(value: string): string | null {
  const allRound = /総合力|オールラウンダー|コンプリートファイター/.test(value);
  const striking = /打撃|立技|パンチ|ボクシング|蹴り|キック|空手|ムエタイ/.test(value);
  const grappling = /グラウンド|グラップリング|レスリング|柔術|柔道|サブミッション|寝技|組み|テイクダウン/.test(value);
  if (allRound || (striking && grappling)) return "All-rounder";
  if (grappling) return "Grappler";
  if (striking) return "Striker";
  return null;
}

const DIVISIONS: Array<[RegExp, string]> = [
  [/女子スーパーアトム級/, "Women's Super Atomweight"],
  [/フライ級/, "Flyweight"],
  [/バンタム級/, "Bantamweight"],
  [/フェザー級/, "Featherweight"],
  [/ライト級/, "Lightweight"],
  [/ウェルター級/, "Welterweight"],
  [/ミドル級/, "Middleweight"],
  [/ライトヘビー級/, "Light Heavyweight"],
  [/ヘビー級/, "Heavyweight"],
];

const DIVISION_BY_WEIGHT = new Map([
  ["49", "Women's Super Atomweight"],
  ["57", "Flyweight"],
  ["61", "Bantamweight"],
  ["66", "Featherweight"],
  ["71", "Lightweight"],
  ["77", "Welterweight"],
  ["84", "Middleweight"],
  ["93", "Light Heavyweight"],
  ["120", "Heavyweight"],
]);

function boutDetails(lines: string[], sectionText: string): string {
  const rule = lines.find((line) => line.includes("ルール")) ?? "";
  const weight = rule.match(/[（(]([\d.]+)kg[）)]/)?.[1]?.replace(/\.0$/, "");
  const rounds = rule.match(/(\d+)分\s*(\d+)R/);
  const discipline = rule.includes("キックボクシング")
    ? "RIZIN Kickboxing"
    : rule.includes("MMA")
      ? "RIZIN MMA"
      : rule.includes("スタンディング")
        ? "RIZIN Standing Bout"
        : "RIZIN rules";
  const division = DIVISIONS.find(([pattern]) => pattern.test(sectionText))?.[1]
    ?? (weight ? DIVISION_BY_WEIGHT.get(weight) : undefined);
  const weightLabel = weight
    ? `${weight}kg${division ? ` ${division}` : " Catchweight"}`
    : division;
  const title = /タイトルマッチ/.test(sectionText) ? "Title bout" : null;
  return [weightLabel, discipline, rounds ? `${rounds[2]} × ${rounds[1]} min rounds` : null, title]
    .filter(Boolean).join(" · ");
}

export function parseRizinCardPage(source: string): { bouts: RizinBout[]; cancelledBouts: RizinBout[] } {
  const $ = cheerio.load(source);
  const parsed: Array<RizinBout & { explicitOrder: number | null; cancelled: boolean }> = [];
  $(".content-body-body.article h2.article-heading").each((_, heading) => {
    const matchup = matchupFromHeading($(heading).text());
    if (!matchup) return;
    const sectionHtml = $(heading).nextUntil("h2.article-heading").toArray().map((node) => $.html(node)).join("");
    const section = cheerio.load(`<section>${sectionHtml}</section>`);
    const matchupParagraph = section(".raw-html p").filter((__, paragraph) => /\s+vs\.?\s+/i.test(cleanText(section(paragraph).text()))).first();
    const links = matchupParagraph.find("a[href]").toArray();
    const redUrl = absoluteUrl(section(links[0]).attr("href"), "https://jp.rizinff.com") ?? undefined;
    const blueUrl = absoluteUrl(section(links[1]).attr("href"), "https://jp.rizinff.com") ?? undefined;
    const redName = cleanText(section(links[0]).text()) || matchup.redName;
    const blueName = cleanText(section(links[1]).text()) || matchup.blueName;
    const lines = fragmentLines(matchupParagraph.html() ?? "");
    const styleBoxes = section(".box-color-bgyellow .lbox-child").slice(0, 2).toArray();
    const styles = styleBoxes.map((box) => inferStyle(cleanText(section(box).find("p").last().text())));
    parsed.push({
      explicitOrder: matchup.order,
      cancelled: matchup.cancelled,
      order: matchup.order ?? 0,
      section: /OPENING FIGHT/i.test(cleanText($(heading).text())) ? "Opening Fights" : "Main Card",
      red: { name: redName, profileUrl: redUrl, style: styles[0] },
      blue: { name: blueName, profileUrl: blueUrl, style: styles[1] },
      details: boutDetails(lines, cleanText(section("section").text())),
      note: matchup.cancelled ? "Cancelled by RIZIN" : undefined,
    });
  });

  const active = parsed.filter((bout) => !bout.cancelled);
  const cancelled = parsed.filter((bout) => bout.cancelled);
  for (const sectionName of ["Main Card", "Opening Fights"] as const) {
    const sectionBouts = active.filter((bout) => bout.section === sectionName);
    sectionBouts.forEach((bout, index) => { if (!bout.explicitOrder) bout.order = sectionBouts.length - index; });
  }
  cancelled.forEach((bout, index) => { if (!bout.explicitOrder) bout.order = cancelled.length - index; });
  const clean = ({ explicitOrder: _explicitOrder, cancelled: _cancelled, ...bout }: typeof parsed[number]): RizinBout => bout;

  const notices: RizinBout[] = [];
  $(".content-body-body.article .block-lbox strong").each((_, element) => {
    const text = cleanText($(element).text()).replace(/[【】]/g, "");
    const match = text.match(/^(.+?)\s*vs\.?\s*(.+?)\s*(試合中止|試合延期|中止|延期)/i);
    if (!match?.[1] || !match[2]) return;
    notices.push({
      order: 0,
      section: "Main Card",
      red: { name: cleanText(match[1]) },
      blue: { name: cleanText(match[2]) },
      details: "",
      note: /延期/.test(match[3]!) ? "Postponed by RIZIN" : "Cancelled by RIZIN",
    });
  });
  const cancelledByNames = new Map<string, RizinBout>();
  for (const bout of [...notices, ...cancelled.map(clean)]) {
    const key = [normalizedName(bout.red.name), normalizedName(bout.blue.name)].sort().join("--");
    cancelledByNames.set(key, bout);
  }
  return { bouts: active.map(clean), cancelledBouts: [...cancelledByNames.values()] };
}

const JAPANESE_COUNTRIES: Array<[RegExp, string]> = [
  [/日本|沖縄|北海道|東京都|大阪府|京都府|[\u0080-\uFFFF]+県/, "JP"],
  [/ブラジル/, "BR"], [/アメリカ|米国|ハワイ/, "US"], [/ロシア/, "RU"], [/アゼルバイジャン/, "AZ"],
  [/キルギス/, "KG"], [/ウズベキスタン/, "UZ"], [/カザフスタン/, "KZ"], [/ダゲスタン/, "RU"], [/韓国/, "KR"], [/中国/, "CN"],
  [/モンゴル/, "MN"], [/イギリス/, "GB"], [/フランス/, "FR"], [/オーストラリア/, "AU"], [/ジョージア/, "GE"],
  [/オランダ/, "NL"], [/ポーランド/, "PL"], [/モルドバ/, "MD"], [/ベラルーシ/, "BY"], [/ウクライナ/, "UA"],
  [/南アフリカ/, "ZA"], [/アイルランド/, "IE"], [/セネガル/, "SN"], [/タジキスタン/, "TJ"], [/サモア/, "WS"],
  [/カナダ/, "CA"], [/メキシコ/, "MX"], [/ペルー/, "PE"], [/チリ/, "CL"], [/フィリピン/, "PH"], [/タイ/, "TH"],
];

function japaneseCountryCode(origin: string): string | null {
  return JAPANESE_COUNTRIES.find(([pattern]) => pattern.test(origin))?.[1] ?? null;
}

function profileCell($: cheerio.CheerioAPI, label: string): cheerio.Cheerio<AnyNode> {
  return $(".fighter_profile tr").filter((_, row) => cleanText($(row).find("th").text()).startsWith(label)).find("td").first();
}

export function parseRizinFighterPage(source: string, checkedAt = new Date()): RizinFighterProfile {
  const $ = cheerio.load(source);
  const nameCell = profileCell($, "名前");
  const names = fragmentLines(nameCell.html() ?? "");
  const origin = cleanText(profileCell($, "出身地").text());
  const birth = cleanText(profileCell($, "生年月日").text());
  const birthMatch = birth.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const results = $(".match_record tr").toArray().flatMap((row) => {
    const result = cleanText($(row).find("td.under").first().text()).toUpperCase();
    return /^(?:WIN|LOSE|LOSS|DRAW)$/.test(result) ? [result] : [];
  });
  const wins = results.filter((result) => result === "WIN").length;
  const losses = results.filter((result) => result === "LOSE" || result === "LOSS").length;
  const draws = results.filter((result) => result === "DRAW").length;
  const description = cleanText($(".fighter_profile .profile_desc").text());
  return {
    name: names[1] || names[0] || undefined,
    origin: origin || undefined,
    countryCode: japaneseCountryCode(origin),
    birthDate: birthMatch ? `${birthMatch[1]}-${birthMatch[2]!.padStart(2, "0")}-${birthMatch[3]!.padStart(2, "0")}` : null,
    record: results.length ? `${wins}-${losses}-${draws}` : null,
    style: inferStyle(description),
    checkedAt: checkedAt.toISOString(),
  };
}

function profileIsFresh(profile: RizinFighterProfile | undefined, now: Date): boolean {
  if (!profile) return false;
  if (profile.record === undefined || profile.style === undefined) return false;
  if (profile.countryCode === null && !profile.origin) return false;
  const checkedAt = new Date(profile.checkedAt);
  return Number.isFinite(checkedAt.valueOf()) && now.valueOf() - checkedAt.valueOf() < 30 * 24 * 60 * 60 * 1000;
}

export async function enrichRizinFighters(events: RizinEvent[], store: RizinFighterStore, now = new Date()): Promise<void> {
  const urls = [...new Set(events.flatMap((event) => [...event.bouts, ...event.cancelledBouts]
    .flatMap((bout) => [bout.red.profileUrl, bout.blue.profileUrl])).filter((url): url is string => Boolean(url)))];
  const due = urls.filter((url) => !profileIsFresh(store.profiles[url], now));
  await mapWithConcurrency(due, 4, async (url) => {
    try {
      store.profiles[url] = parseRizinFighterPage(await fetchText(url, { attempts: 2 }), now);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not add a RIZIN fighter profile from ${url}: ${message}`);
      store.profiles[url] = { checkedAt: now.toISOString() };
    }
  });
  for (const event of events) {
    for (const bout of [...event.bouts, ...event.cancelledBouts]) {
      for (const fighter of [bout.red, bout.blue]) {
        const profile = fighter.profileUrl ? store.profiles[fighter.profileUrl] : undefined;
        if (profile?.name) fighter.name = profile.name;
        if (profile) {
          if (profile.origin) profile.countryCode = japaneseCountryCode(profile.origin);
          fighter.countryCode = profile.countryCode;
          fighter.birthDate = profile.birthDate;
          fighter.record = profile.record;
          fighter.style = fighter.style ?? profile.style;
        }
      }
    }
  }
}

function boutKey(bout: RizinBout): string {
  return [bout.red.profileUrl ?? normalizedName(bout.red.name), bout.blue.profileUrl ?? normalizedName(bout.blue.name)].sort().join("--");
}

export function mergeRizinEvents(storedEvents: RizinEvent[], currentEvents: RizinEvent[]): RizinEvent[] {
  const merged = new Map(storedEvents.map((event) => [event.uid, event]));
  for (const current of currentEvents) {
    const stored = merged.get(current.uid);
    const currentKeys = new Set(current.bouts.map(boutKey));
    const removed = (stored?.bouts ?? []).filter((bout) => !currentKeys.has(boutKey(bout))).map((bout) => ({ ...bout, note: "Removed from the official RIZIN card" }));
    const cancelledByKey = new Map([...(stored?.cancelledBouts ?? []), ...removed, ...current.cancelledBouts].map((bout) => [boutKey(bout), bout]));
    merged.set(current.uid, {
      ...stored,
      ...current,
      cardUrl: current.cardUrl ?? stored?.cardUrl,
      bouts: current.cardUrl ? current.bouts : (stored?.bouts ?? current.bouts),
      cancelledBouts: [...cancelledByKey.values()],
    });
  }
  return [...merged.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export async function scrapeRizinEvents(now = new Date(), options: { pastDays?: number; maxEvents?: number } = {}): Promise<RizinEvent[]> {
  const all = parseRizinEventListing(await fetchText(RIZIN_EVENTS_URL));
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - (options.pastDays ?? 180));
  const listings = all.filter((listing) => listing.date >= dateOnly(cutoff)).slice(-(options.maxEvents ?? 20));
  const events = await mapWithConcurrency(listings, 3, async (listing) => parseRizinEventPage(await fetchText(listing.url), listing));
  await mapWithConcurrency(events.filter((event) => event.cardUrl), 3, async (event) => {
    try {
      Object.assign(event, parseRizinCardPage(await fetchText(event.cardUrl!)));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Could not read the RIZIN card for ${event.summary}: ${message}`);
    }
  });
  return events;
}

function shortName(name: string): string {
  return cleanText(name).split(" ").at(-1) || name;
}

function fighterDetail(fighter: RizinFighter, eventDate: string, opponentOdds: string | null | undefined): string | null {
  const age = ageOnDate(fighter.birthDate, new Date(`${eventDate}T12:00:00Z`));
  const odds = formatPromotionOdds(fighter.odds, opponentOdds);
  const details = [fighter.record ? `RIZIN ${fighter.record}` : null, age === null ? null : `${age}yo`, fighter.style, odds].filter(Boolean);
  return details.length ? `• ${shortName(fighter.name)}: ${details.join(" | ")}` : null;
}

export function describeRizinBout(details: string): string {
  let value = cleanText(details);
  const kilograms = value.match(/^([\d.]+)kg\b/i)?.[1]?.replace(/\.0$/, "");
  if (kilograms && !/\b(?:Atomweight|Flyweight|Bantamweight|Featherweight|Lightweight|Welterweight|Middleweight|Heavyweight|Catchweight)\b/i.test(value)) {
    value = value.replace(/^([\d.]+kg)\b/i, `$1 ${DIVISION_BY_WEIGHT.get(kilograms) ?? "Catchweight"}`);
  }
  return value.replace(/^([\d.]+)kg\b/i, (match, kilogramsValue: string) => {
    const pounds = (Number(kilogramsValue) * 2.2046226218).toFixed(1).replace(/\.0$/, "");
    return `${pounds}lbs/${match}`;
  });
}

function descriptionFor(event: RizinEvent, generatedAt: Date): string {
  const boutCount = event.bouts.length === 1 ? "1 announced bout" : `${event.bouts.length} announced bouts`;
  const timing = event.start
    ? event.timeIsTentative ? "Start time is provisional and will update when RIZIN confirms it." : "Times display automatically in your calendar time zone. End time is approximate."
    : "Start time has not been announced. This date-only entry will update automatically.";
  const header = [
    `RIZIN Fighting Federation · Complete Event · ${event.bouts.length ? boutCount : "card details to be announced"}`,
    `📍 ${event.location || "Venue to be announced"}`,
    timing,
  ].join("\n");
  const sections = (["Main Card", "Opening Fights"] as const).flatMap((sectionName) => {
    const sectionBouts = event.bouts.filter((bout) => bout.section === sectionName);
    if (!sectionBouts.length) return [];
    const count = sectionBouts.length === 1 ? "1 bout" : `${sectionBouts.length} bouts`;
    const heading = unicodeBold(`── ${sectionName.toUpperCase()} · ${count} ──`);
    const body = sectionBouts.map((bout) => {
      const redFlag = flagEmoji(bout.red.countryCode);
      const blueFlag = flagEmoji(bout.blue.countryCode);
      const lines = [
        `🥊 ${bout.order}. ${unicodeBold(bout.red.name)}${redFlag ? ` ${redFlag}` : ""} vs. ${unicodeBold(bout.blue.name)}${blueFlag ? ` ${blueFlag}` : ""}`,
        bout.details ? `• ${describeRizinBout(bout.details)}` : null,
        fighterDetail(bout.red, event.date, bout.blue.odds),
        fighterDetail(bout.blue, event.date, bout.red.odds),
        formatPromotionOddsHistory(bout.oddsHistory, bout.red.name, bout.blue.name),
      ].filter(Boolean);
      return lines.join("\n");
    }).join("\n\n");
    return [`${heading}\n\n${body}`];
  });
  const bouts = sections.length ? sections.join("\n\n") : "No bouts announced yet.";
  const oddsSource = event.bouts.some((bout) => bout.oddsHistory?.length)
    ? `\nOdds source: ${BEST_FIGHT_ODDS_URL} · best available line · checked Monday and Friday`
    : "";
  const cancelled = event.cancelledBouts.length ? [
    `--------------------------------\n${unicodeBold("CANCELLED OR POSTPONED BOUTS")}\n--------------------------------`,
    event.cancelledBouts.map((bout) => `✕ ${bout.red.name} vs. ${bout.blue.name}\n• ${bout.note ?? "Removed from the official RIZIN card"}`).join("\n\n"),
  ] : [];
  return [
    header,
    `--------------------------------\n${unicodeBold("BOUTS")}\n--------------------------------`,
    bouts,
    ...cancelled,
    `--------------------------------\nSource: ${event.cardUrl ?? event.url}${oddsSource}\nCalendar updated: ${generatedAt.toISOString()}`,
  ].join("\n\n");
}

export function renderRizinCalendar(events: RizinEvent[], generatedAt = new Date()): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MMA Calendar//RIZIN Fighting Federation//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:RIZIN Fighting Federation",
    "X-WR-CALDESC:RIZIN events and announced bouts.",
    "COLOR:#CF1F2B",
    "X-APPLE-CALENDAR-COLOR:#CF1F2B",
    "REFRESH-INTERVAL;VALUE=DURATION:PT6H",
    "X-PUBLISHED-TTL:PT6H",
  ];
  const stamp = basicUtc(generatedAt);
  const revision = Math.floor(generatedAt.valueOf() / 1000);
  for (const event of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeIcs(`${event.uid}@mma-calendar-rizin`)}`,
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${stamp}`,
      `SEQUENCE:${revision}`,
    );
    if (event.start && event.end) {
      lines.push(`DTSTART:${event.start}`, `DTEND:${event.end}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(event.date)}`, `DTEND;VALUE=DATE:${compactDate(nextDate(event.date))}`, "TRANSP:TRANSPARENT");
    }
    lines.push(
      `SUMMARY:${escapeIcs(event.summary)}`,
      `DESCRIPTION:${escapeIcs(descriptionFor(event, generatedAt))}`,
      `LOCATION:${escapeIcs(event.location)}`,
      `URL:${escapeIcs(event.url)}`,
      "CATEGORIES:RIZIN Fighting Federation",
      `STATUS:${event.status}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
