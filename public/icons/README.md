# App icons

This folder holds the raster icons the judge PWA manifest and iOS need. They are
not committed yet.

| File                   | Size    | Purpose                                     |
| ---------------------- | ------- | ------------------------------------------- |
| `icon-192.png`         | 192×192 | Android home screen (`purpose: any`)        |
| `icon-512.png`         | 512×512 | Android splash and install prompt           |
| `icon-maskable.png`    | 512×512 | Android adaptive icon (`purpose: maskable`) |
| `apple-touch-icon.png` | 180×180 | iOS "Add to Home Screen"                    |

Source mark: `/public/favicon.svg` (a white "D" on navy `#0a2540`). Export the
PNGs from that file with 12% safe padding for the maskable variant. Do not add a
brand logo here without written permission from the organisation that owns it
(see `docs/QUESTIONS-FOR-IAN.md`, question 14).
