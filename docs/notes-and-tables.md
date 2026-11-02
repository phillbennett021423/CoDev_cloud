# CoDev Notes: notes and tables (replace Google Docs and Sheets)

You write your notes and data tables in CoDev itself, in the **📝 Notes** tab. Notes
take the place of Google Docs, and tables take the place of Google Sheets. Notes are
Markdown and tables are CSV, TSV or JSON files. Everything is plain text, so nothing
is locked into one company's format, and agents can use the same notes.

Agents can search, read, create and edit notes and tables. Creating and editing by
agents is off until you turn it on, and CoDev shows you every change an agent wants
to make and asks before saving it.

Lore for a story or game (characters, factions, places, events) has its own home: a
[Chronicler](https://chronicler.pro) vault, made and read from 🎭 Story Studio's
🧭 World tools. See the README's Story Studio section.

## The 📝 Notes tab

- **＋ Note** and **＋ Table** make a new one. Use a slash in the name for a folder,
  like `Projects/Ideas` or `Data/players`.
- **✏️ Edit** opens the text, and **👁 Read** shows it formatted. **💾 Save** (or Ctrl+S)
  saves it. CoDev asks before you leave a note that has unsaved changes.
- In a note, `[[Another note]]` links to another note. Click a link to open that note,
  or to make it if it doesn't exist yet. Under each note, **Linked from** lists the
  notes that link to it. `#tags` work anywhere in the text or in a `tags:` property.
- A table shows as a grid. Edit it as text: the first line holds the column names.
- Search by words in the name, or type `#tag` to list the notes with that tag.
- 🗑 deletes a note that's kept on this device.

## Where CoDev keeps them

Pick one in **Settings > Notes & tables**:

- **In CoDev on this device** (the default). Nothing to set up. The notes stay in
  this browser or app on this device.
- **In a MEGA folder.** CoDev on your computer and on your phone share the same notes.
  Sign in under **Settings > MEGA cloud** first (see [mega-cloud.md](mega-cloud.md)),
  then type the folder, like `/CoDev Notes`. CoDev makes the folder when it saves the
  first note. With MEGAsync the folder is on your computer as plain files too. Your own
  saves from the 📝 Notes tab only need the sign-in. For agents to save there, also
  turn on saving in Settings > MEGA cloud.
- **In the connected project folder** (computer only). Use a folder inside the folder
  you connected with 📁, like `notes`.

To let agents create and edit, tick **Let agents create and edit notes and tables**.

## The agents' tools

| Tool | What it does |
| --- | --- |
| `notes_status` | Says where the notes are, how many notes and tables there are, and whether agent editing is on. |
| `notes_search` | Finds notes by words in the name or text, or by `#tag`, or lists the newest notes. With kind `tables`, lists the CSV, TSV and JSON tables. |
| `notes_read` | Reads a note by path (`Projects/Ideas.md`) or by name (`Ideas`), the same way a `[[link]]` finds it, with its tags, the notes it links to and the notes that link to it. |
| `notes_write` | Creates a note, adds to one (at the end or under a heading), changes one exact piece of text, or rewrites it. Asks first. |
| `table_read` | Reads a table and does exact math over every row: filters, sorting, count/sum/average/median/min/max, totals per group, and text search. |
| `table_write` | Creates or rewrites a table, adds rows, changes the rows that match a filter, deletes rows, or adds a column. CSV stays CSV and JSON stays JSON. Asks first. |

Examples to ask for:

- "Find my notes tagged #todo and make a list of what's left."
- "Add 'Rooftops' under Levels in my Game ideas note."
- "Make a note for today's meeting and link it to [[Continuum]]."
- "What's the average points in Data/players.csv for players on DEN?"
- "Add a row for Edwards, MIN, 27 to my players table, and mark Tatum as hit."

## How they differ from Google Docs and Sheets

- Notes are Markdown: headings, lists, `[[links]]`, `#tags`, and properties between
  `---` lines at the top.
- Each table is one sheet per file, with no formulas. Ask an agent for the numbers
  (`table_read` does the math), or make a real Excel workbook with formulas with
  `create_spreadsheet`.
- A JSON table is a list of objects (`[{"player": "Jokic", "points": 31}]`), or an
  object holding one such list (`{"picks": [...]}`). The rest of the file is kept as
  it was. Numbers and true/false values stay as numbers and true/false.
- A text search reads the 400 newest notes. In a bigger collection, narrow the search
  with a folder or a tag.
- Folders whose names start with a dot (`.trash`, `.sync`) are left alone.

## Safety

- Agent editing is off until you turn it on. Every change an agent makes shows you a
  preview first (the new note, the added text, or the old and new text) before CoDev
  saves it.
- In MEGA, an edited note or table is saved as a new version, and the old one goes to
  MEGA's Rubbish Bin, so you can restore it from mega.nz.
- Notes kept on this device are lost if you clear CoDev's site data or uninstall the
  app. Keep them in MEGA if you want a copy off the device.
- In the project folder, files are written in place. Use git if you want history.
