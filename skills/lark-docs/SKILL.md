---
name: lark-docs
description: Use when the user wants documentation in Lark Suite / Feishu — "publish this to lark docs", "search our lark wiki", "read that feishu doc", "share the doc" — including publishing project/release notes as Lark documents.
---

# lark-docs — documentation in Lark Suite

Uses the `lark` MCP server's doc tools (preset.doc.default): `docx.builtin.search`,
`docx.v1.document.rawContent`, `docx.builtin.import`, `wiki.v1.node.search`,
`wiki.v2.space.getNode`, `drive.v1.permissionMember.create`.
Not connected → run the lark-setup skill.

## Find & read
- Docs: `docx.builtin.search` → `docx.v1.document.rawContent` for full text.
- Wiki: `wiki.v1.node.search` → `wiki.v2.space.getNode` → the node's document
  via rawContent.

## Publish (markdown → Lark doc)
`docx.builtin.import` converts markdown into a new Lark doc — write the
content as clean markdown first (headings, tables, lists all survive). Good
for: release notes (jira-release output), project status/roadmap summaries,
runbooks, meeting summaries. Report the returned doc URL.

## Share
`drive.v1.permissionMember.create` to grant a user/chat access to the doc —
ask who should see it before granting; default to view-only.

## Caveats (upstream beta)
- **No in-place editing**: to "update" a doc, import a new version and share
  that (or the user edits manually). State this instead of faking an update.
- No file upload/download — text/markdown content only.
- Updates are one-shot imports; for living status pages prefer Confluence via
  jira-sync, and use Lark docs for point-in-time publishes.
