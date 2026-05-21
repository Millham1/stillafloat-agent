# Still Afloat — Episode 1 Video

Standalone video project for the Still Afloat vlog Episode 1.

## Source assets (`assets/`)

| File | Description |
|---|---|
| `assets/Episode_one_complete_1779304998957.mov` | Raw MOV source — storm/captain footage, clean (no baked-in text) t=12–39 is the usable storm window |
| `assets/still_afloat_transparent_1779153464830.png` | Still Afloat logo, transparent background |
| `assets/my_image_whole_body_transparent_1779307512033.png` | Mark full-body cutout, transparent background |
| `assets/transparent_crab_1779312493250.mp4` | Animated crab walk cycle — WHITE background, use colorkey=white to remove |
| `assets/Still_Afloat_Intro_1779309407911.mp3` | Intro music |
| `assets/Black_Gale_Passage_1779313251666.mp3` | Ominous/storm music |
| `assets/Salt_On_My_Boots_1779325209535.mp3` | Outro music |

## Saved segments (`assets/video_segments/`)

| File | Duration | Description |
|---|---|---|
| `beach_reveal_v3.mp4` | 17.7s | Intro with face-camera crab (older version) |
| `beach_outro.mp4` | 7.0s | Beach sunrise "Your First Steps!" outro |
| `part_storm_questions.mp4` | 25.0s | Storm Q1–Q4 |
| `part_storm_questions_q4ext.mp4` | 28.0s | Storm Q1–Q4 with Q4 extended 3s |
| `storm_outro_xfade_v3.mp4` | 33.0s | Storm + beach outro crossfade |

## Current best output

`assets/output/episode1_v10.mp4` — **74.6s** — v10 with rebuilt storm section

### v10 structure
| t= | Section |
|---|---|
| 0–22.7s | Locked intro (beach + crab + logo + Mark, fades to black) |
| 22.7–26.2s | Pure black (ominous starts at t=23.7) |
| 26.2–32.5s | Storm clip 1 (captain close, fades in from black, 6.3s, +storm native audio) |
| 32.5–38.1s | Storm clip 2 (dark waves/lightning, 5.6s, +storm native audio) |
| 38.1–45.1s | Storm clip 3 (captain wider/rigging, 7.0s) |
| 45.1–59.1s | Storm clip 4 (TALL SHIP, **14s — doubled**) |
| 59.1–69.6s | Storm clip 5 (big lightning "choose wrong", 10.5s → dissolves to sunset) |
| 67.6–69.6s | Xfade: storm dissolves to sunrise (ominous fades, Salt fades in) |
| 69.6–74.6s | Beach sunrise — "Your First Steps!" |

### v10 audio mix
- Still Afloat Intro: t=0, fade out t=18 (d=2s), vol=0.7
- Ominous (Black_Gale_Passage): starts t=23.7, fade out at stream t=41.3 (d=5s), vol=0.8
- MOV storm native audio t=12-24: starts t=26.2, fade in 0.5s, fade out at stream t=10 (d=2s), vol=0.35
- Salt on My Boots: starts t=67.6 (xfade), fade in 3s, vol=0.7

## Key rules
- Locked intro is FROZEN: `assets/output/still_afloat_intro_locked.mp4` — never rebuild
- Storm clips sourced from `video_segments/part_storm_questions_q4ext.mp4` via trim+setpts (vsync 0)
- Storm native audio from `Episode_one_complete_1779304998957.mov` t=12–24s
- Crab has WHITE background → colorkey=color=white:similarity=0.28:blend=0.08
- Questions: Q1 at t=3–7.5, Q2 at t=9–13, Q3 at t=14.5–18.5, Q4 at t=20.5–27 (in q4ext timeline)
- Font: `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`
- Save working segments before overwriting — never lose a good cut
- setpts slow-motion requires: trim filter + setpts=N*PTS + `-vsync 0` (otherwise encoder ignores stretch)
