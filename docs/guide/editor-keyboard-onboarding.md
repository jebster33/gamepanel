# File editor, keyboard and getting started

## Editing several files at once

Open a file from a server's **Files** tab and it opens in the editor panel. Open another and it becomes a second tab. A dot on a tab means that file has changes you have not saved.

- **Save** (Ctrl/Cmd+S) saves the file you are in. **Save all** (Ctrl/Cmd+Shift+S) saves every file with a dot. Broken JSON or YAML is flagged before it is saved.
- **Split** shows two files side by side. Click in a pane, then a tab, to choose what that pane shows. The same file in both panes stays in step.
- **Hide** (Esc) puts the editor away but keeps your tabs, so you can browse for another file. A button at the bottom right brings it back.
- Closing a tab or **Close all** with unsaved changes asks whether to save, discard or keep editing.
- The panel remembers which files were open on each server, in this browser only. Next time you open the Files tab it offers to reopen them. Only the names are remembered, never the contents.

## Comparing files and versions

**Compare** (on the Files tab and in the editor) shows two things next to each other with the changed lines highlighted. Each side can be a file as it is on disk, an open file with unsaved edits, or an earlier saved version of a file from the config history. Use it to see what changed since last week, or how two configs differ. Press `n` and `p` to jump between changes.

## Getting started checklist

**Account, then Getting started** lists the usual first jobs: create a server, start it, open its ports, set up backups, turn on two-factor sign-in, invite staff, set up Discord alerts and take the tour. Steps tick themselves when the panel can see they are done; for the others, use **Mark done**. Progress belongs to your account, not the browser. You only see the steps your account can use.

The same card replays the panel tour, a tour of one server's page (from the checklist while on a server page) and a first-server guide for an empty panel. Each server also has a **Tips** button with advice for that game (Rust wipes, ARK clusters, Minecraft crossplay and networks, workshop mods and more).

## Using the panel with only the keyboard

Press **?** anywhere for the full list. The main ones:

| Keys | What it does |
| --- | --- |
| `Ctrl/Cmd+K` | Command palette |
| `/` | Search on the page |
| `n` | New server |
| `g` then `d` `s` `g` `a` `c` ... | Go to Dashboard, Servers, Games, Activity, Account and so on |
| `g` then `h` | Getting started |
| `[` and `]` | Previous and next tab on a server page |
| `i` | Jump to the console command line |
| Arrow keys | Move along tabs, the sidebar and table rows |

Tab moves through everything, and the first Tab stop is a "Skip to content" button. The focused item has a lime outline. Dialogs keep Tab inside them, close with Esc, and give focus back to where you were. Single-key shortcuts pause while you type in a box or have a dialog open. Uploading files has a normal Upload button, so dragging is never required.
