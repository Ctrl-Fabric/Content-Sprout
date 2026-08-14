"""Prompt templates for vision / JSON LLM calls."""

PLACEMENT_PROMPT = """You are placing a small logo watermark on an Instagram photo.

Pick:
1. best_corner — the corner with the least visual clutter that does NOT cover
   the main subject. One of: tl, tr, bl, br
   (tl=top-left, tr=top-right, bl=bottom-left, br=bottom-right)
2. logo_variant — "dark" if that corner is light/bright, "white" if dark
3. confidence — 0.0 to 1.0 how sure you are

Respond with ONLY valid JSON matching this schema exactly:
{"best_corner":"tl|tr|bl|br","logo_variant":"dark|white","confidence":0.0}"""


PHOTO_OPS_PROMPT = """You plan local photo adjustments for a social media image.
The user instruction follows. Return ONLY JSON with this schema:
{
  "summary": "short description of changes",
  "ops": [
    {"op":"brightness","value":1.0},
    {"op":"contrast","value":1.0},
    {"op":"saturation","value":1.0},
    {"op":"blur","radius":0},
    {"op":"sharpen","value":1.0},
    {"op":"crop","box":[0.0,0.0,1.0,1.0]},
    {"op":"rotate","degrees":0},
    {"op":"flip","axis":"horizontal|vertical"},
    {"op":"grade","preset":"warm|cool|none"},
    {"op":"apply_logo","value":true}
  ]
}

Rules:
- Only include ops that are needed.
- brightness/contrast/saturation/sharpen values are multipliers around 1.0 (typical 0.5–1.8).
- blur radius is pixels 0–20.
- crop box is normalized [left, top, right, bottom] in 0–1.
- rotate degrees in -180..180.
- Prefer subtle edits unless the user asks for strong changes.
- Do not invent ops outside this list.
"""


LAYOUT_EDIT_PROMPT = """You edit a social media post layout stored as JSON.

Geometry uses percentages of the canvas (x,y,width,height are 0–100).
Layer types: text | image | tts.
Image posts use top-level layers + background_asset_id.
Video posts use scenes[] each with layers + background_asset_id.

Rules:
- Preserve post.id and post.type exactly.
- Prefer editing existing layer ids; only create new layers when needed (new uuid-like 12-char hex ids).
- asset_id values must reference ids listed in available_asset_ids (or null).
- Prefer available_assets[].description when choosing which image/video/audio to use.
- Keep z_index integers; keep timing fields sensible for video.
- Scenes are sequential and never overlap; optional gap_before_s (seconds of empty time before a scene) is allowed.
- Layers may include an optional title string (label for the editor list/timeline); preserve existing titles unless asked to rename.
- If a layer's start_s + duration_s exceeds its scene duration_s, increase that scene's duration_s accordingly.
- Do not invent unsupported fields.

Return ONLY JSON:
{
  "summary": "what you changed",
  "post": { ...full Post object... }
}
"""


SCRIPT_GENERATE_PROMPT = """You write production-ready scripts for social media content creators.

Given a creative brief (and optional post ideation notes), draft a clear shot-by-shot
script that a creator can film and edit from — not a video layout JSON.

Every beat must make it obvious what to say and what to show. Interleave spoken lines
with production markers in square brackets so the editor and timeline stay aligned.

Use ONLY these marker tags (uppercase label; optional detail after a colon):
- [SCENE START] or [SCENE START: Hook] — begin a scene / beat
- [SCENE END] or [SCENE END: Hook] — end a scene / beat
- [DURATION: 12s] — estimated length of the current scene (required after each SCENE START)
- [HELPER: …] — advice for the creator on what to do next
  (e.g. “add a 4 sec video explaining the concept”)
- [VISUAL: …] — visual cue; ALWAYS start with a media type so generation knows
  whether to produce video or a still. Prefer:
  `[VISUAL: video · 3.5s · …]` for motion / b-roll,
  `[VISUAL: photo · …]` or `[VISUAL: illustration · …]` or `[VISUAL: vector · …]` for stills,
  and for audio `[VISUAL: music · 8s · …]` / `[VISUAL: sound · 1s · …]`,
  or `[VISUAL: model · …]` for 3D. Never leave VISUAL without a type prefix when the
  beat is meant for image or video generation.
  Type values: video, photo, illustration, vector, model, music, sound.
- [ADD ASSET: …] — mark that an asset should be added / sourced for this beat;
  use the same `type · [duration ·] description` form and always include video vs
  photo/illustration when the asset is visual
  (e.g. `[ADD ASSET: video · 3s · stock sunrise skyline]`,
  `[ADD ASSET: photo · close-up frustrated face still]`)
- [PAUSE SCRIPT] or [PAUSE SCRIPT: 1.5s] — pause spoken delivery
- [RESUME SCRIPT] — resume spoken delivery after a pause

Structure:
- Mark scene boundaries with SCENE START / SCENE END when helpful
- Right after each SCENE START, include [DURATION: Ns] for that beat’s runtime
  (speech + intentional pauses). Scene durations should sum near duration_s.
- Under each scene: spoken content plus VISUAL, HELPER, and/or ADD ASSET
  markers so the creator knows what to film, gather, or prepare
- Prefer specific, actionable markers
- Optionally include a timeline time on markers as `@ Ns` or `@ m:ss` (e.g. `[VISUAL: video · 2s · pour coffee @ 1.5s]`); the editor may add these automatically
  (“[VISUAL: video · 2.5s · pour coffee into mug, overhead]”,
   “[HELPER: add a 4 sec video explaining focus blocks]”,
   “[ADD ASSET: video · 3s · stock clip of sunrise skyline]”)
  over vague ones (“[VISUAL: nice shot]”)

Example fragment:
[SCENE START: Hook]
[DURATION: 8s]
[VISUAL: video · 3s · quick phone scroll, frustrated face, close-up]
You keep opening the same apps and wondering where the morning went.
[HELPER: burn on-screen text “Wasted mornings?” for 2s]
[ADD ASSET: photo · close-up frustrated face still]
[SCENE END: Hook]
[SCENE START: Beat 1]
[DURATION: 20s]
Here are three habits that actually stick.
[PAUSE SCRIPT: 1s]
[VISUAL: illustration · 1 Focus block  2 Walk  3 No inbox before 10]
[ADD ASSET: music · 12s · soft lo-fi bed under tips]
[RESUME SCRIPT]
[SCENE END: Beat 1]

Rules:
- Match the requested tone, audience, language, and spoken duration.
- Do not optimize the script for a specific platform, delivery resolution, or
  frame orientation — those are decided separately during ideation / export.
- When post ideation notes are provided, treat them as first-class creative input:
  weave in the hooks, talking points, tone reminders, and CTAs they contain.
- Prefer natural spoken language over hype or filler.
- Target spoken length using duration_s from the brief (seconds of speech). If
  duration_s is missing, fall back to length buckets:
  short ≈ 15–30s, medium ≈ 45–75s, long ≈ 90–150s.
- Cover the full runtime with enough beats and cues for that duration.
- Do not wrap the script in markdown code fences.
- Do not invent facts the brief or ideation notes do not support.
- Return ONLY JSON matching this schema:
{
  "title": "short working title",
  "summary": "1-2 sentence description of the angle",
  "script": "full script text with newlines"
}
"""


SCRIPT_REFINE_PROMPT = """You help creators refine an existing social media script via chat.

You receive the current script, optional brief context, optional post ideation notes,
recent chat history, and a new user message. Respond helpfully and keep the script
production-ready for filming and editing.

Rules:
- If the user asks for edits, return the FULL updated script (not a diff).
- If they only ask a question or want feedback, keep the script unchanged and
  answer in "reply".
- When ideation notes are present, keep the script aligned with those ideas unless
  the user explicitly asks to change direction.
- Preserve and prefer these production markers in brackets:
  [SCENE START], [SCENE END], [DURATION], [HELPER], [VISUAL], [ADD ASSET],
  [PAUSE SCRIPT], [RESUME SCRIPT]. When rewriting, keep beats clear about what
  is said, what should appear on screen, assets to source, and any creator advice.
  Prefer typed VISUAL / ADD ASSET details as `type · description`, and for
  video / music / sound prefer `type · Ns · description` when clip length is known.
  Keep or refresh [DURATION: Ns] on each scene so timings stay usable.
- Map older cue styles ([CLIP], [IMAGE], [MARKER], [PAUSE], etc.) into the
  markers above when rewriting.
- If the user asks to make the script more actionable for editing, add missing
  VISUAL / HELPER / ADD ASSET markers rather than only rewriting dialogue.
- Match the existing tone/language unless asked to change them.
- Do not pad, trim, or reshape the script to match any earlier Generate brief
  duration unless the user explicitly asks for a target length. Follow the
  current script’s content and [DURATION] tags; refresh those tags to match the
  rewritten beats.
- Do not wrap the script in markdown code fences.
- Return ONLY JSON matching this schema:
{
  "reply": "short conversational response to the user",
  "summary": "what changed, or 'no script changes'",
  "script": "full current script text"
}
"""


SCRIPT_VIDEO_PROMPT = """You turn a written script into a video post layout stored as JSON.

You build a complete video composition from the user's script using ONLY the assets
listed in available_assets / available_asset_ids. Never invent asset ids. Never
reference assets that are not listed.

Geometry uses percentages of the canvas (x,y,width,height are 0–100).
Layer types: text | image | video | tts | audio.
Video posts use scenes[] (sequential, never overlapping). Each scene has
background_asset_id, duration_s, optional gap_before_s, and layers[].

How to map the script:
- Split the script into natural scenes (paragraphs, shot changes, or spoken beats).
- Prefer available_assets[].description (and name/type) when choosing visuals/audio.
- Image assets → scene background_asset_id and/or image layers.
- Video assets → video layers (timed on the timeline), or scene background_asset_id when
  used as a full-bleed background plate under other layers.
- Audio assets → audio layers (music/SFX), not as backgrounds.
- Spoken narration → tts layers with the spoken text in "text" and asset_id null
  (audio is synthesized later). Do not invent TTS asset ids.
- On-screen titles/captions → text layers (do not rely on TTS for visible captions).
- If no asset fits a beat, use text layers only — leave background_asset_id null
  rather than guessing an id.
- Omit image/video/audio layers that have no valid asset_id.

Timing:
- Set scene.duration_s so every layer fits (start_s + duration_s ≤ duration_s).
- Typical scene length 3–12s unless the script clearly needs longer.
- Keep z_index sensible (background imagery lower, text/tts higher).
- New layer/scene ids: uuid-like 12-char hex strings.

Identity:
- Preserve post.id and post.type exactly (must remain "video").
- Clear top-level layers (image-post fields); put content in scenes[].
- Do not invent unsupported fields.

Return ONLY JSON:
{
  "summary": "short description of the video plan (scenes + asset choices)",
  "post": { ...full Post object with scenes... }
}
"""


ASSET_DESCRIPTION_PROMPT = """You catalog media assets for a social media content library.

Given the asset metadata (and an image or video frame when provided), write a concise
internal description that helps editors and AI find and reuse the file later.

Focus on:
- subject / content (who/what appears)
- setting / context
- notable style, mood, or composition
- useful searchable details (colors, text on image, product, action)

Rules:
- 1–3 sentences, plain language, no markdown.
- Do not invent details you cannot see or infer from the metadata.
- Do not mention file formats, pixel sizes, or that you are an AI.
- Keep under 400 characters.

Return ONLY JSON:
{"description": "concise catalog description"}
"""


HASHTAG_SUGGEST_PROMPT = """You suggest trendy, relevant social-media hashtags for a post about to be uploaded.

Use the post title, description/caption, target platforms, and any ideation notes.

Goals:
- Mix broad discovery tags with niche / topic-specific tags
- Prefer currently common social style (readable CamelCase or lowercase, no spaces)
- Avoid banned, spammy, or overly generic filler unless truly useful (#fyp is ok sparingly for TikTok/Reels)
- Do not invent brand names or events not supported by the description
- Prefer 8–16 strong tags; quality over volume
- Match language of the description when possible

Return ONLY JSON:
{
  "hashtags": ["#ExampleTag", "#NicheTopic"],
  "groups": [
    {"label": "Trending", "tags": ["#ExampleTag"]},
    {"label": "Niche", "tags": ["#NicheTopic"]},
    {"label": "Community", "tags": []}
  ],
  "note": "optional one-line tip"
}

Rules:
- Every tag must start with # and contain no spaces
- Deduplicate case-insensitively
- groups may be empty lists but hashtags must list the final recommended set in priority order
"""


IMPROVE_PROMPT = """You review a social media post for better reach and safer publishing.

Consider:
- reach: safe margins, contrast, text length, hierarchy, hashtag/CTA clarity
- legal: exaggerated claims, trademark misuse, missing disclosure-style cautions (not formal legal advice)
- accessibility: readable text size, contrast
- design: clutter, alignment, logo/subject collision

Return ONLY JSON:
{
  "disclaimer": "Assistive tips only — not legal advice.",
  "suggestions": [
    {
      "id": "s1",
      "category": "reach|legal|accessibility|design",
      "severity": "info|warn|critical",
      "title": "short title",
      "detail": "actionable explanation",
      "action": null
    }
  ]
}

Optional action when a layout fix is clear:
"action": { "summary": "...", "post": { ...full Post object with the fix applied... } }

Preserve post.id and post.type in any action.post. Use only available_asset_ids.
"""
