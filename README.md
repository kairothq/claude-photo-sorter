# Claude photo sorter

Point Claude at your camera roll. It looks at every photo and video, sorts them into folders, finds your duplicates, and plays it all back on a live dashboard you can screen-record.

![The dashboard sorting a camera roll](docs/preview.gif)

<sub>The demo above uses drawn placeholder images, not real photos.</sub>

- **Sorts photos and videos** into folders like Selfies, Food, Travel, Screenshots, Talking heads, Screen recordings. You choose the folders, or let Claude suggest ones that fit your library.
- **Finds duplicates**: identical copies, burst shots and re-saved screenshots go to a `_Review` folder with a list of what was kept.
- **Never touches your originals.** It only reads them and makes sorted copies. On a Mac the copies take no extra space.
- **Runs on your computer.** Your photos are not uploaded anywhere (unless you choose the optional Jev model, which only gets small previews).
- **A dashboard on localhost** with the animation, folder editing, a photo browser and one-click Finder links.

## Never used Claude Code? Start here

You need a Mac (Windows and Linux work too, with fewer conveniences), a Claude plan, and about 10 minutes.

**1. Install Claude Code.** Follow the one-line install at [claude.com/claude-code](https://claude.com/claude-code), then open the **Terminal** app (press `⌘ Space`, type *Terminal*, press Enter).

**2. Download this project.** Paste these lines into Terminal and press Enter:

```bash
cd ~/Desktop
git clone https://github.com/kairothq/claude-photo-sorter.git
cd claude-photo-sorter
claude
```

<sub>No git? Click the green **Code** button on this page, choose **Download ZIP**, unzip it on your Desktop, then type `cd ~/Desktop/claude-photo-sorter-main` and `claude` in Terminal.</sub>

**3. Say this to Claude:**

```
sort my photos
```

That's it. Claude reads the instructions in this repo and walks you through the rest, asking one question at a time:

1. Shows you a demo first, if you want.
2. Asks where your photos are and helps you export them from Google Photos or Apple Photos.
3. Scans them and finds the duplicates.
4. **Asks how you want them sorted**: the standard folders, folders it suggests after looking at your photos, or your own list.
5. Labels every photo and video.
6. Builds the sorted folders next to your originals.
7. Opens the dashboard at `http://127.0.0.1:8765`.

Works with other coding agents too (Codex, Cursor, Gemini CLI): they read `AGENTS.md`.

## The dashboard

| | |
|---|---|
| **Sort with Claude** | Plays the sort: every thumbnail flies from the sphere into its folder. Press space to start, `R` to reset. Add `?d=20` to the address for a slower take, `?auto` to start by itself. |
| **Show result** | Skips the animation. |
| **Click a folder** | Browse everything in it. Click a photo to see it full size, use the arrow keys to flip through, and **Move to** to fix a wrong one. |
| **Edit folders** | Add, rename or delete folders and describe what goes in each. |
| **Steps** | Run every step from buttons: pick your photos folder with the Finder picker, scan, find duplicates, pick where to save, build folders. Shows a live log. The **Advanced** tab has the 200-file sample and Jev. |
| **Open sorted folder** | Opens the result in Finder. |

Light, dark and system themes. Want to see it without your photos? Run `./start.sh --demo`.

## Choosing your folders

Folders live in `categories.json`. Edit them on the dashboard, ask Claude, or change the file:

```json
{"key": "food", "kind": "photo", "label": "Food & drinks", "emoji": "🍜", "rule": "meals, snacks, drinks, cafes, the food is the subject"}
```

The `rule` is what the model reads, so write it like you'd explain it to a friend. `kind` is `photo` or `video`. Videos only go into video folders.

## Claude or Jev?

| | Claude | Jev (optional) |
|---|---|---|
| What | Claude Code looks at contact sheets of 30 previews at a time | [TypeSafe's](https://typesafe.ai) Jev 1.14 image model, one question per file |
| Cost | Included in your Claude plan | Billed per file, about 980 tokens each. The dashboard shows an estimate and asks first |
| Speed | About a minute per 1,000 files with parallel agents | About 75 seconds per 1,000 files |
| Setup | Nothing | Put `JEV_KEY=your-key` in a `.env` file in this folder |

Use both and the tool keeps Jev's answer when it's at least 70% sure, otherwise Claude's. On a test library of 1,136 files, the two agreed on 78% of files, and on 89% where Jev was confident.

## Privacy

- The dashboard server only listens on `127.0.0.1`, so nothing on your network can reach it.
- Previews, labels and the file list stay in `dashboard/data/` and `work/`, which git ignores.
- With Claude, previews are seen by Claude the same way as anything else you share in Claude Code.
- With Jev, a 280px preview of each file is sent to TypeSafe's API. Originals never leave your computer.

## Running it by hand

```bash
./setup.sh                                                   # once
.venv/bin/python scripts/scan.py "~/Pictures/Export" --limit 200
.venv/bin/python scripts/dupes.py
.venv/bin/python scripts/sheets.py                           # contact sheets for Claude
.venv/bin/python scripts/label_jev.py --estimate             # or label with Jev
.venv/bin/python scripts/apply.py "~/Pictures/Export (sorted)"
./start.sh                                                   # http://127.0.0.1:8765
```

Needs Python 3.9+ and, for video previews, ffmpeg (`brew install ffmpeg`).

## What's inside

```
CLAUDE.md          step-by-step instructions the agent follows
categories.json    your folders
scripts/           scan, duplicates, contact sheets, Jev, build folders, the local server, demo data
dashboard/         the localhost app (plain HTML, CSS and JS, no build step)
```

## License

MIT
