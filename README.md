# Lyric Pilot

A local lyric follower that aligns noisy transcription with known song slides and a planned arrangement. Develop and test on Ubuntu; connect real ProPresenter when a Windows/macOS instance becomes available.

The follower includes deterministic fuzzy matching, section/occurrence tracking, improvised repeats and jumps, rolling interim/final transcripts, confidence/stability policy, manual override, recorded-audio transcription, replay benchmarks and a terminal simulator. Audio inference uses local whisper.cpp. It requires no API keys and uploads no audio.

**AUTO currently changes simulated output only.** The follower cannot send commands to real ProPresenter. The separate integration spike remains available for explicit manual API testing. Actual singing recognition is still weak on the tested CPU models; see [measured results](docs/benchmarks.md).

## Try the follower

Requires Node.js 24.12+ and npm. Text simulation requires no audio software or model downloads.

```sh
npm ci
npm run demo
npm start
```

The demo benchmarks eight scenarios: normal progression, extra chorus, skipped chorus, jump to bridge, return to verse, noisy text, vocal dropout and human correction. Reports and timeline SVGs are written to `artifacts/follower/`.

The live view highlights **TRANSCRIPT** (what the follower heard) and **DISPLAYED** (the current simulated slide), with bold cyan and green text in a terminal. Tracking, scores and decision details are hidden by default; add `--diagnostics` to see them. `--quiet` hides these observations entirely. The `match` command always includes candidate details. Set `NO_COLOR=1` to disable colors.

The terminal console starts in ASSIST. Enter lyric text directly, or use:

```text
mode auto
we lift our voices together
you are with us through the storm
manual s7 4
pause
resume
status
quit
```

`partial u1 <text>` and `final u1 <corrected text>` revise the same utterance. `manual <slide-id> [zero-based-arrangement-step]` re-anchors tracking, clears pending evidence and applies a two-second grace period. `next`/`previous` simulate manual physical navigation. `tick 1000` advances simulated time when experimenting quickly. Use `help` for commands. Unexpected jumps require sustained evidence; one typed phrase may wait for another observation.

```sh
npm run follow -- match "you will lead us safley home" --current s3
npm run follow -- replay extra-chorus --speed 2 --quiet
npm run follow -- replay data/replays/jump-bridge.json --mode assist
npm run --silent follow -- demo --json
```

ASSIST updates tracking and suggestions while holding the simulated display. MANUAL holds both. AUTO applies eligible simulated transitions. Pause, input loss and mode changes require fresh evidence before following resumes. Scores are inspectable heuristics, not calibrated probabilities.

The matcher gives common English connector words such as “and” and “in” less weight than content words. A clearly leading expected slide can advance on three distinct, exactly recognized content words despite connector errors; off-plan jumps retain their temporal checks. `--diagnostics` includes the winning phrase and its exact content words.

## Recorded audio and microphone

Install FFmpeg, Git, CMake and a C++ compiler if absent. Build the pinned whisper.cpp release and download the small English model:

```sh
npm run setup:whisper
npm run fixtures:audio -- jump-bridge
npm run follow -- audio artifacts/synthetic-audio/jump-bridge/performance.wav \
  --mode auto \
  --truth artifacts/synthetic-audio/jump-bridge/ground-truth.json \
  --output artifacts/my-audio-test
```

The generated clip is **spoken original lyrics**, not singing. It provides a reproducible audio-to-matcher smoke test. The model receives audio without a supplied lyric prompt. `--play` plays the file with ffplay and implies `--realtime`; otherwise processing is accelerated and silent. These remain causal rolling-window tests: the model never receives later samples.

Try a real public-domain singing example:

```sh
npm run fixtures:singing
npm run follow -- audio artifacts/singing-example/first-verse.wav \
  --song data/songs/amazing-grace-first-verse/song.json --mode auto \
  --truth artifacts/singing-example/ground-truth.json \
  --output artifacts/my-singing-test
```

This downloads the US Marine Band's “Amazing Grace,” verifies the published SHA-1 and extracts a 45-second first-verse excerpt. Source and independent caption timing references are recorded beside the audio. [Source and rights notices](https://commons.wikimedia.org/wiki/File:Amazing_Grace_US_Marine_Band.ogg).

For your own song, create JSON following [the synthetic song](data/songs/synthetic-test/song.json), supply `--song`, and override order with `--arrangement "V1 -> C -> V2 -> C -> B -> C"`. Then:

```sh
npm run follow -- audio /path/to/recording.wav --song /path/to/song.json
npm run follow -- transcribe /path/to/recording.mp3 --song /path/to/song.json
npm run follow -- listen --device default --song /path/to/song.json
```

`listen` explicitly captures a PulseAudio source on Ubuntu; actual microphone hardware has not been tested here. Audio commands print observations; interactive manual/mode controls are currently in the text console. Ctrl+C stops capture. No raw microphone recording is retained; temporary inference WAVs are deleted. Transcripts, logs and reports remain under the chosen local output directory.

Audio settings: `--window-ms` defaults to 5000 and `--step-ms` to 1500. Decoder time and backlog are included in observation timestamps, even in accelerated runs. If inference falls behind, stale words expire and output holds. Larger windows/models are experiments, not guaranteed improvements:

```sh
npm run setup:whisper -- base.en
WHISPER_MODEL=.local/whisper.cpp/models/ggml-base.en.bin npm run follow -- audio /path/to/audio.wav
```

English `tiny.en` is the default. Select a multilingual model and `WHISPER_LANGUAGE` for other languages. Settings are listed in [.env.example](.env.example).

## Fixed-plan word tracking (experimental)

`--planned` follows the supplied arrangement word by word using a local, music-trained CTC acoustic model. The model produces letter probabilities from audio; an online alignment follows the current slide and its planned successor. The diagnostic transcript is not used to select slides. This mode does not automatically handle improvisations or jump to other sections.

```sh
npm run setup:ctc
npm run follow -- audio /path/to/recording.wav --planned \
  --song /path/to/song.json --mode auto --play
npm run follow -- listen --planned --song /path/to/song.json --mode auto
```

The terminal colors supported words green, uncertain words amber and pending words dim. `FOLLOWING` reports supported word count and the next anticipated word. Passing an unrecognized word does not label it as heard. A successor needs two supported words, including a content word. Overlapping windows can revise uncommitted word evidence; committed words' audio intervals are retired, so the same sound cannot satisfy a repeat twice. AUTO output remains simulated; ASSIST holds the displayed slide and MANUAL holds tracking.

The planned mode uses 1.5-second windows updated every 0.5 seconds. This is a separate backend from Whisper, whose defaults remain 5 seconds / 1.5 seconds. Both can be overridden with `--window-ms` and `--step-ms`. Planned diagnostics show per-word acoustic support, which is a heuristic rather than a calibrated word probability.

For the supplied first two minutes of “What A Beautiful Name,” a realtime-paced test follows all 11 transitions with a 1.918s median delay and 81.9% correct displayed time. Slower held notes can need more context; `--window-ms 6000 --step-ms 2000` completes all three transitions in the separate “Amazing Grace” excerpt, with greater delay. See [the measured comparisons and limits](docs/benchmarks.md#fixed-plan-acoustic-following--2026-11-06).

This backend requires Python 3 with venv support. Setup installs pinned NumPy, CPU PyTorch and Transformers versions into `.local/guided-ctc/venv/` and downloads the revision-pinned 2.33 GB [music-lyrics CTC model](https://huggingface.co/mrfakename/w2v-bert-2.0-music-lyrics-ctc) (MIT). It verifies the model SHA-256. Linear layers use dynamic int8 quantization on CPU. English letter probabilities retain their original values when projected from the multilingual vocabulary. The encoder receives no lyric prompt, ground-truth timestamps or future audio. Actual microphone hardware remains untested.

For the smaller speech-trained experiment, run `npm run setup:ctc -- small` and add `--acoustic-model small`. That downloads a 95 MB [ONNX model](https://huggingface.co/Xenova/wav2vec2-base-960h); it is less reliable on this singing recording. `--acoustic-model music` explicitly selects the default music model. `CTC_PYTHON`, `CTC_MODEL` and `CTC_VOCAB` can override the local paths when no profile is explicitly selected.

Runs save `report.json`, `timeline.svg` and `guided-replay.json` containing the acoustic observations. Slide ranking metrics are unmeasured (`null`) because this mode does not rank slide candidates. Ground truth is read after inference, solely for evaluation. The user's first-two-minute annotations are saved in [this JSON](data/ground-truth/what-a-beautiful-name-first-two-minutes.json).

Re-run following against saved acoustic probabilities, retaining the measured availability times and without loading a model:

```sh
npm run follow -- replay artifacts/my-planned-test/guided-replay.json --planned \
  --song /path/to/song.json --truth /path/to/ground-truth.json --quiet
```

## Replay and evaluate

Each audio run exports `transcript-replay.json`, `report.json` and `timeline.svg`. Replay preserves the transcript window and measured availability times, isolating the matcher from transcription variability:

```sh
npm run follow -- replay artifacts/my-audio-test/transcript-replay.json \
  --output artifacts/replayed --quiet
```

Custom replay JSON contains `name`, `description`, `durationMs`, ordered `events`, `groundTruth`, and optional `transcriptWindowMs`/`evaluationDurationMs`. Transcript events have utterance ID, acoustic start/end, availability `atMs`, text and final status. Ground truth is a separate `[{"atMs":0,"slideId":"s1"}, ...]` timeline and never enters matching. Audio runs evaluate only the recording duration; late decode responses remain visible on the timeline. See [fixtures](data/replays/normal.json).

Reports distinguish candidate ranking, time on the correct slide, missed/false transitions, and median/p95 transition latency. Recognition delay remains visible. Published-caption ground truth is approximate, not a production projection cue benchmark.

## Real ProPresenter later

```sh
npm run presenter
npm run demo:presenter
npm run cli -- status
```

The isolated HTTP adapter, API explorer and eight-slide mock are retained. No installed ProPresenter version is verified yet. Use [the setup/acceptance procedure](docs/propresenter-setup.md) and [installed-version profile guide](docs/api-profiles.md) when a machine is available. Real endpoint paths and ports remain unconfigured. Explicit real controls require `npm run presenter -- --allow-control` and a verified profile.

## Development

```sh
npm run check
npm run fixtures:transcripts
```

Tests cover matching, occurrence tracking, deviations, manual override, silence, pause/modes, transcript revisions, causal audio windows, latency/backlog, captured-ASR replay, FFmpeg pipeline integration, CLI exports and the original HTTP adapter. Tests do not download models or contact external services. FFmpeg integration tests skip when FFmpeg is absent.

Source is separated into `song/`, `lyrics/`, `decision/`, `follower/`, `audio/`, `transcription/`, `replay/`, and `propresenter/`. Runtime TypeScript uses Node's built-in stripping; only TypeScript and Node types are npm development dependencies. `.local/`, `artifacts/`, audio, local profiles, logs and `.env` are ignored by Git.

Next accuracy work: compare transcription models and windowing on varied singing recordings, improve phrase evidence retention, and tune confidence against false transitions and latency. Real ProPresenter acceptance and rehearsal validation remain outstanding. The [project brief](propresenter-ai-lyric-follower-project-brief.md) contains the full roadmap.
