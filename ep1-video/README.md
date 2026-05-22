# Still Afloat — Episode 1 Video

## v15 TODO (next session)

### Problems in v14 to fix:
1. **Box artifact in intro** — a visible rectangular box appears in the beach background during the intro. Was not present before. Likely from the `fps=30` re-encode of `intro_biglogo.mp4` or the delogo region on the original. Screenshot saved: `attached_assets/image_1779422293635.png`. Need to diagnose against `still_afloat_intro_locked.mp4` source and find a clean path.
2. **Storm sequence is double** — v14 has 9 new clips (72s, no captions) followed by `storm_outro_xfade_v3.mp4` (33s, has "What if I choose wrong?" captions). Feels like two storms looped. User wants ONE clean storm sequence.
3. **Preferred ending** — user likes clip 8 (`Sailor_at_helm_ship_sunlight` — sun breaking through the storm on the ship) as the LAST storm clip, then a direct crossfade to beach. This is the "last scene in the first" he refers to. Clip 9 (calm ocean) may not be needed.
4. **Soundtrack is wrong** — needs revisiting. Review which music plays when.
5. **Transitions are poor** — hard cuts between clips are jarring. Need crossfades or dissolves between storm clips.

### v15 plan (draft):
- Fix intro: use `still_afloat_intro_locked.mp4` directly without fps conversion, or find source of box
- Storm: use clips 1–8 only (end on sunlight), with dissolve transitions between clips
- End storm on clip 8 (sunlight), crossfade directly to beach (from `storm_outro_xfade_v3.mp4` or rebuild)
- Drop or move clip 9 (calm ocean) — may work better before the beach reveal
- Drop "What if I choose wrong?" outro OR keep it but make it feel like one continuous sequence
- Fix audio: review music timing and volumes

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

`assets/output/episode1_v14.mp4` — **2:07.5 (127.5s)** — v14 with 9 Veo storm clips, clean Veo blur, no baked text

### v14 structure
| t= | Section | Source |
|---|---|---|
| 0–22.5s | Still Afloat intro (beach, Mark, logo) | `still_afloat_intro_locked.mp4` |
| 22.5–30.5s | Night ocean with dramatic lightning | `storm_raw/Stormy_ocean_at_night_lightning_…mp4` |
| 30.5–38.5s | Wide tall ship in storm (side view) | `storm_raw/Sailing_ship_in_storm_…(1)_…mp4` |
| 38.5–46.5s | Ship in heavy rain with sailor | `storm_raw/Sailing_ship_in_storm_2309_…mp4` |
| 46.5–54.5s | Sailor at helm, lightning behind | `storm_raw/Sailing_ship_in_storm_2310_…mp4` |
| 54.5–62.5s | Sailor gripping wheel, dark storm | `storm_raw/Sailor_at_helm_storm_2309_…mp4` |
| 62.5–70.5s | Sailor at helm, dark night | `storm_raw/Sailor_at_helm_storm_2310_…mp4` |
| 70.5–78.5s | Lightning climax (most dramatic) | `storm_raw/Sailor_controlling_ship_storm_…mp4` |
| 78.5–86.5s | Light breaking through — hope | `storm_raw/Sailor_at_helm_ship_sunlight_…mp4` |
| 86.5–94.5s | Calm golden ocean after storm | `storm_raw/Open_ocean_after_storm_…mp4` |
| 94.5–127.5s | Crossfade storm→beach + "What if I choose wrong?" | `storm_outro_xfade_v3.mp4` |

### v14 audio mix
- Still Afloat Intro music: 0–22.5s (vol 1.0)
- Black Gale Passage (ominous): 22.5–94.5s (vol 0.55), under storm native audio
- Storm native audio: 22.5–94.5s (vol 0.45)
- Salt on My Boots: 94.5–127.5s (vol 1.0)

### v14 source clips
9 Veo-generated clips in `assets/video_segments/storm_raw/` — all 8s, 1920×1080, 24fps (normalized to 30fps)
Veo watermark blurred with `boxblur=15:5` over region x=1700 y=1000 w=220 h=80
No text baked into any of the 9 storm clips. "What if I choose wrong?" is in `storm_outro_xfade_v3.mp4` (intentional).

---

## Previous output

### v10 structure (archived)
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
