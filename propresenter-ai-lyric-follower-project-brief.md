# AI ProPresenter Lyric Follower

**Project brief for a coding agent**  
**Status:** Initial architecture / MVP planning  
**Last reviewed:** 2026-08-16  
**Primary goal:** Build a local application that listens to live worship audio, determines which pre-existing lyric slide in ProPresenter corresponds to what the band is currently singing, and automatically selects that slide. The planned song structure should strongly guide normal progression, while real-time audio must be able to override the plan when the singer or band improvises.

---

## 1. Executive Summary

This project is an **AI-assisted real-time lyric follower for ProPresenter**.

ProPresenter remains the source of truth for:

- the song presentation,
- the lyric slides,
- the visual theme/layout,
- the current live slide,
- and the projector/output.

The new application does **not** replace ProPresenter and does **not** render lyrics itself in the production design.

Instead, the application behaves like an automated projectionist:

1. Read the active ProPresenter song/presentation and its lyric slides.
2. Read or maintain knowledge of the current ProPresenter slide.
3. Receive the intended song structure/order, for example:
   - Verse 1
   - Chorus
   - Verse 2
   - Chorus
   - Chorus
   - Bridge
   - Chorus
4. Listen to a live audio feed from the band.
5. Run streaming speech/singing transcription or equivalent audio-to-text recognition.
6. Compare the recent recognized text against the known lyrics already present in the ProPresenter slides.
7. Give a strong prior/confidence boost to the slide expected next from the planned song structure.
8. Allow sufficiently strong real-time audio evidence to override the planned structure when the worship leader improvises, repeats a section, skips a section, jumps to a bridge, returns to a verse, etc.
9. Trigger the selected pre-existing slide in ProPresenter.
10. Always allow human/manual operation to override the automation.

The central insight is that this is **not primarily a free-form transcription problem**. The lyrics are already known. The real problem is **real-time sequence alignment against a known set of lyric states**.

A useful mental model is:

```text
                    Planned song structure
                            |
                            v
ProPresenter slides --> Lyric follower <-- Live audio/transcription
                            ^
                            |
                  Current ProPresenter state
                            |
                            v
                     Confidence engine
                            |
                            v
                     ProPresenter API
                            |
                            v
                    Select/trigger slide
```

---

## 2. Project Goal

### 2.1 Primary goal

During band practice, and eventually live worship, automatically keep ProPresenter on the correct pre-loaded lyric slide without requiring a projectionist to manually click each lyric slide.

### 2.2 Desired operator experience

Before a song, the operator or band provides the intended arrangement, e.g.:

```text
V1 -> C -> V2 -> C -> C -> B -> C
```

Then the operator enables an `AUTO FOLLOW` mode.

Under normal circumstances, the application should confidently advance along the expected structure.

If the worship leader improvises, for example:

```text
PLANNED:
V2 -> C -> B

ACTUAL:
V2 -> C -> C -> B
```

then the application should recognize the unexpected second chorus from the live audio, follow it, re-anchor its internal state, and continue following the actual performance.

### 2.3 Production philosophy

The application should follow this rule:

> Expect the planned next lyric state, but accept strong contradictory audio evidence when the band goes somewhere else.

The song structure is a **prior**, not a hard rule.

---

## 3. Non-Goals for the First Version

Do not overbuild the first version.

The MVP does **not** need to:

- generate lyric graphics,
- replace ProPresenter,
- identify arbitrary unknown songs,
- search an entire church song library from raw audio,
- understand sermons,
- trigger videos or service items,
- control lighting,
- control the sound desk,
- recognize individual singers,
- perfectly transcribe music,
- use a large language model for every decision,
- operate unattended in a live service from day one.

The first version should solve one narrow problem:

> Given one known ProPresenter song, its lyric slides, a planned structure, and an audio performance of that song, predict the correct current/next slide in real time.

---

## 4. Development Environment

### 4.1 Develop on a personal computer

The project should be developed primarily on the developer's own computer rather than requiring access to the church's production computer.

ProPresenter can be installed locally for development.

As of 2026-08-16, Renewed Vision's official documentation states that an unregistered copy of ProPresenter can be run as a fully functional application, with a watermark appearing on output screens. This is suitable for development/testing where clean public-facing output is not required.

Official reference:

- https://support.renewedvision.com/hc/en-us/articles/360042103673-Registering-ProPresenter-7-Moving-a-seat-from-one-computer-to-another

Renewed Vision also offers a separate 14-day registered trial. Do not rely on the time-limited trial for routine development; save it for later if clean production-like testing is needed.

Official reference:

- https://support.renewedvision.com/hc/en-us/articles/4412269910419-How-to-Request-a-Two-Week-Trial-for-ProPresenter

### 4.2 ProPresenter API

ProPresenter exposes an HTTP-based API, and Renewed Vision also documents a TCP/IP transport that can access a broad subset of that API.

The installed ProPresenter version exposes API documentation from the **Network** area of ProPresenter Settings. The implementation should inspect that local documentation rather than hard-coding assumptions copied from an old internet example.

Official reference:

- https://support.renewedvision.com/hc/en-us/articles/31606866768147-TCP-IP-Connections-with-ProPresenter-API

### 4.3 Important API implementation rule

**Do not assume exact endpoint paths until verified against the installed ProPresenter version.**

The coding agent should first build a tiny API explorer/client and verify that it can:

1. Connect to local ProPresenter.
2. Read current presentation/state information.
3. Read or map current slide information.
4. Access enough presentation/slide metadata to associate lyric text with slide identifiers or indexes.
5. Trigger a known slide or, at minimum, advance to next/previous.
6. Detect changes made manually in ProPresenter so the application can resynchronize.

If the API cannot directly return some required lyric text, the application may need a secondary ingestion path, such as importing/exporting presentation data, but direct API access should be attempted first.

---

## 5. Recommended High-Level Architecture

```text
+------------------------+
|      ProPresenter      |
|                        |
| Existing song slides   |
| Current live slide     |
+-----------+------------+
            ^
            | API read/write
            |
+-----------+------------+
|   ProPresenter Adapter |
+-----------+------------+
            |
            v
+------------------------+
|      Song Model        |
|                        |
| Slides                 |
| Sections               |
| Planned structure      |
| Current state          |
+-----------+------------+
            ^
            |
+-----------+------------+        +----------------------+
|   State / Structure    |<-------| Audio / Transcript   |
|       Engine           |        |      Pipeline        |
+-----------+------------+        +----------+-----------+
            |                                |
            +---------------+----------------+
                            v
                  +---------------------+
                  |   Candidate Matcher |
                  +----------+----------+
                             |
                             v
                  +---------------------+
                  | Confidence / Policy |
                  +----------+----------+
                             |
             +---------------+----------------+
             |                                |
             v                                v
      Assist prediction                 Auto trigger
             |                                |
             +---------------+----------------+
                             v
                       ProPresenter
```

---

## 6. Core Components

### 6.1 `ProPresenterAdapter`

Responsibilities:

- connect to ProPresenter,
- determine connectivity/health,
- read active presentation,
- read current slide,
- retrieve or map slides and lyric text,
- trigger a particular slide,
- optionally advance next/previous,
- observe manual slide changes,
- expose a stable internal interface independent of exact ProPresenter API details.

Suggested internal interface:

```ts
interface ProPresenterAdapter {
  connect(): Promise<void>;
  getActivePresentation(): Promise<PresentationRef | null>;
  getSlides(presentationId: string): Promise<Slide[]>;
  getCurrentSlide(): Promise<SlideRef | null>;
  triggerSlide(slideId: string): Promise<void>;
  onCurrentSlideChanged(handler: (slide: SlideRef) => void): Unsubscribe;
  getHealth(): Promise<ConnectionHealth>;
}
```

Exact method names are illustrative.

### 6.2 `AudioCapture`

Responsibilities:

- capture microphone/audio-interface input,
- select input device,
- normalize sample rate/channel layout as required by the transcription provider,
- maintain a short rolling raw-audio buffer,
- expose timestamps,
- detect loss of input/silence.

Initial audio sources, in order of convenience:

1. Developer speaking/singing into a microphone.
2. Local audio files.
3. Full-mix worship recordings.
4. Commercial/YouTube-derived test audio where lawful and technically appropriate.
5. Source-separated estimated vocal stem.
6. Actual clean church lead-vocal/aux feed.

### 6.3 `Transcriber`

Responsibilities:

- consume live audio,
- emit interim/partial recognition,
- emit stabilized/final recognition,
- include timestamps when available,
- expose provider-specific confidence if available,
- tolerate a rolling stream rather than file-at-a-time transcription.

Important design principle:

**The transcriber does not need perfect sentence transcription.** It only needs enough lexical evidence to align the performance with known lyrics.

### 6.4 `TranscriptBuffer`

Maintain a rolling window, initially around **2-5 seconds**, containing:

- recognized words,
- timing,
- interim/final status,
- recent corrections.

The buffer should allow the transcriber to change an interim phrase before the matcher treats it as stable evidence.

### 6.5 `LyricNormalizer`

Normalize both known slide lyrics and transcription before matching.

Possible normalization:

- lowercase,
- trim whitespace,
- normalize repeated spaces,
- strip punctuation,
- normalize common contractions,
- optionally normalize spelling variants,
- optionally remove non-lyric annotations,
- preserve meaningful words,
- optionally remove extremely common filler words only if experiments show benefit.

Example:

```text
Known:
"All my life, You have been faithful"

Observed:
"all my life youve been faith full"

Normalized representations should remain highly matchable.
```

### 6.6 `LyricMatcher`

Input:

- normalized transcript window,
- all candidate lyric slides/segments,
- current state,
- expected next states.

Output:

- ranked candidates,
- evidence/features for each score,
- not just one opaque answer.

Example:

```json
[
  {
    "slideId": "slide-13",
    "audioScore": 0.94,
    "structureScore": 1.0,
    "proximityScore": 1.0,
    "historyScore": 0.95,
    "finalScore": 0.97
  },
  {
    "slideId": "slide-22",
    "audioScore": 0.92,
    "structureScore": 0.20,
    "proximityScore": 0.10,
    "historyScore": 0.25,
    "finalScore": 0.59
  }
]
```

### 6.7 `SongStructureEngine`

Maintain the planned arrangement and current performance state.

Example planned structure:

```text
V1 -> C -> V2 -> C -> C -> B -> C -> Tag
```

Important: distinguish between a **section type** and a **section occurrence**.

For example:

```text
Chorus occurrence 1
Chorus occurrence 2
Chorus occurrence 3
```

may all use identical lyrics. Audio alone may not distinguish them. The sequence/history model should.

### 6.8 `ConfidenceEngine`

Combine multiple signals into one decision score.

Start simple. Example initial formula:

```text
final_score =
    0.55 * audio_match
  + 0.25 * structure_probability
  + 0.15 * local_position_probability
  + 0.05 * recent_history_probability
```

These weights are only starting hypotheses. They must be tuned from test data.

The system should log the component scores for every decision.

### 6.9 `DecisionPolicy`

A separate policy should decide whether to:

- do nothing,
- show a suggestion,
- or trigger ProPresenter.

Example starting thresholds:

```text
final confidence < 0.70
    => do nothing

0.70 <= confidence < 0.90
    => suggest in ASSIST mode only

confidence >= 0.90
    => eligible for AUTO trigger
```

Do not treat these values as final.

### 6.10 `OperatorUI`

The UI should be diagnostic first, pretty second.

Show at minimum:

- ProPresenter connection status,
- audio input status,
- active song,
- current slide,
- current section,
- expected next slide/section,
- live transcript window,
- top candidate,
- runner-up candidate,
- confidence values,
- operating mode,
- most recent automation action,
- whether a manual ProPresenter change was detected.

Controls:

- `MANUAL`
- `ASSIST`
- `AUTO`
- `PAUSE`
- `RESYNC`
- `PREVIOUS`
- `NEXT`
- optional `FORCE SECTION`
- optional emergency disable/black control only if safe and needed

---

## 7. Recommended Domain Model

A useful starting schema:

```ts
type SectionType =
  | "verse1"
  | "verse2"
  | "verse3"
  | "prechorus"
  | "chorus"
  | "bridge"
  | "tag"
  | "outro"
  | "instrumental"
  | "custom";

interface Slide {
  id: string;
  index: number;
  text: string;
  normalizedText: string;
  sectionId: string;
  sectionType: SectionType;
  sectionSlideIndex: number;
  metadata?: Record<string, unknown>;
}

interface Section {
  id: string;
  type: SectionType;
  label: string;
  slideIds: string[];
}

interface ArrangementStep {
  id: string;
  orderIndex: number;
  sectionId: string;
  sectionType: SectionType;
  occurrence: number;
}

interface Song {
  id: string;
  title: string;
  presentationId: string;
  slides: Slide[];
  sections: Section[];
  plannedArrangement: ArrangementStep[];
}

interface PerformanceState {
  currentSlideId: string | null;
  currentSectionId: string | null;
  arrangementStepId: string | null;
  previousSlideIds: string[];
  lastConfidentTransitionAt: number | null;
  deviationFromPlan: boolean;
}
```

The exact schema should adapt to what ProPresenter exposes.

---

## 8. The Matching Problem

### 8.1 Do not search blindly if you know the local context

If the song has 40 slides and the system is currently on slide 12, slide 13 should normally have much higher prior probability than slide 37.

Candidate search should therefore be hierarchical:

1. Expected next slide(s).
2. Nearby slides in current section.
3. Expected next section.
4. Other structurally plausible repeated sections.
5. Full-song fallback search for improvisation/recovery.

### 8.2 Audio/lyric similarity features

Start with deterministic, inspectable methods:

- token overlap,
- word-level fuzzy similarity,
- edit distance / normalized Levenshtein,
- longest common subsequence,
- n-gram overlap,
- partial-ratio style fuzzy matching,
- weighted matching of uncommon/distinctive words.

Later, optionally test:

- sentence/text embeddings,
- phonetic matching,
- direct audio-to-known-lyric alignment,
- acoustic keyword spotting.

Avoid introducing an LLM into the hot decision path unless testing proves it materially improves outcomes.

### 8.3 Distinctive-word weighting

Not every word is equally informative.

A phrase containing unusual words may identify a slide after only 2-4 words, whereas a phrase such as `you are good` may exist in multiple sections.

Consider an IDF-like weighting calculated over all lyric fragments in the current song:

```text
rare/distinctive token => higher evidence
very common token      => lower evidence
```

### 8.4 Partial-line anticipation

The system must not wait for an entire slide to be sung before switching.

Goal:

- identify the next lyric from the first distinctive words,
- allow enough stability to avoid false switches,
- display the slide early enough for congregational singing.

A transition may be triggered after a stable partial match if:

- the target is structurally expected,
- it is the logical next slide,
- no rival candidate has similar score,
- and the observed words are sufficiently distinctive.

---

## 9. Song Structure as a Probabilistic State Machine

The planned arrangement should behave like a state machine with probabilistic transitions.

Example:

```text
Verse 1
   |
   v
Chorus #1
   |
   v
Verse 2
   |
   v
Chorus #2
   |
   v
Chorus #3
   |
   v
Bridge
   |
   v
Final Chorus
```

At any moment:

- staying within the current section is likely,
- advancing to the next slide in that section is highly likely,
- entering the planned next section is highly likely,
- jumping to another known section is possible but lower-priority,
- wildly unrelated jumps should require strong audio evidence.

This can initially be implemented without a formal ML library.

A later mathematical formulation could resemble a Hidden Markov Model:

- hidden state = current lyric slide/section,
- transition probability = arrangement/state model,
- observation likelihood = audio/transcript similarity,
- posterior = probability of each lyric state given history and current evidence.

A Viterbi-style or beam-search tracker could later be useful if naive scoring becomes unstable.

---

## 10. Handling Improvisation

Improvisation is a first-class requirement, not an edge case.

Examples:

- extra chorus,
- skipped chorus,
- repeat bridge,
- jump back to verse,
- go straight to tag,
- extend final chorus,
- leader calls a section not in the plan,
- singer starts a line from a different section.

### 10.1 Override principle

Structure confidence must never completely suppress strong audio evidence.

Example:

```text
Expected Chorus candidate:
  audio = 0.22
  structure = 1.00

Bridge candidate:
  audio = 0.97
  structure = 0.10
```

The bridge should be allowed to win.

### 10.2 Re-anchoring after deviation

Once an unexpected section is recognized with high confidence:

1. Accept that section as the current reality.
2. Mark the performance as deviating from plan.
3. Stop repeatedly trying to force the planned next section.
4. Recompute likely transitions from the new observed section.
5. Rejoin the planned path later if evidence supports it.

### 10.3 Anti-oscillation

Prevent a single ambiguous phrase from causing:

```text
Chorus -> Bridge -> Chorus -> Bridge
```

Use:

- minimum dwell time,
- hysteresis,
- candidate lead margin,
- evidence persistence,
- recent-history penalty for unlikely immediate reversal.

---

## 11. Repeated Lyrics and Duplicate Sections

This is a major expected challenge.

A song may contain multiple copies of identical chorus slides.

Audio may perfectly match all of them.

Therefore the system must distinguish:

- **lyric identity**, and
- **arrangement position**.

Example:

```text
Current arrangement state:
Verse 2

All three chorus occurrences have identical text.

Chorus after Verse 1:  low transition prior
Chorus after Verse 2:  very high transition prior
Final Chorus:           low transition prior
```

Choose the occurrence consistent with recent history unless audio or manual input proves otherwise.

If ProPresenter reuses the same physical chorus slides rather than duplicating them, model the **logical occurrence** separately from the physical slide identity.

---

## 12. Human Override Rules

Human input must always win.

If an operator manually selects a ProPresenter slide:

1. Treat the manual selection as authoritative.
2. Update current slide immediately.
3. Re-anchor song/section state from that slide.
4. Cancel any queued automatic action pointing elsewhere.
5. Apply a short automation grace period if needed to prevent the AI immediately undoing the operator's choice.

Possible rule:

```text
After a manual slide change:
- resync instantly,
- inhibit automatic transitions for 1-3 seconds,
- continue observing audio,
- resume when confidence is stable.
```

The exact delay should be tested.

---

## 13. Operating Modes

### 13.1 MANUAL

- No automatic triggers.
- Optionally keep listening and logging.
- Human runs ProPresenter normally.

### 13.2 ASSIST

- Full recognition and matching runs.
- Display predicted slide and confidence.
- Never trigger ProPresenter automatically.

This is the primary development/testing mode.

### 13.3 AUTO

- Full recognition and matching runs.
- Eligible high-confidence decisions trigger ProPresenter.
- Manual ProPresenter interaction always overrides.

AUTO should not be considered production-ready until ASSIST mode has produced strong benchmark results across realistic recordings.

---

## 14. Audio Strategy

### 14.1 Do not block development waiting for the church lead singer

There is no need to have isolated recordings of the church's actual lead singer before starting.

The system is not intended to identify the singer's identity or learn a personalized voice model. It needs to determine which **known lyric state** best matches the incoming performance.

### 14.2 Progressive test difficulty

Use progressively more difficult data:

#### Level 1 - Clean spoken/sung developer input

- developer sings/speaks known lyrics into microphone,
- easiest environment,
- good for validating the software pipeline.

#### Level 2 - Clean vocal recording

- any singer is acceptable,
- no need to be the church lead singer.

#### Level 3 - Full commercial/worship mix

- lead vocal,
- backing vocals,
- drums,
- guitars,
- keys,
- ambience.

This is useful as an intentionally noisy/realistic robustness test.

#### Level 4 - Source-separated vocal estimate

Run a full mix through a vocal-separation tool and compare performance with the original mix.

This gives an empirical answer to:

> How much does cleaner vocal audio improve lyric-following accuracy and latency?

#### Level 5 - Real church rehearsal feed

Eventually collect:

- clean lead-vocal feed if possible,
- full front-of-house mix,
- optionally vocal bus/backing vocals,
- synchronized ProPresenter slide changes.

### 14.3 Production preference

For final live use, prefer a **lead-vocal or suitable vocal-bus feed from the mixing console** if available.

A full mix can remain a fallback/test mode.

---

## 15. Data to Gather

### 15.1 Minimum song dataset

Start with approximately 5-10 songs.

Include:

- simple verse/chorus song,
- multiple verses,
- repeated choruses,
- bridge,
- repeated bridge,
- tag/outro,
- lots of repeated words,
- one song the band regularly improvises,
- slow song,
- fast song.

### 15.2 For each song collect

- title/internal ID,
- ProPresenter presentation ID or stable reference,
- every lyric slide's text,
- slide index/ID,
- section label,
- section type,
- order within section,
- intended arrangement for a particular performance,
- notes about expected repeats/skips.

### 15.3 Audio recordings

For each test performance, retain where possible:

- source audio filename,
- clean vocal track,
- full mix track,
- estimated separated vocal track,
- sample rate/channel metadata,
- start synchronization point.

### 15.4 Ground-truth timeline

For benchmark performances, manually annotate what slide **should** have been active.

Example:

```csv
time_ms,section,slide_id,event,planned,deviation_note
0,verse1,s1,start,true,
6200,verse1,s2,transition,true,
12950,chorus,s3,transition,true,
19100,chorus,s4,transition,true,
25900,verse2,s5,transition,true,
31800,bridge,s9,jump,false,"leader skipped planned chorus"
```

This dataset is essential for measuring actual progress.

---

## 16. Data Storage Format

Use simple version-controlled JSON/JSONL/CSV during the prototype.

Suggested layout:

```text
data/
  songs/
    song-001/
      song.json
      arrangement-default.json
      slides.json
      recordings/
        performance-001/
          metadata.json
          ground-truth.csv
          notes.md
        performance-002/
          metadata.json
          ground-truth.csv
```

Do not commit copyrighted commercial audio or confidential church recordings into a public repository.

Use `.gitignore` for local audio datasets where appropriate.

---

## 17. Testing with YouTube / Full-Mix Audio

Full-mix recordings are acceptable for early development and can be valuable because they intentionally create harder conditions.

Expected issues:

- instruments mask consonants,
- backing vocals overlap the lead,
- reverb smears words,
- crowd/congregation may sing different timing,
- backing vocalists may sing a different lyric phrase from the lead,
- commercial arrangement may differ from the church's ProPresenter arrangement.

Use them to test robustness, but do not treat full-mix performance as the final ceiling.

A useful experiment is to run the **same performance** through:

```text
A. Full mix
B. Vocal-separated estimate
C. Clean isolated vocal, when available
```

Compare:

- transcription usefulness,
- correct slide rate,
- transition latency,
- false transitions,
- resynchronization performance.

---

## 18. Transcription Requirements

The transcription provider/engine is intentionally not fixed yet.

Evaluate providers based on:

- streaming support,
- partial/interim results,
- end-to-end latency,
- singing robustness,
- cost,
- local/offline availability if relevant,
- API stability,
- privacy considerations,
- timestamps,
- ability to cope with full mixes.

### 18.1 Important alternative

Do not assume general-purpose speech-to-text is necessarily the final best sensor.

Possible later alternatives:

- phoneme recognition,
- forced alignment against known lyrics,
- acoustic fingerprinting by lyric segment,
- singing-voice recognition,
- multilingual speech/singing models,
- direct audio embeddings compared against reference performances.

However, streaming transcription is the simplest MVP path because it gives human-readable diagnostics.

---

## 19. Rolling Buffer and Timing

Initial recommendation:

- raw audio ring buffer: 5-10 seconds,
- transcript decision window: 2-5 seconds,
- frequent interim updates,
- timestamp every recognition update.

The system should be able to revise recent interim text.

Do not permanently act on one unstable token.

Potential transition rule:

- candidate score must exceed threshold,
- candidate must lead second-best candidate by a configured margin,
- evidence must be stable for N updates or M milliseconds,
- unless the candidate is the expected immediate next slide and contains a highly distinctive partial lyric.

---

## 20. Candidate Scoring

Recommended starting features:

### 20.1 Audio/text match

How strongly does current recognized text match candidate lyric text?

### 20.2 Structure prior

Is this candidate part of the planned next section/arrangement step?

### 20.3 Local proximity

Is it:

- current slide,
- next slide,
- previous slide,
- same section,
- nearby section?

### 20.4 Recent history

Does the path to this candidate make sense given the last several high-confidence states?

### 20.5 Candidate uniqueness

Does this phrase uniquely identify the candidate, or does the same text exist elsewhere?

### 20.6 Stability

Has this candidate been winning across several consecutive recognition updates?

### 20.7 Example scoring

```text
candidate = Chorus slide 1

audio similarity       0.88
structure prior         1.00
local proximity         1.00
history consistency     0.96
uniqueness              0.65
stability               0.91

combined score          ~0.92
```

The exact formula should be transparent and logged.

---

## 21. Confidence and Safety Logic

Initial policy concept:

```text
LOW confidence
- do nothing

MEDIUM confidence
- display suggestion
- never auto-fire

HIGH confidence
- candidate may auto-fire if AUTO mode is enabled
```

Additional guardrails:

- prevent repeated firing of the already-live slide,
- rate-limit transitions,
- require stronger evidence for large jumps,
- allow nearby expected transitions with lower latency,
- require stronger evidence for reversing direction,
- suppress auto action shortly after manual override,
- cancel pending action if candidate changes before execution,
- fail safe to MANUAL/ASSIST if ProPresenter state becomes inconsistent.

---

## 22. Latency Goal

The system must not wait until the congregation has already sung most of a lyric slide.

The desired behavior is anticipatory:

1. Planned structure predicts likely next slide.
2. First distinctive sung words provide confirmation.
3. System triggers as early as safely possible.

Measure separately:

- audio capture delay,
- transcription delay,
- matching computation delay,
- decision stability delay,
- ProPresenter trigger delay,
- total transition latency relative to ground truth.

Do not hide latency by reporting only model/API latency.

---

## 23. Logging Requirements

Log every meaningful input and decision.

Suggested JSONL event schema:

```json
{
  "ts": 1750000000123,
  "event": "matcher_decision",
  "mode": "assist",
  "songId": "song-001",
  "currentSlideId": "s12",
  "expectedSlideId": "s13",
  "transcriptRaw": "...",
  "transcriptNormalized": "...",
  "candidates": [
    {
      "slideId": "s13",
      "audio": 0.94,
      "structure": 1.0,
      "proximity": 1.0,
      "history": 0.95,
      "final": 0.97
    },
    {
      "slideId": "s21",
      "audio": 0.91,
      "structure": 0.15,
      "proximity": 0.1,
      "history": 0.2,
      "final": 0.55
    }
  ],
  "decision": "suggest",
  "selectedSlideId": "s13",
  "decisionLatencyMs": 530
}
```

Also log:

- ProPresenter connection events,
- active-presentation changes,
- manual slide changes,
- transcription partial/final updates,
- audio device errors,
- state re-anchors,
- deviations from plan,
- auto trigger success/failure.

---

## 24. Metrics

Track at least:

- correct slide prediction rate,
- correct automatic trigger rate,
- false transition rate,
- missed transition rate,
- unnecessary duplicate triggers,
- median transition latency,
- p90/p95 transition latency,
- improvisation detection accuracy,
- time to recover after improvisation,
- manual interventions per song,
- manual interventions per minute,
- transcription usefulness/coverage,
- ProPresenter API error rate.

### 24.1 Best product metric

A particularly useful top-level measure is:

```text
human interventions per song
```

Example progression:

```text
v0.1: 7.0 interventions/song
v0.2: 3.1 interventions/song
v0.3: 0.8 interventions/song
```

This aligns closely with the actual goal: reduce the need for a dedicated person to constantly operate lyric slides.

---

## 25. Evaluation Scenarios

Every substantial version should be tested against:

### Normal structure

```text
V1 -> C -> V2 -> C -> B -> C
```

### Extra chorus

```text
planned: V2 -> C -> B
actual:  V2 -> C -> C -> B
```

### Skipped chorus

```text
planned: V2 -> C -> B
actual:  V2 -> B
```

### Repeated bridge

```text
planned: B -> C
actual:  B -> B -> C
```

### Return to earlier section

```text
planned: B -> C
actual:  B -> V2 -> C
```

### Ambiguous repeated lyric

Same lyric appears in multiple sections/occurrences.

### Vocal dropout

Lead stops singing for several seconds.

### Instrumental break

No lyric evidence; system should normally hold state rather than wander.

### Backing-vocal conflict

Lead and backing singers sing different phrases.

### Manual correction

Human selects a different slide while AUTO is active; system must yield and resync.

### Poor transcription

Observed text contains missing/incorrect words but still should align correctly.

### Large spontaneous jump

Audio strongly matches a distant section. Large jumps should require strong evidence but remain possible.

---

## 26. Recommended Repository Structure

Language choice is flexible. TypeScript/Node or Python are both suitable for a prototype. Favor whichever makes live audio and the ProPresenter API easiest on the developer's OS.

Example TypeScript-oriented layout:

```text
propresenter-lyric-follower/
  README.md
  package.json
  .env.example
  .gitignore

  src/
    app/
      main.ts
      config.ts

    propresenter/
      adapter.ts
      client.ts
      types.ts
      mock.ts

    audio/
      capture.ts
      file-source.ts
      ring-buffer.ts

    transcription/
      transcriber.ts
      providers/
        mock.ts

    lyrics/
      normalize.ts
      fuzzy-match.ts
      candidates.ts

    song/
      model.ts
      arrangement.ts
      state-machine.ts

    decision/
      scoring.ts
      policy.ts
      hysteresis.ts

    ui/
      ...

    logging/
      events.ts
      logger.ts

  tests/
    unit/
    integration/
    fixtures/

  data/
    songs/

  scripts/
    replay-recording.ts
    evaluate-ground-truth.ts
```

A Python equivalent is equally acceptable.

---

## 27. Offline Replay Harness - Build This Early

The project should support two input modes:

```text
LIVE MODE
microphone/audio interface -> transcriber -> matcher

REPLAY MODE
recorded audio file -> transcriber -> matcher
```

Replay mode is critical.

It allows the developer to:

- run the exact same performance after every code change,
- compare metrics across versions,
- reproduce bugs,
- tune thresholds without needing the band present,
- simulate faster-than-real-time preprocessing where appropriate,
- build automated regression tests.

Eventually, consider storing captured transcription events too, allowing a third mode:

```text
TRANSCRIPT REPLAY
saved transcript/timestamps -> matcher/state engine
```

This isolates matching/state logic from transcription variability.

---

## 28. Mocks and Simulation

Do not require ProPresenter or a real microphone for every automated test.

Implement:

- `MockProPresenterAdapter`,
- `MockTranscriber`,
- deterministic transcript-event fixtures,
- song/arrangement fixtures.

Example deterministic test:

```text
Given:
- current slide = Verse 2 final slide
- planned next section = Chorus
- transcript = first distinctive chorus phrase

Expect:
- Chorus slide 1 ranks first
- confidence > threshold
- AUTO policy emits one slide trigger
```

Improvisation test:

```text
Given:
- planned next = Chorus
- transcript strongly matches Bridge

Expect:
- Bridge wins after sustained high audio evidence
- state marks deviation
- next likely transitions are recalculated from Bridge
```

---

## 29. Initial Development Phases

### Phase 0 - Local ProPresenter setup

Goal: establish local environment.

Tasks:

1. Install ProPresenter on developer computer.
2. Run it unregistered/free for development.
3. Create one synthetic test song with 6-8 lyric slides.
4. Label sections clearly.
5. Define a simple arrangement such as:

```text
V1 -> C -> V2 -> C -> B -> C
```

**This is the immediate first step.**

Do not add AI yet.

### Phase 1 - ProPresenter API proof of concept

Goal: prove bidirectional integration.

Tasks:

1. Enable/inspect ProPresenter networking/API settings.
2. Read the API docs exposed by the installed version.
3. Connect from a tiny local program.
4. Display active presentation.
5. Display current slide/index.
6. Add a `NEXT` button or CLI command.
7. Trigger a known slide directly if supported.
8. Observe manual slide changes.

Exit criterion:

> The program can reliably observe current ProPresenter state and cause a controlled slide change.

### Phase 2 - Static lyric matching

Goal: match text to known slides without audio.

Tasks:

1. Obtain test slide text.
2. Type/paste simulated imperfect transcript strings.
3. Rank matching slides.
4. Add section/position priors.
5. Show top 3 candidates and component scores.

Exit criterion:

> Given noisy lyric text, the correct slide usually ranks first.

### Phase 3 - Song structure engine

Goal: make expected progression useful.

Tasks:

1. Parse arrangement string/JSON.
2. Track current logical section occurrence.
3. Prefer expected next slide/section.
4. Handle duplicate chorus occurrences.
5. Re-anchor after explicit/manual jumps.

Exit criterion:

> Repeated lyrics are resolved correctly using arrangement/history in deterministic tests.

### Phase 4 - Recorded-audio transcription

Goal: connect real acoustic input to matcher.

Tasks:

1. Choose one streaming-capable transcription implementation.
2. Transcribe an audio file in pseudo-real time.
3. Maintain 2-5 second rolling transcript.
4. Feed updates into matcher.
5. Log all candidates and decisions.

Exit criterion:

> A known recording produces a sensible time sequence of predicted lyric slides.

### Phase 5 - ASSIST mode benchmark

Goal: measure accuracy safely.

Tasks:

1. Build minimal UI.
2. Replay multiple performances.
3. Create ground-truth timelines.
4. Score predictions.
5. Tune thresholds/weights.
6. Test improvisation.

Exit criterion:

> Accuracy and latency are good enough to justify automatic experiments.

### Phase 6 - AUTO mode against local ProPresenter

Goal: allow high-confidence decisions to trigger local slides.

Tasks:

1. Connect decision policy to ProPresenter adapter.
2. Add debounce/hysteresis.
3. Respect manual overrides.
4. Record every automatic action.
5. Add immediate disable/manual control.

Exit criterion:

> Recorded performance can drive local ProPresenter correctly with few/no unsafe transitions.

### Phase 7 - Real rehearsal validation

Goal: test church conditions.

Tasks:

1. Capture lead-vocal feed.
2. Capture full mix simultaneously.
3. Record ground truth.
4. Run ASSIST first.
5. Compare full mix vs clean vocal.
6. Enable AUTO only after observing stable results.

---

## 30. First Synthetic Test Song

Do not begin with copyrighted lyrics if the repository may be shared.

Create a fake song such as:

```text
Verse 1 - Slide 1
Morning breaks across the valley

Verse 1 - Slide 2
We lift our voices together

Chorus - Slide 3
You are with us through the storm

Chorus - Slide 4
You will lead us safely home

Verse 2 - Slide 5
When the road becomes uncertain

Verse 2 - Slide 6
Still we choose to walk in hope

Bridge - Slide 7
We will follow, we will follow

Bridge - Slide 8
Where You lead us we will go
```

Arrangement:

```text
V1 -> C -> V2 -> C -> B -> C
```

This dataset is enough to test the initial ProPresenter API integration and state engine without any licensing/copyright complication.

---

## 31. First Coding-Agent Task

After the local ProPresenter test presentation exists, give the coding agent this exact first engineering objective:

> Build a minimal local ProPresenter integration spike. Read the API documentation exposed by the installed ProPresenter version. Create a small client that connects to ProPresenter on localhost, reports connection health, prints the active presentation and current slide/index, and provides one safe command to move to the next slide or trigger a known test slide. Keep the ProPresenter API behind an adapter interface so it can be mocked later. Do not add transcription, AI, or song matching yet. Log all requests, responses, and state changes. Add a README with local setup instructions and a small integration test or manual test procedure.

Acceptance criteria:

- [ ] Application starts locally.
- [ ] Configuration supports ProPresenter host/port.
- [ ] Health/connection state is visible.
- [ ] Active presentation can be identified, where the API supports it.
- [ ] Current slide/index can be identified, where the API supports it.
- [ ] A controlled slide transition can be issued.
- [ ] Manual slide changes can be detected or polled reliably.
- [ ] Failures are logged clearly and do not crash the process.
- [ ] ProPresenter-specific code is isolated behind an adapter.
- [ ] Mock adapter exists or interface is designed for one.
- [ ] No transcription/AI dependencies are added yet.

---

## 32. Second Coding-Agent Task

Once Phase 1 works:

> Build a deterministic lyric-slide matcher independent of audio. Given a song containing slide text, section labels, planned arrangement, current slide, and a noisy transcript string, return the top N candidate slides with transparent sub-scores for text similarity, planned structure, local proximity, and recent history. Add unit tests for normal progression, duplicate choruses, a skipped section, an extra chorus, and a jump to bridge. Do not call an LLM in the matching loop.

Acceptance criteria:

- [ ] Text normalization is unit tested.
- [ ] Fuzzy matching tolerates minor transcription errors.
- [ ] Expected next slide is favored when audio evidence is comparable.
- [ ] Strong contradictory text can defeat the structure prior.
- [ ] Duplicate lyric occurrences are resolved using state/history.
- [ ] Top candidates expose component scores.
- [ ] Matcher is deterministic given deterministic inputs.

---

## 33. Likely Technical Challenges

### 33.1 Singing recognition

Speech recognition models are often optimized primarily for speech, not lead vocals over music.

Mitigation:

- known-lyrics matching,
- clean mixer feed where possible,
- partial phrase matching,
- structure prior,
- vocal source separation experiments,
- tolerate imperfect transcript.

### 33.2 Transition timing

Correct recognition after the full line is too late.

Mitigation:

- structure anticipation,
- distinctive partial lyric matching,
- confidence thresholds based on candidate margin,
- evaluate latency explicitly.

### 33.3 Identical repeated sections

Audio cannot distinguish identical lyric copies.

Mitigation:

- separate logical arrangement occurrence from physical lyric identity,
- use history/transition model.

### 33.4 Improvisation

Hard-coded arrangements will fail in worship contexts.

Mitigation:

- probabilistic structure prior,
- full-song fallback search,
- re-anchor after deviation.

### 33.5 Backing-vocal conflicts

Lead and backing vocals may contain different lyric fragments.

Mitigation:

- favor clean lead-vocal feed,
- compare full mix vs separated vocal,
- use temporal stability and structure evidence.

### 33.6 Operator fighting

Automation must not undo a human correction.

Mitigation:

- manual action is authoritative,
- immediate re-anchor,
- short auto suppression after manual change.

### 33.7 API/version differences

ProPresenter API surface may change.

Mitigation:

- adapter layer,
- configuration,
- inspect local installed-version API docs,
- integration smoke test,
- do not leak HTTP endpoint assumptions throughout the codebase.

---

## 34. Security and Privacy Considerations

For local development:

- bind development APIs/UI to localhost by default,
- do not expose ProPresenter control endpoints publicly,
- do not commit API keys,
- use environment variables/secrets management,
- consider whether church rehearsal audio may contain private speech,
- define retention rules for stored audio,
- avoid public repositories containing private recordings,
- document whether transcription audio leaves the machine if using a cloud provider.

For production:

- prefer local-LAN-only control,
- authenticate/control access where supported,
- provide a hard manual disable path,
- ensure loss of internet/cloud transcription fails safely rather than randomly advancing slides.

---

## 35. Failure Behavior

The system should fail **passively**.

If any of these occur:

- ProPresenter disconnected,
- transcription provider unavailable,
- audio feed missing,
- no candidate has sufficient confidence,
- song/presentation changes unexpectedly,
- internal state becomes inconsistent,

then:

```text
Do not guess.
Do not trigger a random slide.
Remain/return to ASSIST or MANUAL behavior.
Surface a clear diagnostic.
```

---

## 36. Suggested Configuration

Example `.env` / config concepts:

```text
PROPRESENTER_HOST=127.0.0.1
PROPRESENTER_PORT=<verify-from-local-settings>
MODE=assist
AUDIO_DEVICE=<device-id>
TRANSCRIPTION_PROVIDER=<provider>
TRANSCRIPT_WINDOW_MS=3500
DECISION_MIN_CONFIDENCE=0.90
DECISION_MIN_MARGIN=0.12
MANUAL_OVERRIDE_COOLDOWN_MS=2000
LOG_LEVEL=debug
```

Thresholds should eventually move to a typed configuration file and be versioned with benchmark results.

---

## 37. Development Principles

1. **Known lyrics are the database.** Transcription is only a noisy sensor.
2. **Structure is a prior, not a prison.**
3. **Human input always wins.**
4. **Prefer deterministic, explainable scoring before LLM decisions.**
5. **Measure with replayable recordings and ground truth.**
6. **Optimize end-to-end slide timing, not transcription word accuracy alone.**
7. **Fail passively when uncertain.**
8. **Build ASSIST before AUTO.**
9. **Keep ProPresenter isolated behind an adapter.**
10. **Do not wait for perfect church data before starting.**
11. **Collect real church data later to validate, not to unblock initial development.**
12. **Log enough evidence to explain every wrong transition.**

---

## 38. Questions to Resolve During Implementation

These do not block Phase 0.

### ProPresenter

- What exact ProPresenter version is used at the church?
- Which API endpoints are available in the developer's installed version?
- Can the API directly expose all current slide lyric text?
- Are song sections/groups exposed with useful labels?
- Does the church duplicate repeated chorus slides or reuse the same slide group?
- Can the application subscribe to current-slide updates, or should it poll?
- What stable identifier survives presentation edits?

### Audio

- What sound console does the church use?
- Can it provide USB/Dante/network/aux lead-vocal output?
- Is the worship leader mic isolated enough during rehearsal?
- Are backing vocals needed as secondary evidence?

### Song preparation

- How does the projectionist currently receive the planned arrangement?
- Is it typed text, Planning Center, a printed set list, chat message, etc.?
- Could the structure eventually be imported automatically?
- Do section labels already exist consistently in ProPresenter?

### Product behavior

- How early should a lyric slide appear relative to the first sung syllable?
- How much wrong-slide risk is acceptable before automatic mode is considered unusable?
- Should the system ever move backward automatically?
- Should spoken worship-leader cues influence state?
- What happens during instrumental sections?

---

## 39. Future Enhancements - Not MVP

Once lyric following is proven, potential extensions include:

- automatic detection of which song has started,
- import arrangement from planning/set-list software,
- vocal stem separation in real time,
- direct phoneme/lyric forced alignment,
- smarter transition model learned from rehearsal data,
- per-song timing calibration,
- confidence visualization for operator,
- service-wide state tracking,
- scripture-reference detection,
- sermon slide following,
- video/cue triggering,
- stage-display cues,
- multi-computer ProPresenter integration,
- offline local transcription,
- automatic rehearsal analytics.

Eventually this could become a broader **AI technical director for ProPresenter**, but that is explicitly outside the first build.

---

## 40. Immediate Next Action

Do exactly this first:

1. Install the current ProPresenter on the developer computer.
2. Run the unregistered/free development copy.
3. Create one small synthetic song presentation with 6-8 lyric slides.
4. Clearly group/label Verse 1, Chorus, Verse 2, Bridge.
5. Define the planned arrangement:

```text
V1 -> C -> V2 -> C -> B -> C
```

6. Open ProPresenter's Network settings and inspect the API documentation exposed by that installed version.
7. Only then begin the Phase 1 API integration spike.

The first engineering success should be intentionally boring:

```text
ProPresenter is running locally
        |
        v
Our program connects
        |
        v
"Current presentation: Test Song"
"Current slide: 3"
        |
        v
Command: NEXT
        |
        v
ProPresenter changes to slide 4
```

Once this works, the foundation is in place for the entire lyric-following system.

---

## 41. Definition of MVP Success

A successful first meaningful MVP is **not** a flawless autonomous Sunday-service operator.

MVP success is:

> Given a known song in ProPresenter, a planned arrangement, and a recorded or live performance, the application continuously ranks the correct lyric slide near the top, follows normal planned transitions quickly, recognizes deliberate section deviations from the audio, re-anchors after improvisation, and can drive local ProPresenter in a controlled AUTO mode while always yielding to manual input.

A strong next-stage target would be:

- low manual interventions per song,
- no catastrophic/random jumps,
- predictable behavior when uncertain,
- acceptable lyric transition latency,
- clear logs explaining every miss.

---

## 42. Official ProPresenter References

These links were verified while preparing this brief on 2026-08-16.

### Unregistered / development use

- https://support.renewedvision.com/hc/en-us/articles/360042103673-Registering-ProPresenter-7-Moving-a-seat-from-one-computer-to-another

### 14-day trial

- https://support.renewedvision.com/hc/en-us/articles/4412269910419-How-to-Request-a-Two-Week-Trial-for-ProPresenter

### HTTP API / TCP/IP access and local API documentation

- https://support.renewedvision.com/hc/en-us/articles/31606866768147-TCP-IP-Connections-with-ProPresenter-API

### Network Link background (separate feature, useful context for ProPresenter network control)

- https://support.renewedvision.com/hc/en-us/articles/4412193892627-Network-Link

---

# One-Sentence Brief for a Coding Agent

**Build a local, testable, fail-safe real-time lyric-following service that treats ProPresenter's pre-existing lyric slides as the known state space, uses planned song structure as a strong transition prior, uses live audio/transcription as observational evidence that can override the plan during improvisation, always respects human ProPresenter changes, and is developed incrementally from a simple local ProPresenter API integration through deterministic lyric matching, replayable audio benchmarks, ASSIST mode, and finally controlled AUTO slide triggering.**
