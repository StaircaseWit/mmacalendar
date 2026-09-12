import { decimalOdds, formatCheckDate } from "./utils.js";
import type { OddsStore } from "./types.js";

function htmlEscape(value: unknown = ""): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function renderOddsPage(store: OddsStore): string {
  const rows = Object.entries(store.fights ?? {}).flatMap(([fight, history]) =>
    history.map((snapshot, index) => {
      const values = Object.entries(snapshot.odds ?? {}).map(([name, odds]) => {
        const decimal = decimalOdds(odds);
        return `${snapshot.names?.[name] ?? name}: ${odds ?? "unavailable"}${decimal ? ` (${decimal})` : ""}`;
      }).join(" / ");
      return `<tr><td>${htmlEscape(fight.replace("::", " — "))}</td><td>${htmlEscape(formatCheckDate(snapshot.checkedAt))}</td><td>${index === 0 ? "Baseline" : "Changed"}</td><td>${htmlEscape(values)}</td></tr>`;
    }),
  ).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>UFC odds history</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:1100px;margin:3rem auto;padding:0 1rem;color:#171717}h1{line-height:1.1}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:.7rem;border-bottom:1px solid #ddd}th{background:#f5f5f5}@media(max-width:700px){table{font-size:13px}}
</style></head><body><h1>UFC odds history</h1><p>Odds are snapshotted no more than once every seven days. A row is added only for the initial value or a change.</p><p>Last checked: ${htmlEscape(store.lastCheckedAt ? formatCheckDate(store.lastCheckedAt) : "not yet")}</p><table><thead><tr><th>Event / fight</th><th>Checked</th><th>Entry</th><th>Odds</th></tr></thead><tbody>${rows || "<tr><td colspan=\"4\">No odds have been recorded yet.</td></tr>"}</tbody></table></body></html>\n`;
}
