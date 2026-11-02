# Notes and tables in CoDev (replace Google Docs and Sheets)

CoDev's agents read and write an **Obsidian vault**: a folder of Markdown notes, in
place of Google Docs. The same folder holds your **data tables** as CSV, TSV or JSON
files, in place of Google Sheets. It's all plain files, so you edit the notes in
[Obsidian](https://obsidian.md) (free) and the tables in Excel, LibreOffice, Obsidian
or any text editor, and nothing is locked into one company's format.

Agents can search, read, create and edit notes and tables. Creating and editing is
off until you turn it on, and CoDev shows you every change and asks before saving it.

## Set it up

1. Make (or pick) your vault folder.
   - **In MEGA (works on your computer and phone):** with MEGAsync, make a folder
     like `C:\Users\<you>\MEGA\Obsidian` and open it in Obsidian as a vault
     (Obsidian > Open folder as vault). MEGAsync keeps it in your MEGA cloud drive
     as `/Obsidian`. You can also let CoDev make the folder when it saves the first
     note.
   - **In your project folder (computer only):** use a folder inside the folder you
     connected with 📁, like `notes`.
2. In CoDev, open **Settings > Notes & tables**. Pick where the vault is and type its
   folder (`/Obsidian` in MEGA, or `notes` in the project folder).
3. To let agents create and edit, tick **Let agents create and edit notes and
   tables**. For a vault in MEGA, also turn on saving in **Settings > MEGA cloud**
   (see [mega-cloud.md](mega-cloud.md)) and sign in there first.

## The tools

| Tool | What it does |
| --- | --- |
| `notes_status` | Says where the vault is, how many notes and tables it has, and whether editing is on. |
| `notes_search` | Finds notes by words in the name or text, or by `#tag`, or lists the newest notes. With kind `tables`, lists the CSV, TSV and JSON tables. |
| `notes_read` | Reads a note by path (`Projects/Ideas.md`) or by name (`Ideas`), like a `[[link]]` finds it, with its tags, the notes it links to and the notes that link to it. |
| `notes_write` | Creates a note, adds to one (at the end or under a heading), changes one exact piece of text, or rewrites it. Asks first. |
| `table_read` | Reads a table and does exact math over every row: filters, sorting, count/sum/average/median/min/max, totals per group, text search. |
| `table_write` | Creates or rewrites a table, adds rows, changes the rows that match a filter, deletes rows, or adds a column. CSV stays CSV and JSON stays JSON. Asks first. |

Examples to ask for:

- "Find my notes tagged #todo and make a list of what's left."
- "Add 'Rooftops' under Levels in my Game ideas note."
- "Make a note for today's meeting and link it to [[Continuum]]."
- "What's the average points in Data/players.csv for players on DEN?"
- "Add a row for Edwards, MIN, 27 to my players table, and mark Tatum as hit."

## What's different from Google Docs and Sheets

- Notes are Markdown: headings, lists, `[[links]]`, `#tags` and properties between
  `---` lines at the top. Obsidian shows them formatted and draws the links as a graph.
- Tables are one sheet per file, with no formulas. Ask an agent for the numbers
  (`table_read` does the math), or make a real Excel workbook with formulas with
  `create_spreadsheet`.
- JSON tables are a list of objects (`[{"player": "Jokic", "points": 31}]`), or an
  object holding one such list (`{"picks": [...]}`). The rest of the file is kept as
  it was. Numbers and true/false stay numbers and true/false.
- A text search reads the newest 400 notes. In a bigger vault, narrow it with a
  folder or a tag.
- Folders starting with a dot (`.obsidian`, `.trash`) are left alone.

## Safety

- Editing is off until you turn it on, and every change shows you a preview (the
  new note, the added text, or the old and new text) before CoDev saves it.
- An edited note or table in MEGA is saved as a new version, and the old one goes to
  MEGA's Rubbish Bin, so you can restore it from mega.nz.
- In the project folder, files are written in place. Use Obsidian's File recovery
  core plugin or git if you want history.
