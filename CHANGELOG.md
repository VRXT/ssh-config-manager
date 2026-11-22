# Changelog

## 0.8.3

For a config file in OneDrive, iCloud Drive, Dropbox or another synced folder:

- "Cannot read … EINTR: interrupted system call" no longer appears when the sync app is busy with
  the file for a moment: the read is tried again by itself
- If the file still cannot be read, your hosts stay on screen instead of the list going empty, and
  the extension keeps trying until the file is back
- The message now says in plain words what is wrong and what to do (the sync app is not running, the
  file is not downloaded, the editor has no permission, …), with **Try Again** and **Show Details**
- New: **SSH Manager: Show Log** (also under **⋯** in the Hosts panel) shows what went wrong, with the
  real location of a linked file and the system's own message, ready to copy into a bug report

## 0.8.2

- Home page: a host with a color of its own is now tinted in that color, in place of the stripe on its left edge

## 0.8.1

Fixes for the home page:

- Pressing Enter on the freshly opened page no longer connects to the first favorite. Enter in the
  search box connects only after you searched for something
- A folder you just folded or unfolded could spring back when a status check finished at the same moment
- Opening a file from outside (double-clicking it, `code notes.txt`) no longer gets the home page on
  top of it. The page opens by itself only in a window with no folder and no file
- Changelog tidied: notes about how releases are made are no longer listed here

## 0.8.0

**New**

- **SSH Home**: a home page with every host one click away. Favorites and the hosts you connected to
  last come first (with how long ago), then each folder with its subfolders, and the up / down dot on
  every host. The search box has the focus: type a name, address, tag, folder or provider and press
  Enter. Point at a host for the other ways to connect, a star to make it a favorite and a pencil to
  edit it. Click **up** or **down** in the banner to see only those hosts, and a folder's name to fold
  it away. Arrow keys move between hosts, Ctrl/Cmd+Enter opens a terminal, `/` goes back to the search
- The home page **opens by itself when the editor starts** in a window with no folder open. Open it
  any time with **SSH Manager: Home** or from the Hosts panel's **⋯** menu
- **Settings → Home page**: when it opens, what a click does, a compact size with one line per host,
  the banner on or off, how many recent hosts to show, and a button to forget them. Also as
  `sshManager.startPage.*` settings. The setup wizard has a step for it
- New illustrations for the home page

**Lighter**

- The download is about a third smaller: the illustrations are saved smaller with no visible
  difference, and a picture no screen used is gone
- A status check recolors the dots on the home page in place instead of drawing the list again, and
  the page uses no memory while its tab is in the background

## 0.7.1

- **Quick connect** list: the big emoji dots are gone. Each row keeps its place in the folder tree and
  shows the host's or folder's icon in its own color, with the same small status dot as the Hosts
  panel (drawn with the extension's own color icon font). Folders also count the hosts that are down

## 0.7.0

- **Server status**: a small animated dot on every host's icon shows whether the server is up (green,
  pulsing) or down (red, blinking). Folders get a dot too (green, red, or yellow for a mix), and
  folders count the hosts that are down. Check by SSH port (default, no login), ping, or a web
  address; set it for all hosts in **Settings → Server status** or per host with **Set Status
  Check…**. **Refresh** checks again, and checks repeat every 5 minutes while the panel is visible.
  Turn it off with `sshManager.health.check: off`
- **Test Connection…** on any host: a checklist of the steps `ssh` takes (config, name lookup, port,
  key file, agent, server identity, login) that shows which one fails, why, and the fix next to it:
  make the key private, set up a key, add it to the agent, use only this key, forget a changed
  server key, or edit the host. **Copy Report** gives the result as text, without keys or passwords

## 0.6.2

- **Works in Cursor, VSCodium and other VS Code builds.** Opening a host in a window no longer
  requires Microsoft's Remote - SSH: Cursor's own SSH extension and Open Remote - SSH are used when
  they are the one installed. If none is, the message names the right one for the editor you are in
- The release workflow can also publish to **Open VSX**, the extension store of those editors

## 0.6.1

- README: working Marketplace badges, and the Windows / Linux shortcuts listed first

## 0.6.0

**New**

- **Setup wizard** on first run: folders, the Remote-SSH list, backups, sync, keys and shortcuts, one
  screen at a time, with Back / Continue. Run it again any time from **⋯ → Setup Wizard**
- **Settings page** (**⋯ → Settings**): every option on one page with switches, option cards and a live
  preview of the Remote-SSH list. It replaces the old pick-list settings
- **Get Started guide** on VS Code's own Welcome page, with the same steps as a checklist
- **Sync between computers** through a file in Dropbox, iCloud Drive or OneDrive, three ways to choose
  from: copy both ways (recommended), link to the shared file, or include the shared file. SSH keys are
  never synced, and the setup says so
- **Backups next to the config file** (`ssh-config-backups/`), with **Restore from Backup…**,
  **Back Up Now**, compare before restoring, and a setting for how many to keep (default 30).
  Older backups from VS Code's own storage are still listed
- **Check SSH Keys on This Computer**: lists the hosts whose key file is not here; they also carry a ⚠
  in the panel
- **Keyboard shortcuts** for the Hosts panel: Enter to connect, F2 to edit or rename, new host / folder,
  favorite, duplicate, delete, search, settings. They show next to each action in the right-click menu
- New illustrations for the wizard, the settings page and the README

**Changed**

- **Folders everywhere**: groups and sub-groups are now called folders and subfolders in every menu,
  form and message, and look alike. The file format is unchanged (`#@group`, `#@section`)
- **The Remote-SSH list is formatted by default.** Folders made in the panel now get a heading and a
  blank row in VS Code's own "Connect to Host" list (before, only hand-written `Host -----NAME-----`
  separators did, so a new user's list stayed one flat list). It switches on with your first change
  once you have folders, tells you, and can be turned off in **Settings → Remote-SSH list**
- Commands run from the keyboard or the Command Palette act on the selected host or folder
- `sshManager.configFile` is now a per-computer setting, so Settings Sync no longer carries one
  computer's path to another
- When the config is open in the editor, the invisible characters of the formatting rows are no
  longer boxed in yellow

**Fixed**

- **Format Remote-SSH Host List…** could report "on" while nothing was written yet

## 0.5.2

- Fix: a new sub-folder did not show until it had hosts, so it looked like it was not created and got
  added twice. Sub-folders made with Add Sub-group now always show, and duplicate names are refused
- **Remote folder** per host (`folder=` on the `#@host` line, set in the form or with *Set Remote Folder…*):
  Open in Window goes straight into that folder on the server, and Connect in Terminal starts there

## 0.5.1

- Host and group colors show in the Connect picker as a colored dot (VS Code cannot color icons there)

## 0.5.0

- **Search panel** above the host list: filters as you type and matches every option (IdentityFile,
  ProxyJump, Port, …), notes, tags, groups and providers
- **Filter chips** for tags, providers and groups (any of the picks in a row, all rows together)
- Folders open automatically while searching
- **Set Up SSH Key…** on a host: generate a new ed25519 key or pick an existing one, add it as
  `IdentityFile`, and copy it to the server's `authorized_keys` in a terminal
- The **SSH** status-bar button is created first at startup with a fixed id, so it always shows,
  and can be hidden from the status bar's right-click menu

## 0.4.1 — first public release

- Side-bar tree of hosts by group and sub-group, with icons, colors, tags, notes and favorites
- Add / edit hosts in a form; duplicate, move, reorder (drag & drop or Alt+↑/↓), delete
- Connect in a terminal, or in this / a new window through Remote-SSH
- Quick connect picker (`Cmd+Alt+S` / `Ctrl+Alt+S`) and a status-bar button
- Enable / disable hosts and whole groups without deleting them (`#@off`)
- Provider detection (LAN, Tailscale, AWS, Hetzner, DigitalOcean, …)
- Remote-SSH picker extras: favorites block and spacer rows between projects
- Hand-written layouts (banners, `Host -----NAME-----` separators) read as groups as they are
- Hosts from `Include`d files listed read-only
- A timestamped backup (last 20) before every write
