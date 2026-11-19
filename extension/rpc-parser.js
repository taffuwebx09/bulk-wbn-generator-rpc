const RPC_LIST = "https://hq.delhivery.com/reports/list/";
export function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/gi, "&").replace(/&nbsp;/gi, " ")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}
function textOf(value) {
  return decodeHtml(String(value ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
export function attrOf(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(tag).match(new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3]) : null;
}
export function locateReport(html, expectedRemark) {
  const expected = String(expectedRemark ?? "").trim().replace(/\s+/g, " ");
  if (!expected) throw new Error("Expected RPC remarks are empty.");
  const rows = [...String(html ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const matches = [];
  for (const rowMatch of rows) {
    const rowHtml = rowMatch[1];
    const cellsHtml = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cellsHtml.length < 6) continue;
    const cells = cellsHtml.map(textOf);
    if ((cells[1] || "").trim() !== expected) continue;
    const anchors = [...rowHtml.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)].map((m) => m[0]);
    let downloadUrl = null;
    for (const anchor of anchors) {
      const label = textOf(anchor);
      const href = attrOf(anchor, "href");
      const title = attrOf(anchor, "title") || "";
      const ariaLabel = attrOf(anchor, "aria-label") || "";
      const downloadAttr = attrOf(anchor, "download");
      if (href && (/download/i.test(label) || /download/i.test(href) || /download/i.test(title) || /download/i.test(ariaLabel) || downloadAttr !== null)) {
        const parsed = new URL(href, RPC_LIST);
        const host = parsed.hostname.toLowerCase();
        if (parsed.protocol !== "https:" || !(host === "hq.delhivery.com" || host.endsWith(".delhivery.com") || host.endsWith(".amazonaws.com"))) {
          throw new Error("RPC report contained an unexpected download URL host.");
        }
        downloadUrl = parsed.href;
        break;
      }
    }
    matches.push({
      reportId: (cells[0] || "").trim(), remarks: cells[1], date: cells[2],
      count: cells[3], type: cells[4], status: (cells[5] || "").trim().toLowerCase(),
      downloadUrl, cells
    });
  }
  if (matches.length > 1) throw new Error(`More than one RPC report has exact remarks "${expected}". Refusing ambiguous match.`);
  return matches[0] || null;
}
