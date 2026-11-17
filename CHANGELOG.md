# Changelog

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
