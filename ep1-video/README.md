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

`assets/output/episode1_v4.mp4` — closest to final, use as base for tweaks

## Key rules
- Work from `episode1_v4.mp4` as the base — make targeted slice edits, never full rebuilds
- Crab has WHITE background → colorkey=color=white:similarity=0.28:blend=0.08
- Questions: Q1 at t=3–7.5, Q2 at t=9–13, Q3 at t=14.5–18.5, Q4 at t=20.5–27
- Font: `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`
- Save working segments before overwriting — never lose a good cut
