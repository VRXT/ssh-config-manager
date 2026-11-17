# Changelog

## Unreleased

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
