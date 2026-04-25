> [!note]
> This plugin was created entirely with AI tools

# Wrapped Line Indentation

Indent wrapped lines in Joplin’s Markdown editor so list items, task items, block quotes, and indented paragraphs stay visually aligned when they wrap.

## What it does

Without this plugin, a long Markdown line wraps back to the start of the editor line. With this plugin, wrapped continuation lines align after the Markdown prefix.

Examples handled:

- Bullet lists
- Numbered lists
- Task lists
- Nested block quotes
- Lists inside block quotes
- Plain indented paragraphs

The plugin skips fenced and indented code blocks.

## Requirements

- Joplin 3.3 or newer
- Markdown editor using CodeMirror 6

## Installation

Install from Joplin’s plugin manager once published, or install the `.jpl` file manually:

1. Download `com.bwat47.joplin-wrapped-line-indent.jpl` from the latest release.
2. In Joplin, open `Tools > Options > Plugins`.
3. Select `Install from file`.
4. Restart Joplin if prompted.

## Notes

This plugin changes editor display only. It does not modify note content.

## Development

```bash
npm test
npm run lint
npm run dist

```
