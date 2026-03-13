import type React from "react";
import { createElement, Fragment } from "react";

export function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|`([^`]+)`|\*(.+?)\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[2]) parts.push(createElement("strong", { key: match.index, className: "font-semibold text-dash-text" }, match[2]));
    else if (match[3]) parts.push(createElement("code", { key: match.index, className: "bg-dash-surface-2 text-dash-blue px-1 py-0.5 rounded text-[10px]" }, match[3]));
    else if (match[4]) parts.push(createElement("em", { key: match.index }, match[4]));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length === 1 ? parts[0] : createElement(Fragment, null, ...parts);
}

export function renderMarkdown(md: string): React.ReactNode[] {
  const lines = md.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const sizes = ["text-sm font-bold", "text-xs font-bold", "text-[11px] font-semibold", "text-[11px] font-semibold text-dash-text-dim"];
      nodes.push(createElement("div", { key: i, className: `${sizes[level - 1]} mt-2 mb-1` }, renderInline(headingMatch[2])));
      i++; continue;
    }
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1]?.match(/^\|[\s\-:|]+\|$/)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) { tableLines.push(lines[i]); i++; }
      const parseRow = (l: string) => l.split("|").slice(1, -1).map(c => c.trim());
      const headers = parseRow(tableLines[0]);
      const rows = tableLines.slice(2).map(parseRow);
      nodes.push(
        createElement("div", { key: `table-${i}`, className: "overflow-x-auto my-1" },
          createElement("table", { className: "w-full text-[10px] border-collapse" },
            createElement("thead", null,
              createElement("tr", null, headers.map((h, hi) =>
                createElement("th", { key: hi, className: "text-left px-2 py-1 border-b border-dash-border font-semibold text-dash-text-dim" }, renderInline(h))
              ))
            ),
            createElement("tbody", null, rows.map((row, ri) =>
              createElement("tr", { key: ri }, row.map((cell, ci) =>
                createElement("td", { key: ci, className: "px-2 py-1 border-b border-dash-border text-dash-text-dim" }, renderInline(cell))
              ))
            ))
          )
        )
      );
      continue;
    }
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (ulMatch) {
      const indent = Math.floor(ulMatch[1].length / 2);
      nodes.push(createElement("div", { key: i, className: "flex gap-1.5", style: { paddingLeft: `${indent * 12}px` } },
        createElement("span", { className: "text-dash-text-muted shrink-0" }, "\u2022"),
        createElement("span", null, renderInline(ulMatch[2]))
      ));
      i++; continue;
    }
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch) {
      const indent = Math.floor(olMatch[1].length / 2);
      const numMatch = line.match(/^(\s*)(\d+)\./);
      nodes.push(createElement("div", { key: i, className: "flex gap-1.5", style: { paddingLeft: `${indent * 12}px` } },
        createElement("span", { className: "text-dash-text-muted shrink-0" }, `${numMatch?.[2]}.`),
        createElement("span", null, renderInline(olMatch[2]))
      ));
      i++; continue;
    }
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      nodes.push(createElement("pre", { key: `code-${i}`, className: "bg-dash-surface-2 rounded p-2 text-[10px] text-dash-text-dim overflow-x-auto my-1" }, codeLines.join("\n")));
      continue;
    }
    if (line.trim() === "") { nodes.push(createElement("div", { key: i, className: "h-1.5" })); i++; continue; }
    nodes.push(createElement("div", { key: i, className: "leading-relaxed" }, renderInline(line)));
    i++;
  }
  return nodes;
}
