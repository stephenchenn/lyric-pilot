# Installed-version API profiles

The HTTP adapter loads a local JSON profile. It does not assume vendor endpoint paths or response field names. A verified flag records that the operator reviewed the installed docs; the software cannot independently certify that review or compatibility.

Start from `profiles/propresenter.example.json`. Replace every placeholder and check every mapping. `tests/fixtures/http-profile.json` is a complete **fictional test-server contract**, useful for understanding the format. It must not be used as a ProPresenter profile.

## Requests

The `health`, `activePresentation`, `currentSlide` and `slides` endpoints use GET. Map these to documented observation operations, since HTTP method alone does not establish whether a vendor endpoint mutates state. A health endpoint may be any cheap, documented observation endpoint whose successful response establishes reachability.

`triggerSlide` uses the documented `GET`, `POST` or `PUT` method. It can contain a JSON `body` for POST/PUT. Paths must start with a single `/` and remain on the configured host. Redirects are rejected.

| Placeholder | Available in | Value |
| --- | --- | --- |
| `{presentationId}` | `slides`, `triggerSlide` paths | Active presentation ID |
| `{slideId}` | `triggerSlide` path/body | Known target slide ID |
| `{index}` | `triggerSlide` path/body | Target index in the vendor's configured index base |

Path values are URL encoded. Body values that are exactly `"{index}"` become numbers; an embedded placeholder such as `"cue-{index}"` remains a string. Body placeholders are expanded recursively. Do not put credentials in paths or profiles. `PROPRESENTER_TOKEN` supplies an optional bearer header; other authentication schemes will need an adapter extension after inspecting the real installation.

## Responses

Mappings use [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901). `root` locates the relevant object or array in a response. Other pointers are relative to each mapped object, or each element for the slides array. An empty pointer selects the entire value. `/` in a field name is escaped as `~1`, and `~` as `~0`.

Presentation objects require string `id` and `title`. Current-slide objects require string `id`, string `presentationId` and numeric `index`. This explicit presentation identity lets the adapter reject inconsistent state. A `null` presentation/current-slide root means there is no active item.

The slides root must be a flat array. Each element needs a string `id`, numeric `index` and string `text` (which may be empty for a blank slide). Optional `section` maps to a string or null; omit that mapping if the API does not expose it. Slide IDs and indices must be unique within the presentation. The adapter sorts by index.

`indexBase` is `0` or `1`, verified against the installed docs and an observed test slide. It applies to current-slide responses, slide catalog responses and trigger indices. Internal indices are always zero based.

Missing fields, unexpected types and presentation/slide disagreement produce a degraded state with no usable current slide. They do not silently fall back to guessed fields. The current mapping layer supports object/array projection, not arbitrary transforms. If the installed API uses nested slide groups, rich-text payloads, separate slide-identity lookups or unavailable lyric text, add a tested installed-version decoder/importer once those responses are available.

## Establish a verified profile

Record `documentation.url`, `documentation.applicationVersion` and `documentation.reviewedAt`, set `verified: true`, and run status/slides against the synthetic test presentation. Compare IDs, indices, text and section labels with ProPresenter. Use the documented trigger method only after those observations agree.

Keep the profile as `profiles/propresenter.local.json` so it remains ignored. After testing a real version, a sanitized version-specific profile and captured responses can be committed as compatibility fixtures. No real version has been verified yet.
