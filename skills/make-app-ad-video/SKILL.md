---
name: Make an app-install ad video
description: Procedure for short vertical ads (Reels, TikTok, Snap, Stories) that drive app installs: hook-first storyboard, real-device captures, motion/typo/audio values, safe zones, honest numbers and CTA, review checklist.
when: making or revising a promotional / advertising video for an app (GasSaver or any other)
tags: video, ad, marketing, reels, tiktok, gassaver
---

# Make an app-install ad video (9:16)

Research behind it: gasmobile/.ai-workspace/pub-research/01..04 (OpenMontage rules + Claude x Codex adversarial review, 2026-11-09).

## Steps
1. Recall Mind for prior ad memories (real screens only, overview then zoom, brand color, no invented prices).
2. One message, one concept, one hook. Write a 15 s storyboard second by second: hook 0-1.5 s (tension + text within 0.3 s, NO logo intro), problem 1.5-3 s, real-app proof 3-11 s (gesture -> its real result, overview then zoom), slogan 11-13 s, CTA 13-15 s. Brand present from frame 1 (small logo, brand color); end card <= 2 s.
3. Capture on the real device in a clean demo session. Android recipe (adb): status bar demo mode (settings put global sysui_demo_allowed 1; am broadcast -a com.android.systemui.demo -e command enter/clock hhmm 0941/battery level 100/notifications visible false); mock GPS on a PUBLIC place so the real home location never shows (appops set com.android.shell android:mock_location allow; cmd location providers add-test-provider gps|network|fused; set-test-provider-location <p> --location lat,lng, re-sent every 2 s); screenrecord --bit-rate 20000000; in Git Bash set MSYS_NO_PATHCONV=1 for /sdcard paths. Never keep Profile screens (name, email); mask the avatar. Cut any third-party app (e.g. Google Maps) out of takes. Afterwards remove test providers, appops default, demo exit, restore the user accent. Then: continuous screen recording of each tap AND its real result; note date, build, fuel/data source. No personal data. Never fake a UI or a gesture whose result is not filmed.
4. Animatic first (stills + timing + voice), check on a phone, then animate (HyperFrames HTML/GSAP preferred over frame-by-frame Pillow).
5. Motion rules: visual change every 1.5-2.5 s; key proof held >= 0.7 s; push-in 100->115 % in 0.5-0.65 s; tap ring 70-90 px, pause 0.3-0.5 s before tap, ripple 220 ms; motivated transitions (cut on tap, match cut); easeOutQuart in, easeInCubic out, never linear; never repeat the same camera move twice in a row.
6. Text: hook 64-82 px bold 3-6 words; captions 48-58 px, 2 lines, <= 32 chars/line; master safe zone = Meta Reels (top 14 %, bottom 35 % = 672 px, sides 6 %), then check each platform preview.
7. Numbers: never animate, count down or add a price/saving. Control version shows no headline figure; a figure variant only with a fresh dated capture showing value, unit, fuel and context, small text "Prix au moment de la capture". Legal notes are never spoken.
8. CTA: only claims proven outside the repo config (store listing live, price). Default "Decouvre GasSaver".
9. Audio: voice from 0 s, -16/-14 LUFS, music 12-18 dB under voice, tap < 100 ms, whoosh starts 15 ms before visual, true peak <= -1 dBTP; must work muted.
9b. Third-party brands: blur station names/logos (backdrop-filter mask + neutral label "Station") on every frame; when the UI moves (sheet raise), measure the moving edge per frame at 30 fps from the source take (ffmpeg crop column + threshold) and drive the mask y frame by frame; verify the RENDER at 30 fps (render frame timing differs from source resampling). Prefer showing real continuous motion over crossfades (crossfades leak masked content).
9c. HyperFrames: every <audio>/<video> needs an id (else silent); never put a timed <video> inside a timed wrapper; register paused root timeline; use immediateRender:false on fromTo that must not show before their time; run check + snapshot and read frames; render -q high --video-bitrate 12M --video-frame-format png; then two-pass ffmpeg loudnorm I=-14 TP=-1.5. Generate music/SFX by code (rights owned) and document it in the proof sheet.
10. Deliver: 9:16 1080x1920 H.264/AAC 30 fps + recomposed 4:5/1:1 + thumbnail (real screen + 3-5 words) + proof sheet. A/B: change only one variable (hook OR figure).
11. Review: blocking = hook clear muted in 3 s, real screens/gestures, no invented data, no personal data, exact slogan, safe zones, CTA verified, audio rights. Have Codex review, fix, second pass.
