import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { fetchText } from "../../http.js";
import { absoluteUrl, cleanText, mapWithConcurrency, normalizedName } from "../../utils.js";
import type { PromotionOddsSnapshot } from "../../promotion-odds.js";
import { calendarUtc } from "../../calendar-renderer.js";
import { retainEventHistory } from "../../retention.js";
import { rizinDivisionForKilograms } from "./divisions.js";

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

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function rizinStartDate(event: RizinEvent): Date {
  const match = event.start?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])))
    : new Date(`${event.date}T23:59:59Z`);
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
  return { date, start: calendarUtc(startDate), end: calendarUtc(endDate), tentative: /予定|未定/.test(value) };
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
    ?? (weight ? rizinDivisionForKilograms(weight) : undefined);
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
  const urls = [...new Set(events.flatMap((event) => {
    const frozen = rizinStartDate(event) <= now;
    return [...event.bouts, ...event.cancelledBouts].flatMap((bout) => {
      const hasSnapshot = Boolean(bout.red.record || bout.red.birthDate || bout.red.countryCode || bout.blue.record || bout.blue.birthDate || bout.blue.countryCode);
      return frozen && hasSnapshot ? [] : [bout.red.profileUrl, bout.blue.profileUrl];
    });
  }).filter((url): url is string => Boolean(url)))];
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
    const frozen = rizinStartDate(event) <= now;
    for (const bout of [...event.bouts, ...event.cancelledBouts]) {
      for (const fighter of [bout.red, bout.blue]) {
        const profile = fighter.profileUrl ? store.profiles[fighter.profileUrl] : undefined;
        // The cached romanised name is part of the frozen event-time identity.
        if (profile?.name) fighter.name = profile.name;
        if (frozen && (fighter.record || fighter.birthDate || fighter.countryCode)) continue;
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

export function mergeRizinEvents(storedEvents: RizinEvent[], currentEvents: RizinEvent[], now = new Date()): RizinEvent[] {
  const retainedStoredEvents = retainEventHistory(storedEvents, rizinStartDate, now);
  const merged = new Map(retainedStoredEvents.map((event) => [event.uid, event]));
  for (const current of retainEventHistory(currentEvents, rizinStartDate, now)) {
    const stored = merged.get(current.uid) ?? (() => {
      const candidates = retainedStoredEvents.filter((event) =>
        normalizedName(event.summary) === normalizedName(current.summary)
        && Math.abs(new Date(`${event.date}T00:00:00Z`).valueOf() - new Date(`${current.date}T00:00:00Z`).valueOf()) <= 14 * 24 * 60 * 60 * 1000
      );
      return candidates.length === 1 ? candidates[0] : undefined;
    })();
    const uid = stored?.uid ?? current.uid;
    const frozen = Boolean(stored && rizinStartDate(stored) <= now);
    const storedByKey = new Map((stored?.bouts ?? []).map((bout) => [boutKey(bout), bout]));
    const usableCurrentBouts = current.bouts.length ? current.bouts : (stored?.bouts ?? []);
    const bouts = usableCurrentBouts.map((bout) => {
      const known = storedByKey.get(boutKey(bout));
      if (!known) return bout;
      if (!frozen) return { ...known, ...bout, red: { ...known.red, ...bout.red }, blue: { ...known.blue, ...bout.blue } };
      return {
        ...bout,
        details: known.details || bout.details,
        red: { ...bout.red, ...known.red, name: known.red.name, profileUrl: bout.red.profileUrl ?? known.red.profileUrl },
        blue: { ...bout.blue, ...known.blue, name: known.blue.name, profileUrl: bout.blue.profileUrl ?? known.blue.profileUrl },
      };
    });
    const currentKeys = new Set(bouts.map(boutKey));
    const removed = current.bouts.length
      ? (stored?.bouts ?? []).filter((bout) => !currentKeys.has(boutKey(bout))).map((bout) => ({ ...bout, note: "Removed from the official RIZIN card" }))
      : [];
    const cancelledByKey = new Map([...(stored?.cancelledBouts ?? []), ...removed, ...current.cancelledBouts].map((bout) => [boutKey(bout), bout]));
    merged.set(uid, {
      ...stored,
      ...current,
      cardUrl: current.cardUrl ?? stored?.cardUrl,
      uid,
      bouts,
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
