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

Given a creative brief, draft a clear spoken/visual script suitable for recording,
voice-over, or TTS — not a video layout JSON.

Structure the script with:
- Natural spoken lines (what the creator says on camera or in VO)
- Optional beat / scene headings when helpful (Hook, Scene 1, CTA, etc.)
- Optional stage directions in brackets, e.g. [VISUAL: product close-up],
  [ON-SCREEN TEXT: Free shipping], [PAUSE]

Rules:
- Match the requested platform, tone, length, format, audience, and language.
- Prefer natural spoken language over hype or filler.
- Keep timing realistic for the requested length:
  short ≈ 15–30 seconds of speech, medium ≈ 45–75s, long ≈ 90–150s.
- Do not wrap the script in markdown code fences.
- Do not invent facts the brief does not support.
- Return ONLY JSON matching this schema:
{
  "title": "short working title",
  "summary": "1-2 sentence description of the angle",
  "script": "full script text with newlines"
}
"""


SCRIPT_REFINE_PROMPT = """You help creators refine an existing social media script via chat.

You receive the current script, optional brief context, recent chat history, and a
new user message. Respond helpfully and keep the script production-ready.

Rules:
- If the user asks for edits, return the FULL updated script (not a diff).
- If they only ask a question or want feedback, keep the script unchanged and
  answer in "reply".
- Preserve useful stage directions unless asked to remove them.
- Match the existing tone/language unless asked to change them.
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
- Video assets → video layers (timed on the timeline like audio), not only backgrounds.
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
