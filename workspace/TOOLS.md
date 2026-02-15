# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH

- home-server → 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Shell Commands (Windows)

- **NO `grep`** → Use `Select-String -Path <file> -Pattern <pattern>`
- **NO `head`** → Use `Select-Object -First N`
- **NO `tail`** → Use `Select-Object -Last N`
- **NO `cat`** → Use `Get-Content <file>`
- **NO `ls`** → Use `Get-ChildItem` or `dir`
- **NO `find`** → Use `Get-ChildItem -Recurse -Filter <pattern>`
- **NO `&&`** → Use `;` to chain commands (e.g., `cd dir; git add .; git commit`)
- This is Windows/PowerShell. Linux commands don't exist here.

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
