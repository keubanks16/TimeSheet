# Time Sheet

Phone-friendly hourly tracking app. Log each day's description, hours, miles and a note, then export an Excel workbook laid out exactly like the original **HOURLY TRACKING** spreadsheet.

**Live app:** https://keubanks16.github.io/TimeSheet/

## Features

- Months as tabs; each month shows hours, miles and mileage $ totals
- Add / edit / delete daily entries (date, description, hours, miles, note)
- One-tap mileage presets (Dodge SP 148, Wilcox SP 168, McEver 74, Rutledge SP 88) — editable in Settings
- Note chips for the G column (Flyover, PTO, Holiday)
- Description shortcuts: one-tap individual tasks, plus project-number + task chips that combine (tap **GDC171F**, then **OAC** → "GDC171F OAC"); all three lists editable in Settings
- **Export to Excel** — all months stacked on one sheet, or a single month:
  - merged bold title row `<Name> HOURLY TRACKING <Month>`
  - columns B–G: Date (`m/d/yy`), Description, Hours, Miles, `=rate*Miles`, Note
  - two blank bordered rows, then a `TOTAL` row with `SUM()` formulas
  - same column widths and borders as the original workbook
- **Import** a backup `.json` or an `.xlsx` in this layout (including the original workbook) — months are merged, duplicates skipped
- Data is saved on the device (localStorage); use *Settings → Save backup* to keep a copy
- No dependencies, works offline, single `index.html`

## Hosting

Static site — GitHub Pages serves `index.html` from the `main` branch root.
