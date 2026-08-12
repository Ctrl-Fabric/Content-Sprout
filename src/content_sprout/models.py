"""Data models for projects, posts, assets, and compositions."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def new_id() -> str:
    return uuid4().hex[:12]


class ProjectType(str, Enum):
    IMAGE = "image"
    VIDEO = "video"


class AssetType(str, Enum):
    """Stored asset kinds.

    Legacy ``image`` / ``audio`` remain valid for older projects. Newer uploads use
    the finer types (photo, illustration, vector, music, sound, model).
    """

    IMAGE = "image"
    PHOTO = "photo"
    ILLUSTRATION = "illustration"
    VECTOR = "vector"
    VIDEO = "video"
    AUDIO = "audio"
    MUSIC = "music"
    SOUND = "sound"
    MODEL = "model"


IMAGE_ASSET_TYPES = frozenset(
    {AssetType.IMAGE, AssetType.PHOTO, AssetType.ILLUSTRATION, AssetType.VECTOR}
)
# Raster types that go through Instagram format processing.
PROCESSABLE_IMAGE_TYPES = frozenset(
    {AssetType.IMAGE, AssetType.PHOTO, AssetType.ILLUSTRATION}
)
AUDIO_ASSET_TYPES = frozenset({AssetType.AUDIO, AssetType.MUSIC, AssetType.SOUND})
VIDEO_ASSET_TYPES = frozenset({AssetType.VIDEO})
MODEL_ASSET_TYPES = frozenset({AssetType.MODEL})


def _as_asset_type(value: AssetType | str | None) -> AssetType | None:
    if value is None:
        return None
    if isinstance(value, AssetType):
        return value
    raw = str(value).strip().lower()
    if not raw:
        return None
    aliases = {
        "images": "image",
        "photos": "photo",
        "illustrations": "illustration",
        "vectors": "vector",
        "videos": "video",
        "music": "music",
        "sfx": "sound",
        "soundeffect": "sound",
        "sound_effect": "sound",
        "soundeffects": "sound",
        "3d": "model",
        "3dmodel": "model",
        "model_3d": "model",
        "models": "model",
    }
    raw = aliases.get(raw, raw)
    try:
        return AssetType(raw)
    except ValueError:
        return None


def parse_asset_type(value: AssetType | str | None) -> AssetType | None:
    return _as_asset_type(value)


def is_image_asset(value: AssetType | str | None) -> bool:
    t = _as_asset_type(value)
    return t in IMAGE_ASSET_TYPES if t else False


def is_processable_image(value: AssetType | str | None) -> bool:
    t = _as_asset_type(value)
    return t in PROCESSABLE_IMAGE_TYPES if t else False


def is_audio_asset(value: AssetType | str | None) -> bool:
    t = _as_asset_type(value)
    return t in AUDIO_ASSET_TYPES if t else False


def is_video_asset(value: AssetType | str | None) -> bool:
    t = _as_asset_type(value)
    return t in VIDEO_ASSET_TYPES if t else False


def is_model_asset(value: AssetType | str | None) -> bool:
    t = _as_asset_type(value)
    return t in MODEL_ASSET_TYPES if t else False


def asset_family(value: AssetType | str | None) -> str | None:
    """Return ``image`` / ``video`` / ``audio`` / ``model`` for layer/render routing."""
    if is_image_asset(value):
        return "image"
    if is_video_asset(value):
        return "video"
    if is_audio_asset(value):
        return "audio"
    if is_model_asset(value):
        return "model"
    return None


class AssetStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    READY = "ready"
    FAILED = "failed"


TransitionType = Literal["none", "fade-in", "fade-out"]


class LayerMask(BaseModel):
    """Hole punched through a layer so content below shows through.

    Coordinates are percentages of the parent layer box (0–100).
    Only ``transparency`` rects are supported for now.

    Timing is relative to the parent layer's local clock (``start_s`` = 0 when
    the layer begins). ``duration_s`` None means until the parent layer ends.
    """

    id: str = Field(default_factory=new_id)
    type: Literal["rect"] = "rect"
    kind: Literal["transparency"] = "transparency"
    # Optional label for list/timeline; empty falls back to "Mask N".
    title: str = ""
    x: float = 25.0
    y: float = 25.0
    width: float = 40.0
    height: float = 40.0
    # Video timing relative to parent layer local time
    start_s: float = 0.0
    duration_s: float | None = None


class Layer(BaseModel):
    id: str = Field(default_factory=new_id)
    type: Literal["text", "image", "video", "tts", "audio", "icon"] = "text"
    # Optional label for list/timeline; empty falls back to type-based defaults.
    title: str = ""
    x: float = 10.0
    y: float = 10.0
    width: float = 40.0
    height: float = 20.0
    rotation: float = 0.0
    opacity: float = 1.0
    z_index: int = 0
    transition_in: TransitionType = "none"
    transition_out: TransitionType = "none"
    # video timing (seconds within parent scene; ignored for image posts)
    start_s: float = 0.0
    duration_s: float | None = None  # None = until scene end; TTS sets from audio length
    # Media in-point for video layers: source_t = source_start_s + layer_local_t.
    source_start_s: float = 0.0
    # Shared by pieces created by splitting one video clip on the timeline.
    clip_group_id: str | None = None
    # text / tts script
    text: str = ""
    font_size: int = 48
    color: str = "#ffffff"
    font_weight: Literal["normal", "bold"] = "bold"
    # Built-in icon packs (Material Symbols / Lucide) — no asset_id required.
    icon_set: str = "material"
    icon_name: str = ""
    # image / generated tts audio / music bed
    asset_id: str | None = None
    use_format: str | None = None
    # text-to-speech / audio mix volume
    tts_voice: str | None = None
    tts_volume: float = 1.0
    # When true, omit this video layer's embedded audio from preview/export.
    mute_audio: bool = False
    # Prosody mood for synthesis (neutral, excited, angry, sad, …).
    tts_mood: str | None = None
    # Speaking pace for synthesis (very_slow | slow | natural | brisk | fast).
    tts_pacing: str | None = None
    show_caption: bool = False  # legacy; TTS script is never drawn on preview/export
    # Transparency holes relative to this layer's box (image/video).
    masks: list[LayerMask] = Field(default_factory=list)


class Scene(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str = "Scene"
    duration_s: float = 5.0
    # Silence/empty time before this scene on the absolute timeline (scenes never overlap).
    gap_before_s: float = 0.0
    background_asset_id: str | None = None
    background_format: str = "portrait"
    # Solid fill behind layers when no background asset is set (CSS hex).
    background_color: str | None = None
    layers: list[Layer] = Field(default_factory=list)
    # When set, this slot embeds another video post (typically is_reusable).
    # Local layers/background are ignored; duration follows the source post.
    ref_post_id: str | None = None


class IdeationReference(BaseModel):
    """A link, media pointer, or text clip collected during post ideation."""

    id: str = Field(default_factory=new_id)
    kind: Literal["url", "image", "video", "file", "text"] = "url"
    title: str = ""
    url: str = ""
    asset_id: str | None = None
    note: str = ""
    created_at: str = Field(default_factory=_now_iso)


class Post(BaseModel):
    """A single image or video post within a project."""

    id: str = Field(default_factory=new_id)
    name: str = "Untitled post"
    type: ProjectType = ProjectType.IMAGE
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)
    target_format: str = "portrait"
    # When true, this video post can be inserted into other video posts as a timeline slot.
    is_reusable: bool = False
    # Last voice chosen for a text-to-audio layer on this post (used as default for new layers).
    default_tts_voice: str | None = None
    # Script Generator: which saved script is active for this post (one at a time).
    active_script_id: str | None = None
    # Ideation step: freeform notes and collected references (URLs, media, clips).
    ideation_notes: str = ""
    ideation_references: list[IdeationReference] = Field(default_factory=list)
    # Distribution targets set during ideation (not part of the script brief).
    platforms: list[str] = Field(default_factory=lambda: ["youtube"])
    video_format: str = "1080p"  # 4k | 1440p | 1080p | 720p | standard
    # image post
    background_asset_id: str | None = None
    background_format: str = "portrait"
    background_color: str | None = None
    layers: list[Layer] = Field(default_factory=list)
    # video post
    scenes: list[Scene] = Field(default_factory=list)
    # Legacy post-level music (migrated to an audio layer on load when present).
    music_asset_id: str | None = None
    music_volume: float = 0.8


# Backward-compatible alias used by older call sites during migration.
PostComposition = Post


class Asset(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
    type: AssetType
    group: str = ""  # optional library group, e.g. "Branding"
    # None = project-level (shared). Set = owned by that post only.
    post_id: str | None = None
    apply_logo: bool = False
    status: AssetStatus = AssetStatus.PENDING
    original_filename: str  # basename of the upload only (display / zip); not a filesystem source
    original_path: str  # project-relative path to the owned copy (assets/<id>/original.*)
    # Stock imports: encrypted at rest; blocked from download / zip / re-upload.
    locked: bool = False
    source: str = ""  # e.g. pixabay, openverse
    processed_formats: dict[str, str] = Field(default_factory=dict)
    # AI-generated catalog description (vision/JSON LLM); empty until generated.
    description: str = ""
    # Media probe (video/audio) filled at ingest when ffprobe is available.
    duration_s: float | None = None
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    has_audio: bool | None = None
    container: str | None = None  # e.g. MP4, MOV, MKV
    video_codec: str | None = None  # e.g. H.264, H.265
    audio_codec: str | None = None
    bitrate_kbps: int | None = None
    file_size_bytes: int | None = None
    error: str | None = None
    # Human-readable progress for long-running jobs (ComfyUI generate/upscale).
    job_message: str | None = None
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)


class ProjectMediaFolder(BaseModel):
    """Local directory bookmark registered in Media Manager for this project."""

    id: str = Field(default_factory=new_id)
    label: str = "Folder"
    path: str = ""
    enabled: bool = True


class Project(BaseModel):
    id: str = Field(default_factory=new_id)
    name: str
    created_at: str = Field(default_factory=_now_iso)
    updated_at: str = Field(default_factory=_now_iso)
    assets: list[Asset] = Field(default_factory=list)
    posts: list[Post] = Field(default_factory=list)
    # Named library folders (e.g. "Branding"); may be empty until assets are assigned.
    asset_groups: list[str] = Field(default_factory=list)
    # Media Manager bookmarks for this project (external paths; files stay on disk).
    monitored_folders: list[ProjectMediaFolder] = Field(default_factory=list)
    # Project branding logos — stored as normal assets; paths are relative to the
    # project dir (typically assets/<id>/original.png) and mirrored in config.
    # All four slots are optional: dark/light × short/full.
    logo_dark_short_asset_id: str | None = None
    logo_dark_short_path: str | None = None
    logo_dark_full_asset_id: str | None = None
    logo_dark_full_path: str | None = None
    logo_light_short_asset_id: str | None = None
    logo_light_short_path: str | None = None
    logo_light_full_asset_id: str | None = None
    logo_light_full_path: str | None = None


class ProjectSummary(BaseModel):
    id: str
    name: str
    created_at: str
    updated_at: str
    asset_count: int = 0
    post_count: int = 0
    has_project_logos: bool = False


class UpdateProjectLogosRequest(BaseModel):
    """Clear project logo config references (assets are kept)."""

    clear_dark_short: bool = False
    clear_dark_full: bool = False
    clear_light_short: bool = False
    clear_light_full: bool = False


class PostSummary(BaseModel):
    id: str
    name: str
    type: ProjectType
    created_at: str
    updated_at: str
    target_format: str = "portrait"
    is_reusable: bool = False


class CreateProjectRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class CreatePostRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    type: ProjectType
    # Orientation: portrait | landscape
    target_format: str = "portrait"
    platforms: list[str] = Field(default_factory=lambda: ["youtube"])
    video_format: str = "1080p"
    is_reusable: bool = False


class UpdatePostRequest(BaseModel):
    post: Post


class UpdateAssetRequest(BaseModel):
    apply_logo: bool | None = None
    group: str | None = None
    name: str | None = None
    description: str | None = None
    # When present in the PATCH body: None/"" = project-shared; otherwise post id.
    post_id: str | None = None


class CreateAssetGroupRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)


class RenderRequest(BaseModel):
    post_id: str
    scene_id: str | None = None
    time_s: float | None = None  # preview frame time within scene (video)
    # Absolute timeline time; expands reusable post refs when set.
    abs_time_s: float | None = None


class SynthesizeTtsRequest(BaseModel):
    post_id: str
    scene_id: str
    layer_id: str
    text: str | None = None
    voice: str | None = None
    volume: float | None = None
    mood: str | None = None
    pacing: str | None = None


class GenerateTtsAssetRequest(BaseModel):
    """Standalone text-to-audio asset (project-shared or post-private)."""

    text: str
    voice: str | None = None
    mood: str | None = None
    pacing: str | None = None
    name: str | None = None
    post_id: str | None = None


class PreviewTtsRequest(BaseModel):
    """Synthesize speech for playback without creating an asset."""

    text: str = Field(..., min_length=1, max_length=50000)
    voice: str | None = None
    mood: str | None = None
    pacing: str | None = None


class GenerateVideoAssetRequest(BaseModel):
    """Text-to-video via ComfyUI (or gateway). Creates a project video asset."""

    prompt: str = Field(..., min_length=1, max_length=4000)
    negative_prompt: str | None = None
    name: str | None = None
    post_id: str | None = None
    width: int | None = Field(default=None, ge=16, le=2048)
    height: int | None = Field(default=None, ge=16, le=2048)
    frames: int | None = Field(default=None, ge=1, le=257)
    fps: float | None = Field(default=None, ge=1, le=60)
    steps: int | None = Field(default=None, ge=1, le=100)
    cfg: float | None = Field(default=None, ge=0, le=30)
    seed: int | None = None


class GenerateImageAssetRequest(BaseModel):
    """Text-to-image via ComfyUI. Creates a project image asset."""

    prompt: str = Field(..., min_length=1, max_length=4000)
    negative_prompt: str | None = None
    name: str | None = None
    post_id: str | None = None
    width: int | None = Field(default=None, ge=16, le=2048)
    height: int | None = Field(default=None, ge=16, le=2048)
    steps: int | None = Field(default=None, ge=1, le=100)
    cfg: float | None = Field(default=None, ge=0, le=30)
    seed: int | None = None


class GenerateVideoFromImageRequest(BaseModel):
    """Image + text → video via ComfyUI."""

    prompt: str = Field(..., min_length=1, max_length=4000)
    image_asset_id: str = Field(..., min_length=1)
    negative_prompt: str | None = None
    name: str | None = None
    post_id: str | None = None
    width: int | None = Field(default=None, ge=16, le=2048)
    height: int | None = Field(default=None, ge=16, le=2048)
    frames: int | None = Field(default=None, ge=1, le=257)
    fps: float | None = Field(default=None, ge=1, le=60)
    steps: int | None = Field(default=None, ge=1, le=100)
    cfg: float | None = Field(default=None, ge=0, le=30)
    seed: int | None = None


class UpscaleAssetRequest(BaseModel):
    """Upscale an image or video asset via ComfyUI (new edited asset)."""

    scale: float = Field(..., gt=1, le=2)
    name: str | None = None
    post_id: str | None = None
    set_post_id: bool = False


class CropAssetRequest(BaseModel):
    """Create a new image asset from a normalized crop box on an existing image."""

    # Normalized [left, top, right, bottom] in 0–1 image coordinates.
    box: list[float]
    name: str | None = None
    # When set, overrides inheritance from the source asset's post_id.
    post_id: str | None = None
    set_post_id: bool = False


class PhotoEditRequest(BaseModel):
    """Apply crop / resize / color / transform ops to an image asset.

    By default creates a new Edited images asset (source unchanged). When
    ``overwrite`` is true and the source is already an edited image, replaces
    that asset's file in place. There is no undo.
    """

    name: str | None = None
    # Ordered Pillow ops: brightness, contrast, saturation, blur, sharpen,
    # crop, rotate, flip, grade, resize, apply_logo.
    ops: list[dict] = Field(default_factory=list)
    # Replace the source edited asset in place (only for Edited images group).
    overwrite: bool = False
    # When set, overrides inheritance from the source asset's post_id.
    post_id: str | None = None
    set_post_id: bool = False


class GenerateVideoThumbRequest(BaseModel):
    """Extract a still frame from a video asset and save it as the library thumbnail."""

    # Timeline position in seconds. None = auto (≈10% in, capped at 1s).
    time_s: float | None = Field(default=None, ge=0)


class VideoRemoveRange(BaseModel):
    """A contiguous span on the source timeline to cut out of the output."""

    start_s: float = Field(..., ge=0)
    end_s: float = Field(..., gt=0)


class VideoEditRequest(BaseModel):
    """Create a new video asset from an existing one, or overwrite an edited asset.

    Edits are permanent — there is no undo. Combine clip, cut-outs, speed,
    aspect crop, rotate, and audio options in one pass.

    When ``overwrite`` is true, the source must already be in the Edited videos
    group; its file is replaced in place instead of creating a duplicate.
    """

    name: str | None = None
    # Inclusive clip window on the source timeline (seconds). None = full video.
    start_s: float | None = Field(default=None, ge=0)
    end_s: float | None = Field(default=None, gt=0)
    # Ranges to remove from inside the clip window (source timeline seconds).
    # Remaining keep-segments are concatenated in order.
    remove_ranges: list[VideoRemoveRange] = Field(default_factory=list)
    # Playback rate for the output (0.25× … 4×). 1.0 = unchanged.
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    # Preset naming / scale target. "custom" keeps cropped size (max edge 1920).
    aspect_ratio: Literal["original", "square", "portrait", "landscape", "story", "custom"] = (
        "original"
    )
    # Clockwise rotation applied before crop (90° snaps only).
    rotate_deg: Literal[0, 90, 180, 270] = 0
    # Crop rectangle in post-rotate source pixels. All four must be set together.
    crop_x: float | None = Field(default=None, ge=0)
    crop_y: float | None = Field(default=None, ge=0)
    crop_w: float | None = Field(default=None, gt=0)
    crop_h: float | None = Field(default=None, gt=0)
    # Drop the source audio track.
    mute: bool = False
    # Replace audio with this project audio asset (mutually exclusive with mute).
    audio_asset_id: str | None = None
    audio_volume: float = Field(default=1.0, ge=0.0, le=2.0)
    # Replace the source edited asset in place (only for Edited videos group).
    overwrite: bool = False
    # When set, overrides inheritance from the source asset's post_id.
    post_id: str | None = None
    set_post_id: bool = False


class StockUploadRequest(BaseModel):
    """Upload (or package) a project video asset to configured stock destinations."""

    site_ids: list[str] = Field(..., min_length=1)
    title: str = Field(..., min_length=1, max_length=200)
    description: str = ""
    keywords: list[str] = Field(default_factory=list)
    category: str = ""
    filename: str | None = None


class StockUploadSiteTestRequest(BaseModel):
    """Test connectivity for one upload site (by id, or inline draft fields)."""

    site_id: str | None = None
    # Optional draft override for unsaved settings forms.
    site: dict | None = None
