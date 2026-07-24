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
    IMAGE = "image"
    VIDEO = "video"
    AUDIO = "audio"


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
    type: Literal["text", "image", "video", "tts", "audio"] = "text"
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
    # text / tts script
    text: str = ""
    font_size: int = 48
    color: str = "#ffffff"
    font_weight: Literal["normal", "bold"] = "bold"
    # image / generated tts audio / music bed
    asset_id: str | None = None
    use_format: str | None = None
    # text-to-speech / audio mix volume
    tts_voice: str | None = None
    tts_volume: float = 1.0
    # Prosody mood for synthesis (neutral, excited, angry, sad, …).
    tts_mood: str | None = None
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
    layers: list[Layer] = Field(default_factory=list)
    # When set, this slot embeds another video post (typically is_reusable).
    # Local layers/background are ignored; duration follows the source post.
    ref_post_id: str | None = None


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
    # image post
    background_asset_id: str | None = None
    background_format: str = "portrait"
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
    # Expected values: portrait | square | landscape | story
    target_format: str = "portrait"
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


class GenerateTtsAssetRequest(BaseModel):
    """Standalone text-to-audio asset (project-shared or post-private)."""

    text: str
    voice: str | None = None
    mood: str | None = None
    name: str | None = None
    post_id: str | None = None


class PreviewTtsRequest(BaseModel):
    """Synthesize speech for playback without creating an asset."""

    text: str = Field(..., min_length=1, max_length=50000)
    voice: str | None = None
    mood: str | None = None


class GenerateVideoAssetRequest(BaseModel):
    """Text-to-video via local ComfyUI (Wan 2.1). Creates a project video asset."""

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


class CropAssetRequest(BaseModel):
    """Create a new image asset from a normalized crop box on an existing image."""

    # Normalized [left, top, right, bottom] in 0–1 image coordinates.
    box: list[float]
    name: str | None = None
    # When set, overrides inheritance from the source asset's post_id.
    post_id: str | None = None
    set_post_id: bool = False


class VideoEditRequest(BaseModel):
    """Create a new video asset from an existing one (original is never modified).

    Edits are permanent on the new asset — there is no undo. Combine clip,
    speed, and audio options in one pass.
    """

    name: str | None = None
    # Inclusive clip window on the source timeline (seconds). None = full video.
    start_s: float | None = Field(default=None, ge=0)
    end_s: float | None = Field(default=None, gt=0)
    # Playback rate for the output (0.25× … 4×). 1.0 = unchanged.
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    # Drop the source audio track.
    mute: bool = False
    # Replace audio with this project audio asset (mutually exclusive with mute).
    audio_asset_id: str | None = None
    audio_volume: float = Field(default=1.0, ge=0.0, le=2.0)
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
