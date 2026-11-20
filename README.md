<p align="center">
  <img src="images/hero.jpg" alt="A terminal, a folder of servers, a cloud and a key" width="100%">
</p>

<h1 align="center">SSH Config Manager</h1>

<p align="center">
  Your SSH hosts in one tidy panel inside VS Code: folders, search, one-click connect, backups and sync —<br>
  all stored as comments <b>inside your normal SSH config file</b>.
</p>

<p align="center">
  <a href="https://vrxt.github.io/ssh-config-manager/"><b>Website</b></a> ·
  <a href="https://marketplace.visualstudio.com/items?itemName=vrxt.ssh-config-manager">VS Code Marketplace</a> ·
  <a href="https://open-vsx.org/extension/vrxt/ssh-config-manager">Open VSX</a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=vrxt.ssh-config-manager"><img src="https://vsmarketplacebadges.dev/version-short/vrxt.ssh-config-manager.svg?label=Marketplace&color=1f6feb" alt="Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=vrxt.ssh-config-manager"><img src="https://vsmarketplacebadges.dev/installs-short/vrxt.ssh-config-manager.svg?label=installs&color=1f6feb" alt="Marketplace installs"></a>
  <a href="https://open-vsx.org/extension/vrxt/ssh-config-manager"><img src="https://img.shields.io/open-vsx/v/vrxt/ssh-config-manager?label=Open%20VSX&color=a60ee5" alt="Open VSX version"></a>
  <a href="https://open-vsx.org/extension/vrxt/ssh-config-manager"><img src="https://img.shields.io/open-vsx/dt/vrxt/ssh-config-manager?label=downloads&color=a60ee5" alt="Open VSX downloads"></a>
  <a href="https://github.com/VRXT/ssh-config-manager/actions/workflows/ci.yml"><img src="https://github.com/VRXT/ssh-config-manager/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
</p>

![The Hosts panel next to the config file it writes](images/overview.png)

The file stays the single source of truth. Everything the panel adds is a `#@…` comment line that
OpenSSH ignores, so `ssh`, Remote-SSH and every other tool keep working exactly as before.

## What you get

- **A home page** that opens when you start the editor: every host one click away, favorites and recent ones first
- **Folders and subfolders** for your hosts, with icons, colors, tags, notes and favorites
- **Search** as you type, plus one-click filters by tag, provider and folder
- **Connect** in a terminal or through Remote-SSH, straight into a folder on the server if you like
- **A tidy Remote-SSH list**: VS Code's own "Connect to Host" list gets the same folders, with headings and gaps
- **Backups** next to the config file before every change, with one-click restore
- **Sync** between your computers through a file in Dropbox, iCloud Drive or OneDrive
- **SSH key help**: see which hosts need a key that is not on this computer, and set one up in one step
- **Server status**: a small green or red dot on every host's icon shows whether the server is up right now
- **Test Connection**: when a host will not connect, a checklist shows which step fails and how to fix it
- **Keyboard shortcuts** for almost everything, shown in the menus
- **A setup wizard** on first run and a **settings page** you can open any time

## Get started in a minute

Install **SSH Config Manager** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vrxt.ssh-config-manager)
(or `ext install vrxt.ssh-config-manager`). In Cursor, VSCodium, Windsurf and other VS Code builds, install it from
[Open VSX](https://open-vsx.org/extension/vrxt/ssh-config-manager): search for it in the editor's Extensions view.
The setup wizard opens the first time and walks through everything, one screen at a time. Every step
is optional, and you can run it again whenever you like: **⋯ → Setup Wizard** in the Hosts panel.

![The setup wizard: numbered steps on the left, one topic per screen](images/wizard.png)

Your existing `~/.ssh/config` is listed right away. Nothing is converted, and nothing is written until
you change something. Prefer VS Code's own checklist? The same steps are on the **Get Started** page
(**SSH Manager: Open the Get Started Guide**).

## Folders

A folder holds hosts and subfolders, like in Finder or Explorer: a folder per project or customer,
subfolders such as *Production* and *Staging* inside.

<img src="images/tree.png" width="420" align="right" alt="Host tree with a tooltip showing note, folder, tags, provider and ProxyJump">

- **New Folder** / **New Subfolder** from the toolbar or the right-click menu
- **Drag a host** onto a folder to move it, or onto another host to place it next to it
- **Rename, move, color, icon** on any folder; **Enable / Disable** hides a whole folder from `ssh` without deleting it
- **Hover a host** for its note, folder, tags, provider and jump host
- **Provider detection**: LAN, Tailscale, AWS, Hetzner, DigitalOcean, Azure, Google Cloud, OVH, …
- Hosts from `Include`d files are listed read-only

<br clear="right">

### Search and filter

<img src="images/search.png" width="420" align="right" alt="Search panel with the Home Lab folder and #backup tag selected">

The **Search** panel sits above the host list:

- Type to filter instantly. Every word must match somewhere: name, HostName, User, Port,
  IdentityFile, ProxyJump or any other option, tags, note, folder or provider.
- Click tags, providers and folders to narrow the list. Several picks in one row mean *any of them*;
  picks in different rows must *all* match.
- Folders open automatically while a search is on, and go back to how you left them when you clear it.

<br clear="right">

### Edit hosts in a form

HostName, User, Port, several IdentityFiles, ProxyJump, a remote folder, and any raw extra options.
Only that host's lines are rewritten; every other line of the file is kept byte for byte.

![Host editor form](images/edit-host.png)

## SSH Home: your hosts when the editor opens

A home page with every host one click away. It opens by itself when you start the editor in a window
with no folder and no file open, which is the moment you are about to go somewhere.

![SSH Home: favorites and recent hosts first, then every folder, with a status dot on each host](images/home.png)

- **Favorites** and the hosts you **connected to last** come first, then every folder with its subfolders
- Each host shows its address, provider, tags and its **up / down dot**
- The **search box has the focus**: type a name, address, tag, folder or provider and press **Enter**
- **One click connects.** The other ways (terminal, this window, new window) show when you point at a
  host, next to a **star** to make it a favorite and a **pencil** to edit it
- Click **up** or **down** in the banner to see only those hosts; click a folder's name to fold it away
  (the page remembers which ones)

| Key | |
|---|---|
| Type anywhere | Search |
| `Enter` | After a search: connect to the first result. On a host: connect to it |
| `Ctrl+Enter` / `Cmd+Enter` | Connect in a terminal instead |
| Arrow keys | Move between hosts |
| `/` | Back to the search box |
| `Esc` | Clear the search and the up / down filter |

**Make it yours** in **Settings → Home page**: when it opens (no folder open, every window, or never),
what a click does, a compact size with one line per host, the banner on or off, and how many recent
hosts to show. It never opens by itself in a window that is already connected to a server.

Open it any time with **SSH Manager: Home** in the Command Palette, or **⋯ → Home** in the Hosts panel.

## Connect your way

Connect in a terminal, or open the host in this / a new window through Remote-SSH: from the buttons on
the row, the right-click menu, `Enter`, or the quick picker (`Cmd+Alt+S` on macOS, `Ctrl+Alt+S`
elsewhere, or the **SSH** button in the status bar).

![Quick connect picker grouped by folder](images/quick-connect.png)

The list keeps your folders and each icon's color, and shows the same small status dot as the Hosts
panel: green for up, red for down, yellow on a folder with a mix.

**Not only in Microsoft's VS Code.** Opening a host in a window uses whichever SSH extension your
editor has: *Remote - SSH* in VS Code, Cursor's own in Cursor, *Open Remote - SSH* in VSCodium and
other builds. If none is installed, you are told which one to get. Connecting in a terminal needs
nothing extra.

**Open a folder directly.** Give a host a *remote folder* such as `/var/www/html` (in the edit form, or
right-click → **Set Remote Folder…**). **Open in Window** then opens that folder on the server instead
of an empty window, and **Connect in Terminal** starts the shell there.

## A tidy Remote-SSH list

VS Code's own **Remote-SSH: Connect to Host** list shows every host in one long row and cannot be
themed. SSH Config Manager gives it the same structure as the panel: a heading for every folder and
subfolder, a blank row between folders, and your favorites on top.

![Settings page for the Remote-SSH list, with a live preview](images/remote-list.png)

It is **on by default** as soon as you have folders, and you are told the first time it is applied.
The rows are harmless extra `Host` lines in the config file; one switch in **Settings → Remote-SSH list**
(or **SSH Manager: Format Remote-SSH Host List…**) removes them again.

## Backups and restore

Before every change, a copy of the config is saved in a folder right next to it:

```
~/.ssh/config
~/.ssh/ssh-config-backups/config-2026-11-18_21-05-33.bak
```

- **Restore from Backup…** lists them newest first, lets you compare with the current file, and backs
  up the current file before restoring, so a restore can be undone too
- **Back Up Now** takes one on demand
- The newest 30 are kept (change it in **Settings → Backups**, or `sshManager.backup.keep`)

They are plain copies of the config, so you can also restore one by hand.

![Backups in the settings page](images/backups.png)

## Sync between computers

Use the same hosts on every computer through a file in a folder that Dropbox, iCloud Drive or OneDrive
keeps in sync. Run **SSH Manager: Set Up Sync Between Computers…** (or **Settings → Sync**), pick a
way, pick the file, and do the same on your other computers with the same file.

![Sync settings: off, copy both ways, link, include](images/sync.png)

| Way | What happens | Good to know |
|---|---|---|
| **Copy both ways** (recommended) | Your config stays a normal local file. Every change is copied to the shared file, and changes from your other computers are copied back, with a backup first. | Works on macOS, Windows and Linux, and offline. If both sides changed, you choose which to keep; the other is saved as a backup. |
| **Link to the shared file** | Your config becomes a symbolic link to the shared file. One real file. | Windows needs Developer Mode or administrator rights for links. |
| **Include the shared file** | `~/.ssh/config` keeps one `Include "<shared file>"` line and the extension edits the shared file. | Anything else you put in `~/.ssh/config` stays on that computer only. |

Turning sync off always leaves the computer with a complete, normal config of its own.

> **Your SSH keys are never synced.** Only the config file is shared. For safety, private keys stay on
> each computer: copy them to your other computers yourself (to the same path the config uses, for
> example `~/.ssh`), or make a new key there with **Set Up SSH Key…**.

## SSH keys

**Check SSH Keys on This Computer** lists the hosts whose key file is not here (a host with several
`IdentityFile` lines is fine as long as one of them exists). Those hosts also carry a ⚠ in the panel.

Right-click a host → **Set Up SSH Key…** to fix it in one step:

![Set Up SSH Key picker: generate a new key or use an existing one](images/ssh-key.png)

1. **Generate a new key** (ed25519, saved in `~/.ssh`, optional passphrase) or **pick an existing one**.
2. The key is added to the host as `IdentityFile`.
3. A terminal opens and copies the public key to the server's `~/.ssh/authorized_keys`. Type the
   server password there once; after that the host logs in with the key.

It goes through `ssh <host>`, so `User`, `Port`, `ProxyJump` and the rest of the config apply, and it
always runs on your computer, also from a window that is connected to a remote.

## Server status: up or down

<img src="images/status.png" width="320" align="right" alt="Host and folder icons with a small status dot: green for up, red for down, yellow for a folder with both">

A small dot on every host's icon shows whether the server answers right now: green = up,
red = down, a grey ring = not checked. The green dot pulses softly and the red one blinks (switch
the animation off in the settings if you prefer a still dot). A folder gets a dot too: green when
all its hosts are up, red when all are down, **yellow when some are up and some are down**. It also shows how many of its hosts are down, and the tooltip of a host tells how
it was checked, how long the answer took and when.

Choose how to check in **Settings → Server status**:

| Check | A server is up when… | Good to know |
|---|---|---|
| **SSH port** (default) | something answers on the host's SSH port | No login is made. Works for almost every server. |
| **Ping** | the host answers a ping | Many cloud servers block ping and would show as down. |
| **Web address** | `https://<HostName>/` answers | Any answer except a 5xx error counts as up. |
| **Off** | | No dots, nothing is checked. |

- **One host, another way**: right-click a host → **Set Status Check…** to give it its own check,
  for example a health URL such as `https://example.com/health`, or no check at all
- **Refresh** in the Hosts panel checks everything again; right-click a host → **Check Server Status
  Now** checks just that one
- Checks repeat every 5 minutes (1 min, 15 min, or only on Refresh), and only while the Hosts panel
  is visible
- Hosts behind a jump host (`ProxyJump`) cannot be reached from your computer directly, so they stay
  grey unless you give them a web address

A red dot says *that* a server is down. For *why*, use **Test Connection…** below.

<br clear="right">

## When a host will not connect

Right-click a host → **Test Connection…**. A checklist runs the steps `ssh` takes, in order, and
stops guessing for you:

| Step | What it checks |
|---|---|
| **Read the ssh config** | What `ssh` will really use for this host: address, user, port, keys |
| **Find the server** | The name resolves to an address |
| **Reach the SSH port** | Something answers on the port (firewall, VPN, wrong port) |
| **Check the key file** | The key exists, is private (not readable by others), and whether it has a passphrase |
| **Check the SSH agent** | Which keys the agent holds |
| **Check the server's identity** | The server is known, or its stored key has changed |
| **Log in with a key** | One real login attempt, without asking for a password |

Each problem is explained in plain words with the fix next to it: **Make the Key Private**,
**Set Up SSH Key…**, **Add Key to Agent**, **Use Only This Host’s Key** (for "too many authentication
failures"), **Forget the Old Host Key…** (after a warning about what a changed server key can mean), or
**Edit Host**. After a fix the test runs again by itself.

**Copy Report** puts the result on the clipboard as text, handy for a colleague or a support ticket.
It contains host names and file paths, never keys or passwords.

The test uses your own `ssh` program, makes one connection attempt, never asks for or stores a
password, and changes nothing unless you press a fix button.

## Settings

Every option on one page: **⋯ → Settings** in the Hosts panel, or **SSH Manager: Open Settings**.

![The settings page](images/settings.png)

Most choices are saved inside the config file itself (the `#@ssh-manager` line), so they follow the
file to your other computers. A few belong to the computer and live in VS Code's settings:

| Setting | Default | |
|---|---|---|
| `sshManager.configFile` | `~/.ssh/config` | The SSH config file to manage |
| `sshManager.backup.keep` | `30` | How many backups to keep |
| `sshManager.sync.mode` | `off` | `off`, `copy`, `link` or `include` (set it with the sync setup, not by hand) |
| `sshManager.sync.file` | | The shared file in your synced folder |
| `sshManager.startPage.open` | `emptyWindow` | When the home page opens by itself: `emptyWindow`, `always` or `never` |
| `sshManager.startPage.click` | `panel` | What a click on the home page does: `panel` (same as the Hosts panel), `newWindow`, `window` or `terminal` |
| `sshManager.startPage.density` | `comfortable` | `comfortable` or `compact` (one line per host) |
| `sshManager.startPage.banner` | `true` | The picture and totals at the top of the home page |
| `sshManager.startPage.recent` | `8` | How many recent hosts the home page shows: `0`, `4`, `8` or `12` |

## Keyboard shortcuts

The same shortcuts work on **Windows, Linux and macOS**: `Ctrl` on Windows and Linux, `⌘` on a Mac.
Click the Hosts list once, then:

| Windows / Linux | macOS | Action |
|---|---|---|
| `Ctrl+Alt+S` | `⌘⌥S` | Connect to a host **from anywhere** |
| `Enter` | `↩` | Connect to the selected host |
| `Ctrl+Enter` | `⌘↩` | Open in a new window (Remote-SSH) |
| `Alt+Enter` | `⌥↩` | Connect in a terminal |
| `Ctrl+C` | `⌘C` | Copy the ssh command |
| `Ctrl+N` | `⌘N` | New host |
| `Ctrl+Shift+N` | `⌘⇧N` | New folder |
| `F2` | `F2` | Edit the selected host / rename the selected folder |
| `Ctrl+Shift+D` | `⌘⇧D` | Duplicate the selected host |
| `Ctrl+D` | `⌘D` | Add to / remove from favorites |
| `Alt+↑` `Alt+↓` | `⌥↑` `⌥↓` | Move up / down |
| `Del` | `⌘⌫` | Delete the selected host or (empty) folder |
| `Ctrl+F` | `⌘F` | Search hosts |
| `Ctrl+,` | `⌘,` | Open settings |

They are also shown next to each action in the right-click menu, and listed in **Settings → Shortcuts**,
where **Customize in VS Code…** lets you change them.

The menus and the settings page show the keys for the system you are on. The two pictures below were
taken on a Mac; on Windows and Linux the same places show `Ctrl`, `Alt` and `Del`.

<p>
  <img src="images/context-menu.png" width="49%" alt="Right-click menu of a host, with the shortcuts">
  <img src="images/shortcuts.png" width="49%" alt="Shortcuts in the settings page">
</p>

## The comment format

```sshconfig
#@ssh-manager sort=name click=terminal

#@group "My Project" icon=cloud color=blue
#@section Hetzner

#@host icon=database color=green tags=prod,db fav=1 note="Main DB, internal 10.0.0.2"
Host HOST-db01
    HostName 203.0.113.10
    User root
```

| Line | Meaning |
|---|---|
| `#@ssh-manager k=v …` | Settings: `sort` (`file`/`name`), `click` (`none`/`terminal`/`window`/`newWindow`/`edit`), `favorites` (`on`/`off`), `autoicon` (`on`/`off`), `remote-picker` (`on`/`off`), `remote-subfolders` (`dashes`/`arrow`/`off`), `remote-favorites` (`on`/`off`) |
| `#@group NAME [icon= color=]` | Starts a folder; runs until the next folder. Quote names with spaces. |
| `#@section NAME [icon= color=]` | Starts a subfolder inside the current folder |
| `#@host k=v …` | Must sit directly above a `Host` line: `icon`, `color`, `tags`, `note`, `fav`, `provider`, `folder` (the remote folder) |

### Disabled hosts and folders

**Enable / Disable** on a host or a folder comments its lines out behind `#@off `, so neither `ssh`
nor the Remote-SSH list sees them, while the panel still lists them (greyed, "disabled"):

```sshconfig
#@off Host HOST-old
#@off     HostName 203.0.113.99
```

Enabling strips the prefix again and restores the lines exactly.

### What the Remote-SSH formatting writes

Remote-SSH lists `Host` names one per row, so the structure is written as extra `Host` lines whose
names start with an invisible character (the panel never shows them as hosts):

- a blank row above each folder (`Host <invisible name>`)
- a `-----------NAME-----------` heading for each folder made in the panel, and a `--- NAME ---`
  heading for each subfolder
- with favorites on top: a generated `#@favorites-begin … #@favorites-end` block holding
  `Host ★name` copies of your starred hosts. It is rebuilt after every change; do not edit it by hand.

When you open the config in the editor, VS Code's highlighting of invisible characters is switched off
for SSH config files so these rows are not boxed in yellow.

### Hand-written layouts are understood as they are

No conversion needed. These are read as folders / subfolders:

```sshconfig
# ======================================================================
# PROJECT 1 - APEX                     <- banner = folder
# ======================================================================
# --- HETZNER HOSTS ---                <- subfolder
Host -----------APEX-----------        <- separator host = folder name (hidden from the host list)
    HostName 0.0.0.0
```

A banner followed by a separator host is one folder, named after the separator. Giving such a folder
a color or icon adds one `#@group` line above it; nothing else is rewritten.

## Develop

```bash
npm install
npm test          # all tests; add a path to also check a real config: node test/parser.test.js ~/.ssh/config
npm run package   # builds the .vsix
```

Press `F5` in VS Code to run it in an Extension Development Host.

Issues and pull requests are welcome at
[github.com/VRXT/ssh-config-manager](https://github.com/VRXT/ssh-config-manager/issues).

## License

[MIT](LICENSE) © Mushari Alshqar

The host icons with a status dot are drawn from the shapes of
[Codicons](https://github.com/microsoft/vscode-codicons) © Microsoft Corporation, licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
