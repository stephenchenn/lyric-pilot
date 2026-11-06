# ProPresenter test presentation and acceptance

This repository is being developed on Linux without a ProPresenter instance. Use a ProPresenter-capable development computer locally or on the same trusted LAN for the real integration check. Development of the mock does not require that setup.

Install and run ProPresenter using the current official setup/licensing instructions. The brief proposes unregistered development use; confirm the current terms for the installed version. Then create a presentation named **Morning / Synthetic Test Song**, with these original lyrics:

| Slide | Group | Text |
| --- | --- | --- |
| 1 | Verse 1 / V1 | Morning breaks across the valley |
| 2 | Verse 1 / V1 | We lift our voices together |
| 3 | Chorus / C | You are with us through the storm |
| 4 | Chorus / C | You will lead us safely home |
| 5 | Verse 2 / V2 | When the road becomes uncertain |
| 6 | Verse 2 / V2 | Still we choose to walk in hope |
| 7 | Bridge / B | We will follow, we will follow |
| 8 | Bridge / B | Where You lead us we will go |

The planned arrangement is `V1 → C → V2 → C → B → C`. Keep eight physical slides and reuse the chorus groups; the fixture stores arrangement order separately. This spike navigates physical slide order and does not execute the arrangement yet. Do not assume the mock's `synthetic-presentation`/`s1` identifiers will be assigned by ProPresenter.

Open Network settings, enable the HTTP API, note its port and open API Documentation. Follow the [profile guide](api-profiles.md) and configure `.env` before these checks.

## Acceptance procedure

All real-instance items below are **pending**. Automated tests exercise mocks and a fictional HTTP server.

- [ ] `npm run cli -- status` identifies the synthetic presentation and selected slide; compare its ID/index with the installed API docs.
- [ ] `npm run cli -- slides` lists all eight physical slides with correct text and indices. Confirm whether group labels are exposed.
- [ ] `npm run cli -- watch` detects selecting slides 1, 7, 3 manually in ProPresenter. Expect observation within one poll cycle plus request latency (default interval: 750 ms).
- [ ] `npm run presenter -- --allow-control`, then `next` moves from physical slide 3 to 4 once. `previous` returns to 3. Verify the actual output.
- [ ] `goto <real-slide-id>` triggers the known bridge slide once. Re-select it manually; issuing goto for the already-current slide is refused.
- [ ] From physical slide 8, `next` is refused. From slide 1, `previous` is refused. No transition to another presentation occurs.
- [ ] With watch/console running, stop ProPresenter or disable its API. Health becomes disconnected/degraded, current state is cleared, controls refuse, and the process remains alive.
- [ ] Restore the API. Observation resumes with ProPresenter's actual current slide. Recovery triggers no slide.
- [ ] Read `logs/session-*.jsonl`: requests, responses, state observations, command targets, confirmations and failures are present. Confirm credentials are absent before sharing a sanitized excerpt.
- [ ] Record the installed application version, profile, observed response shapes and any timing/identity differences. Add sanitized compatibility fixtures before declaring Phase 1 complete.

Polls cannot detect every intermediate selection or distinguish a human from another external controller. They re-anchor on the latest observed state. The final read and trigger are separate HTTP requests, so there is a small unavoidable race without stronger vendor-side atomicity. No automatic controls run in this phase.
