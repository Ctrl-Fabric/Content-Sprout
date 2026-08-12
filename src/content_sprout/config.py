"""Typed configuration loaded from config.yaml."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator


class StoryConfig(BaseModel):
    fit_mode: Literal["smart_crop", "blur_pad"] = "smart_crop"
    blur_radius: int = 60


class RouterConfig(BaseModel):
    heuristic_confidence_min: float = 0.85
    heuristic_gap_min: float = 0.20
    llm_on_failure: Literal["use_heuristic", "raise"] = "use_heuristic"


class LlmProviderConfig(BaseModel):
    """External multimodal LLM service for placement decisions."""

    provider: Literal["ollama", "proxy", "gemini", "heuristic_only"] = "ollama"


class LlmProxyConfig(BaseModel):
    """OpenAI-compatible API for LLM proxies (PortKey, LiteLLM, OpenRouter, etc.)."""

    base_url: str = "https://api.portkey.ai/v1"
    api_key: str = ""
    model: str = "gpt-4o"
    timeout_s: int = 60
    # PortKey routing headers (optional; ignored by other OpenAI-compatible gateways).
    portkey_provider: str = ""
    portkey_virtual_key: str = ""


class GeminiConfig(BaseModel):
    """Shared Google Gemini credentials for LLM + Nano Banana image generation."""

    api_key: str = ""
    # Text / vision JSON tasks (scripts, layout, placement, …).
    model: str = "gemini-2.5-flash"
    # Optional override for multimodal calls; empty = use ``model``.
    vision_model: str = ""
    timeout_s: int = 120
    # Image generation (Nano Banana / flash-image family).
    image_model: str = "gemini-2.5-flash-image"
    image_timeout_s: int = 180


class HiggsfieldConfig(BaseModel):
    """Higgsfield cloud media generation (async platform API)."""

    api_key_id: str = ""
    api_key_secret: str = ""
    base_url: str = "https://platform.higgsfield.ai"
    # Model endpoint paths relative to base_url (no leading slash required).
    endpoint_text_to_image: str = "higgsfield-ai/soul/standard"
    endpoint_text_to_video: str = ""
    endpoint_image_to_video: str = "higgsfield-ai/dop/standard"
    endpoint_upscale_image: str = ""
    endpoint_upscale_video: str = ""
    timeout_s: int = 900
    poll_interval_s: float = 2.0


MediaBackend = Literal["comfyui", "gemini", "higgsfield"]
MediaOpOverride = Literal["inherit", "comfyui", "gemini", "higgsfield"]
MediaOpName = Literal[
    "text_to_image",
    "text_to_video",
    "image_to_video",
    "upscale_image",
    "upscale_video",
]


class MediaGenConfig(BaseModel):
    """Route Assets generate/upscale jobs across ComfyUI and cloud backends."""

    default_backend: MediaBackend = "comfyui"
    text_to_image: MediaOpOverride = "inherit"
    text_to_video: MediaOpOverride = "inherit"
    image_to_video: MediaOpOverride = "inherit"
    upscale_image: MediaOpOverride = "inherit"
    upscale_video: MediaOpOverride = "inherit"


class ImageGenConfig(BaseModel):
    """Image edit / generation via OpenAI-compatible /images API.

    provider:
      - off: disabled
      - local: local OpenAI-compatible server (API key optional)
      - proxy: cloud or gateway (Portkey, OpenRouter, LiteLLM, OpenAI, …)
    """

    provider: Literal["off", "local", "proxy"] = "off"
    # Kept in sync with provider for older callers/tests (`enabled == provider != off`).
    enabled: bool = False
    base_url: str = "https://api.portkey.ai/v1"
    api_key: str = ""
    model: str = "gpt-image-1"
    timeout_s: int = 120
    portkey_provider: str = ""
    portkey_virtual_key: str = ""

    @model_validator(mode="before")
    @classmethod
    def _migrate_provider(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        provider = out.get("provider")
        if provider not in ("off", "local", "proxy"):
            if out.get("enabled"):
                out["provider"] = "proxy" if (out.get("api_key") or "").strip() else "local"
            else:
                out["provider"] = "off"
        out["enabled"] = out.get("provider", "off") != "off"
        if out.get("provider") == "local" and not (out.get("base_url") or "").strip():
            out["base_url"] = "http://127.0.0.1:8080/v1"
        return out


class ComfyUIConfig(BaseModel):
    """ComfyUI media generation (local or remote) or an OpenAI-compatible video gateway.

    provider:
      - off: disabled
      - local: ComfyUI on this machine (default http://127.0.0.1:8188)
      - proxy: remote ComfyUI host and/or OpenAI-compatible video gateway

    Workflows are referenced by short names stored under ``{config_dir}/workflows/``
    (uploaded copies; no dependency on the original file location).
    """

    provider: Literal["off", "local", "proxy"] = "off"
    enabled: bool = False
    base_url: str = "http://127.0.0.1:8188"
    # Optional Bearer token for remote / protected ComfyUI hosts.
    api_key: str = ""
    timeout_s: int = 900
    poll_interval_s: float = 2.0
    # Deprecated — uploads always go to {config_dir}/workflows/.
    workflows_dir: str = ""
    # Short names (optional .json) resolved under workflows_dir / package workflows/.
    workflow_text_to_image: str = ""
    workflow_text_to_video: str = ""
    workflow_image_to_video: str = ""
    workflow_upscale_image: str = ""
    workflow_upscale_video: str = ""
    # Legacy absolute/relative path for T2V (migrated to workflow_text_to_video on load).
    workflow_path: str = ""
    diffusion_model: str = ""
    clip_name: str = ""
    vae_name: str = ""
    # Internal fallbacks only — generation UIs use fixed size presets.
    width: int = 640
    height: int = 360
    frames: int = 33
    fps: float = 16.0
    steps: int = 30
    cfg: float = 6.0
    # When provider=proxy and gateway_base_url is set, use OpenAI-compatible video API.
    gateway_base_url: str = ""
    gateway_api_key: str = ""
    gateway_model: str = ""
    gateway_timeout_s: int = 600
    portkey_provider: str = ""
    portkey_virtual_key: str = ""
    negative_prompt: str = (
        "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，"
        "整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，"
        "画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，"
        "静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
    )

    @model_validator(mode="before")
    @classmethod
    def _migrate_provider(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        provider = out.get("provider")
        if provider not in ("off", "local", "proxy"):
            out["provider"] = "local" if out.get("enabled") else "off"
        out["enabled"] = out.get("provider", "off") != "off"
        # Migrate legacy workflow_path into short T2V name when unset.
        if not (out.get("workflow_text_to_video") or "").strip():
            legacy = (out.get("workflow_path") or "").strip()
            if legacy:
                stem = Path(legacy).stem
                if stem and "/" not in stem and "\\" not in stem:
                    out["workflow_text_to_video"] = stem
        return out


class StockUploadSite(BaseModel):
    """A configured destination for uploading edited media to stock platforms.

    Major agencies do not expose public contributor REST APIs; uploads go via
    FTPS/SFTP, a webhook you host, or a local submission package + portal.
    """

    id: str = Field(default_factory=lambda: uuid4().hex[:12])
    name: str = "Stock site"
    provider: Literal[
        "shutterstock_ftps",
        "adobe_stock_sftp",
        "generic_ftps",
        "generic_sftp",
        "webhook",
        "package",
    ] = "package"
    enabled: bool = True
    host: str = ""
    port: int | None = None
    username: str = ""
    password: str = ""
    remote_path: str = "/"
    # Optional OpenSSH private key for SFTP (absolute path).
    private_key_path: str = ""
    webhook_url: str = ""
    webhook_token: str = ""
    # Contributor portal opened after upload / for package follow-up.
    portal_url: str = ""
    notes: str = ""


class StockMediaConfig(BaseModel):
    """Free stock browse keys + contributor upload destinations."""

    # Free Pixabay API key unlocks photos/illustrations/vectors/videos.
    # Music, SFX, and 3D on pixabay.com are not exposed via the public API.
    pixabay_api_key: str = ""
    timeout_s: int = 30
    # Max stock imports (Add to project) per local calendar day. 0 = unlimited.
    daily_download_limit: int = 20
    # Pixabay API docs require caching requests for 24 hours (floor enforced below).
    pixabay_cache_ttl_hours: float = 24.0
    # Destinations for uploading *your* edited videos (FTPS / SFTP / webhook / package).
    upload_sites: list[StockUploadSite] = Field(default_factory=list)

    @field_validator("pixabay_cache_ttl_hours", mode="before")
    @classmethod
    def _pixabay_ttl_floor(cls, value: Any) -> float:
        from .pixabay_cache import normalize_ttl_hours

        return normalize_ttl_hours(value)


class MonitoredFolder(BaseModel):
    """A local directory registered in Media Manager for browsing (not auto-watch)."""

    id: str = Field(default_factory=lambda: uuid4().hex[:12])
    label: str = "Folder"
    path: str = ""
    enabled: bool = True


class PublishPlatform(BaseModel):
    """Assisted stock-publish target (contributor portal; no public upload API)."""

    id: str = Field(default_factory=lambda: uuid4().hex[:12])
    label: str = "Stock platform"
    enabled: bool = True
    contributor_url: str = ""
    notes: str = ""


def default_publish_platforms() -> list[PublishPlatform]:
    return [
        PublishPlatform(
            id="pixabay",
            label="Pixabay",
            enabled=True,
            contributor_url="https://pixabay.com/accounts/media/upload/",
            notes="Prepare a package, then upload via Pixabay’s contributor portal.",
        ),
        PublishPlatform(
            id="pexels",
            label="Pexels",
            enabled=True,
            contributor_url="https://www.pexels.com/upload/",
            notes="Prepare a package, then upload via Pexels’ contributor portal.",
        ),
        PublishPlatform(
            id="unsplash",
            label="Unsplash",
            enabled=True,
            contributor_url="https://unsplash.com/upload",
            notes="Prepare a package, then upload via Unsplash’s contributor portal.",
        ),
    ]


class MediaManagerConfig(BaseModel):
    """Media Manager: monitored local folders + assisted stock publish platforms."""

    monitored_folders: list[MonitoredFolder] = Field(default_factory=list)
    publish_platforms: list[PublishPlatform] = Field(default_factory=default_publish_platforms)


class WatchConfig(BaseModel):
    debounce_s: float = 1.5
    settle_checks: int = 2
    settle_interval_s: float = 0.5


class OllamaConfig(BaseModel):
    host: str = "http://localhost:11434"
    model: str = "gemma4:31b"
    timeout_s: int = 60
    num_ctx: int = 4096


class LogoConfig(BaseModel):
    padding_pct: float = 4.0
    width_pct: float = 12.0
    opacity: float = 0.95
    shadow: bool = False


class InstagramConfig(BaseModel):
    """Meta / Instagram Graph API settings for publishing.

    Secrets can be set in config.yaml or overridden via environment variables
    (META_APP_ID, META_APP_SECRET). Tokens are stored in cache after OAuth.
  """

    enabled: bool = False
    app_id: str = ""
    app_secret: str = ""
    graph_api_version: str = "v21.0"
    # Public HTTPS base URL where Meta can fetch images (e.g. ngrok tunnel to this UI).
    public_base_url: str = ""
    oauth_redirect_uri: str = "http://127.0.0.1:17829/api/instagram/callback"
    default_publish_format: str = "portrait"
    # Feed-safe formats only (story is 9:16 and not valid for feed posts).
    publishable_formats: list[str] = Field(
        default_factory=lambda: ["portrait", "square", "landscape"]
    )


class AppConfig(BaseModel):
    input_dir: Path = Path("input")
    output_dir: Path = Path("output")
    projects_dir: Path = Path("projects")
    cache_dir: Path = Path("cache")
    scripts_dir: Path = Path("scripts")
    global_assets_dir: Path = Path("global_assets")
    write_manifest: bool = True
    logo_dark: Path = Path("assets/logo_dark.png")
    logo_white: Path = Path("assets/logo_white.png")
    formats: list[str] = Field(
        default_factory=lambda: ["square", "portrait", "landscape", "story"]
    )
    jpeg_quality: int = 92
    story: StoryConfig = Field(default_factory=StoryConfig)
    router: RouterConfig = Field(default_factory=RouterConfig)
    llm: LlmProviderConfig = Field(default_factory=LlmProviderConfig)
    ollama: OllamaConfig = Field(default_factory=OllamaConfig)
    llm_proxy: LlmProxyConfig = Field(default_factory=LlmProxyConfig)
    gemini: GeminiConfig = Field(default_factory=GeminiConfig)
    image_gen: ImageGenConfig = Field(default_factory=ImageGenConfig)
    comfyui: ComfyUIConfig = Field(default_factory=ComfyUIConfig)
    higgsfield: HiggsfieldConfig = Field(default_factory=HiggsfieldConfig)
    media_gen: MediaGenConfig = Field(default_factory=MediaGenConfig)
    stock_media: StockMediaConfig = Field(default_factory=StockMediaConfig)
    media_manager: MediaManagerConfig = Field(default_factory=MediaManagerConfig)
    watch: WatchConfig = Field(default_factory=WatchConfig)
    logo: LogoConfig = Field(default_factory=LogoConfig)
    instagram: InstagramConfig = Field(default_factory=InstagramConfig)


def _env_override_instagram(cfg: InstagramConfig) -> InstagramConfig:
    import os

    updates: dict[str, str] = {}
    if v := os.environ.get("META_APP_ID"):
        updates["app_id"] = v
    if v := os.environ.get("META_APP_SECRET"):
        updates["app_secret"] = v
    if v := os.environ.get("CONTENT_SPROUT_PUBLIC_BASE_URL"):
        updates["public_base_url"] = v
    if updates:
        return cfg.model_copy(update=updates)
    return cfg


def instagram_env_overrides() -> dict[str, bool]:
    import os

    return {
        "app_id": bool(os.environ.get("META_APP_ID")),
        "app_secret": bool(os.environ.get("META_APP_SECRET")),
        "public_base_url": bool(os.environ.get("CONTENT_SPROUT_PUBLIC_BASE_URL")),
    }


def mask_secret(value: str, *, visible: int = 4) -> str:
    if not value:
        return ""
    if len(value) <= visible:
        return "•" * len(value)
    return value[:visible] + "•" * min(12, len(value) - visible)


def config_to_raw(cfg: AppConfig) -> dict:
    """Serialize AppConfig to a YAML-friendly dict (paths as strings)."""
    return cfg.model_dump(mode="json")


def write_config(path: Path, cfg: AppConfig) -> None:
    """Persist the full AppConfig to disk so it reloads on the next start."""
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.dump(config_to_raw(cfg), default_flow_style=False, sort_keys=False),
        encoding="utf-8",
    )


def load(path: Path = Path("config.yaml")) -> AppConfig:
    """Load AppConfig from a YAML file, falling back to defaults if missing."""
    if not path.exists():
        cfg = AppConfig()
    else:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        if not isinstance(raw, dict):
            raw = {}
        cfg = AppConfig(**raw)
    return cfg.model_copy(
        update={
            "instagram": _env_override_instagram(cfg.instagram),
            "llm_proxy": _env_override_llm_proxy(cfg.llm_proxy),
        }
    )


def load_or_create(path: Path = Path("config.yaml")) -> AppConfig:
    """Load config.yaml, creating it with defaults when absent."""
    path = path.resolve()
    if not path.exists():
        write_config(path, AppConfig())
    return load(path)


def save_storage_settings(config_path: Path, updates: dict) -> AppConfig:
    """Merge storage path settings into config.yaml and return the reloaded config.

    Supported keys: projects_dir, cache_dir, input_dir, output_dir, scripts_dir, global_assets_dir
    """
    config_path = config_path.resolve()
    cfg = load(config_path)
    path_updates: dict[str, Path] = {}
    for key in ("projects_dir", "cache_dir", "input_dir", "output_dir", "scripts_dir", "global_assets_dir"):
        if key not in updates or updates[key] is None:
            continue
        value = str(updates[key]).strip()
        if not value:
            continue
        path_updates[key] = Path(value)
    if path_updates:
        cfg = cfg.model_copy(update=path_updates)
    write_config(config_path, cfg)
    reloaded = load(config_path)
    # Ensure directories exist for the configured locations.
    for key in ("projects_dir", "cache_dir", "input_dir", "output_dir", "scripts_dir", "global_assets_dir"):
        getattr(reloaded, key).mkdir(parents=True, exist_ok=True)
    return reloaded


def save_instagram_settings(config_path: Path, updates: dict) -> InstagramConfig:
    """Merge Instagram settings into config.yaml and return the effective config."""
    raw: dict = {}
    if config_path.exists():
        loaded = yaml.safe_load(config_path.read_text())
        raw = loaded if isinstance(loaded, dict) else {}

    ig = raw.get("instagram")
    ig = dict(ig) if isinstance(ig, dict) else {}

    current = InstagramConfig(**ig)
    merged = current.model_dump()

    secret_update = updates.get("app_secret")
    if secret_update is not None:
        stripped = str(secret_update).strip()
        if stripped:
            merged["app_secret"] = stripped
        updates = {k: v for k, v in updates.items() if k != "app_secret"}

    for key, value in updates.items():
        if key in merged and value is not None:
            merged[key] = value

    raw["instagram"] = merged
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(yaml.dump(raw, default_flow_style=False, sort_keys=False), encoding="utf-8")

    reloaded = load(config_path)
    return reloaded.instagram


def _env_override_llm_proxy(cfg: LlmProxyConfig) -> LlmProxyConfig:
    import os

    if v := os.environ.get("LLM_PROXY_API_KEY"):
        return cfg.model_copy(update={"api_key": v})
    return cfg


def llm_provider_label(cfg: "AppConfig") -> str:
    """Human-readable label for logs and status messages."""
    if cfg.llm.provider == "ollama":
        return f"ollama ({cfg.ollama.model})"
    if cfg.llm.provider == "proxy":
        return f"proxy ({cfg.llm_proxy.model})"
    if cfg.llm.provider == "gemini":
        return f"gemini ({cfg.gemini.model})"
    if cfg.llm.provider == "heuristic_only":
        return "built-in placement"
    return cfg.llm.provider


def gemini_api_key(cfg: "AppConfig") -> str:
    import os

    env = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()
    if env:
        return env
    return (cfg.gemini.api_key or "").strip()


def gemini_ready(cfg: "AppConfig") -> bool:
    return bool(gemini_api_key(cfg))


def gemini_llm_ready(cfg: "AppConfig") -> bool:
    return gemini_ready(cfg) and bool((cfg.gemini.model or "").strip())


def gemini_image_ready(cfg: "AppConfig") -> bool:
    return gemini_ready(cfg) and bool((cfg.gemini.image_model or "").strip())


def higgsfield_ready(cfg: "AppConfig") -> bool:
    hf = cfg.higgsfield
    return bool((hf.api_key_id or "").strip() and (hf.api_key_secret or "").strip())


def higgsfield_endpoint_for_op(cfg: AppConfig | HiggsfieldConfig, op: str) -> str:
    hf = cfg.higgsfield if isinstance(cfg, AppConfig) else cfg
    mapping = {
        "text_to_image": hf.endpoint_text_to_image,
        "text_to_video": hf.endpoint_text_to_video,
        "image_to_video": hf.endpoint_image_to_video,
        "upscale_image": hf.endpoint_upscale_image,
        "upscale_video": hf.endpoint_upscale_video,
    }
    return (mapping.get(op) or "").strip().lstrip("/")


def save_llm_settings(
    config_path: Path, updates: dict
) -> tuple[LlmProviderConfig, OllamaConfig, LlmProxyConfig, GeminiConfig]:
    """Merge LLM settings into config.yaml and return effective configs.

    Supported update keys:
      - provider
      - ollama.host / ollama.model / ollama.timeout_s / ollama.num_ctx
      - llm_proxy.base_url / api_key / model / timeout_s / portkey_*
      - gemini.api_key / model / vision_model / timeout_s / image_model / image_timeout_s
    """
    raw: dict = {}
    if config_path.exists():
        loaded = yaml.safe_load(config_path.read_text())
        raw = loaded if isinstance(loaded, dict) else {}

    llm_raw = raw.get("llm")
    llm_raw = dict(llm_raw) if isinstance(llm_raw, dict) else {}
    current_llm = LlmProviderConfig(**llm_raw)
    merged_llm = current_llm.model_dump()

    if "provider" in updates and updates["provider"] is not None:
        merged_llm["provider"] = updates["provider"]

    oll_raw = raw.get("ollama")
    oll_raw = dict(oll_raw) if isinstance(oll_raw, dict) else {}
    current_oll = OllamaConfig(**oll_raw)
    merged_oll = current_oll.model_dump()

    for key in ("host", "model", "timeout_s", "num_ctx"):
        full_key = f"ollama.{key}"
        if full_key in updates and updates[full_key] is not None:
            merged_oll[key] = updates[full_key]

    proxy_raw = raw.get("llm_proxy")
    proxy_raw = dict(proxy_raw) if isinstance(proxy_raw, dict) else {}
    current_proxy = LlmProxyConfig(**proxy_raw)
    merged_proxy = current_proxy.model_dump()

    secret_update = updates.get("llm_proxy.api_key")
    if secret_update is not None:
        stripped = str(secret_update).strip()
        if stripped:
            merged_proxy["api_key"] = stripped
        updates = {k: v for k, v in updates.items() if k != "llm_proxy.api_key"}

    for key in (
        "base_url",
        "model",
        "timeout_s",
        "portkey_provider",
        "portkey_virtual_key",
    ):
        full_key = f"llm_proxy.{key}"
        if full_key in updates and updates[full_key] is not None:
            merged_proxy[key] = updates[full_key]

    gem_raw = raw.get("gemini")
    gem_raw = dict(gem_raw) if isinstance(gem_raw, dict) else {}
    current_gem = GeminiConfig(**gem_raw)
    merged_gem = current_gem.model_dump()

    gem_secret = updates.get("gemini.api_key")
    if gem_secret is not None:
        stripped = str(gem_secret).strip()
        if stripped:
            merged_gem["api_key"] = stripped
        updates = {k: v for k, v in updates.items() if k != "gemini.api_key"}

    for key in ("model", "vision_model", "timeout_s", "image_model", "image_timeout_s"):
        full_key = f"gemini.{key}"
        if full_key in updates and updates[full_key] is not None:
            merged_gem[key] = updates[full_key]

    raw["llm"] = merged_llm
    raw["ollama"] = merged_oll
    raw["llm_proxy"] = merged_proxy
    raw["gemini"] = merged_gem

    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(yaml.dump(raw, default_flow_style=False, sort_keys=False), encoding="utf-8")

    reloaded = load(config_path)
    return reloaded.llm, reloaded.ollama, reloaded.llm_proxy, reloaded.gemini


def save_image_gen_settings(config_path: Path, updates: dict) -> ImageGenConfig:
    """Merge image generation settings into config.yaml.

    Supported keys: provider, enabled (legacy), base_url, api_key, model, timeout_s,
    portkey_provider, portkey_virtual_key. Blank api_key / virtual_key keeps existing.
    """
    raw: dict = {}
    if config_path.exists():
        loaded = yaml.safe_load(config_path.read_text())
        raw = loaded if isinstance(loaded, dict) else {}

    ig_raw = raw.get("image_gen")
    ig_raw = dict(ig_raw) if isinstance(ig_raw, dict) else {}
    current = ImageGenConfig(**ig_raw)
    merged = current.model_dump()

    for secret_key in ("api_key", "portkey_virtual_key"):
        if secret_key in updates and updates[secret_key] is not None:
            stripped = str(updates[secret_key]).strip()
            if stripped:
                merged[secret_key] = stripped
            updates = {k: v for k, v in updates.items() if k != secret_key}

    if "provider" in updates and updates["provider"] is not None:
        provider = str(updates["provider"]).strip()
        if provider in ("off", "local", "proxy"):
            merged["provider"] = provider
            merged["enabled"] = provider != "off"
    elif "enabled" in updates and updates["enabled"] is not None:
        enabled = bool(updates["enabled"])
        merged["enabled"] = enabled
        if enabled and merged.get("provider") == "off":
            merged["provider"] = "proxy"
        elif not enabled:
            merged["provider"] = "off"

    for key in (
        "base_url",
        "model",
        "timeout_s",
        "portkey_provider",
        "portkey_virtual_key",
    ):
        if key in updates and updates[key] is not None:
            merged[key] = updates[key]

    raw["image_gen"] = merged
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(yaml.dump(raw, default_flow_style=False, sort_keys=False), encoding="utf-8")
    return load(config_path).image_gen


def image_gen_ready(cfg: AppConfig) -> bool:
    ig = cfg.image_gen
    if ig.provider == "off" or not ig.enabled:
        return False
    if not ((ig.base_url or "").strip() and (ig.model or "").strip()):
        return False
    if ig.provider == "proxy":
        # Cloud / gateway usually needs a key (Portkey virtual key alone can count).
        return bool((ig.api_key or "").strip() or (ig.portkey_virtual_key or "").strip())
    # local: key optional
    return True


def save_comfyui_settings(config_path: Path, updates: dict) -> ComfyUIConfig:
    """Merge ComfyUI / video-generation settings into config.yaml."""
    raw: dict = {}
    if config_path.exists():
        loaded = yaml.safe_load(config_path.read_text())
        raw = loaded if isinstance(loaded, dict) else {}

    cu_raw = raw.get("comfyui")
    cu_raw = dict(cu_raw) if isinstance(cu_raw, dict) else {}
    current = ComfyUIConfig(**cu_raw)
    merged = current.model_dump()

    for secret_key in ("api_key", "gateway_api_key", "portkey_virtual_key"):
        if secret_key in updates and updates[secret_key] is not None:
            stripped = str(updates[secret_key]).strip()
            if stripped:
                merged[secret_key] = stripped
            updates = {k: v for k, v in updates.items() if k != secret_key}

    if "provider" in updates and updates["provider"] is not None:
        provider = str(updates["provider"]).strip()
        if provider in ("off", "local", "proxy"):
            merged["provider"] = provider
            merged["enabled"] = provider != "off"
    elif "enabled" in updates and updates["enabled"] is not None:
        enabled = bool(updates["enabled"])
        merged["enabled"] = enabled
        if enabled and merged.get("provider") == "off":
            merged["provider"] = "local"
        elif not enabled:
            merged["provider"] = "off"

    for key in (
        "base_url",
        "timeout_s",
        "poll_interval_s",
        "workflows_dir",
        "workflow_text_to_image",
        "workflow_text_to_video",
        "workflow_image_to_video",
        "workflow_upscale_image",
        "workflow_upscale_video",
        "workflow_path",
        "diffusion_model",
        "clip_name",
        "vae_name",
        "width",
        "height",
        "frames",
        "fps",
        "steps",
        "cfg",
        "negative_prompt",
        "gateway_base_url",
        "gateway_model",
        "gateway_timeout_s",
        "portkey_provider",
    ):
        if key in updates and updates[key] is not None:
            merged[key] = updates[key]

    raw["comfyui"] = merged
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        yaml.dump(raw, default_flow_style=False, sort_keys=False), encoding="utf-8"
    )
    return load(config_path).comfyui


def comfyui_ready(cfg: AppConfig) -> bool:
    """True when ComfyUI / video gateway is configured (connection only)."""
    return video_gen_ready(cfg)


def video_gen_ready(cfg: AppConfig) -> bool:
    cu = cfg.comfyui
    if cu.provider == "off" or not cu.enabled:
        return False
    if cu.provider == "local":
        return bool((cu.base_url or "").strip())
    # proxy: remote ComfyUI and/or OpenAI-compatible video gateway
    if (cu.gateway_base_url or "").strip() and (cu.gateway_model or "").strip():
        return bool((cu.gateway_api_key or "").strip() or (cu.portkey_virtual_key or "").strip())
    return bool((cu.base_url or "").strip())


def video_gen_uses_gateway(cfg: AppConfig) -> bool:
    cu = cfg.comfyui
    return (
        cu.provider == "proxy"
        and bool((cu.gateway_base_url or "").strip())
        and bool((cu.gateway_model or "").strip())
    )


WORKFLOW_OPS = (
    "text_to_image",
    "text_to_video",
    "image_to_video",
    "upscale_image",
    "upscale_video",
)


def comfy_workflow_name_for_op(cfg: AppConfig | ComfyUIConfig, op: str) -> str:
    cu = cfg.comfyui if isinstance(cfg, AppConfig) else cfg
    mapping = {
        "text_to_image": cu.workflow_text_to_image,
        "text_to_video": cu.workflow_text_to_video,
        "image_to_video": cu.workflow_image_to_video,
        "upscale_image": cu.workflow_upscale_image,
        "upscale_video": cu.workflow_upscale_video,
    }
    return (mapping.get(op) or "").strip()


def comfy_op_ready(cfg: AppConfig, op: str, *, config_dir: Path | None = None) -> bool:
    """True when ComfyUI is connected and the named workflow for ``op`` resolves.

    ``text_to_video`` is also ready via the OpenAI-compatible gateway when configured.
    """
    if op == "text_to_video" and video_gen_uses_gateway(cfg):
        return video_gen_ready(cfg)
    if not video_gen_ready(cfg):
        return False
    if video_gen_uses_gateway(cfg):
        return False
    try:
        from .comfyui import resolve_workflow_for_op

        resolve_workflow_for_op(cfg.comfyui, op, config_dir=config_dir)
        return True
    except (FileNotFoundError, ValueError):
        return False


def comfy_ops_ready_map(cfg: AppConfig, *, config_dir: Path | None = None) -> dict[str, bool]:
    return {op: comfy_op_ready(cfg, op, config_dir=config_dir) for op in WORKFLOW_OPS}


def media_op_override(cfg: AppConfig, op: str) -> str:
    mg = cfg.media_gen
    value = getattr(mg, op, "inherit")
    return str(value or "inherit")


def preferred_media_backend(cfg: AppConfig, op: str) -> MediaBackend:
    override = media_op_override(cfg, op)
    if override == "inherit":
        return cfg.media_gen.default_backend
    if override in ("comfyui", "gemini", "higgsfield"):
        return override  # type: ignore[return-value]
    return cfg.media_gen.default_backend


def _backend_supports_media_op(
    cfg: AppConfig,
    backend: str,
    op: str,
    *,
    config_dir: Path | None = None,
) -> bool:
    if backend == "comfyui":
        return comfy_op_ready(cfg, op, config_dir=config_dir)
    if backend == "gemini":
        if op == "text_to_image":
            return gemini_image_ready(cfg)
        if op == "upscale_image":
            # Enhance / regenerate via Gemini image model.
            return gemini_image_ready(cfg)
        return False
    if backend == "higgsfield":
        if not higgsfield_ready(cfg):
            return False
        return bool(higgsfield_endpoint_for_op(cfg, op))
    return False


def resolve_media_backend(
    cfg: AppConfig,
    op: str,
    *,
    config_dir: Path | None = None,
) -> MediaBackend:
    """Pick a ready backend for ``op`` using override → default → fallbacks."""
    preferred = preferred_media_backend(cfg, op)
    candidates: list[MediaBackend] = []
    for backend in (preferred, "comfyui", "higgsfield", "gemini"):
        if backend not in candidates:
            candidates.append(backend)  # type: ignore[arg-type]
    for backend in candidates:
        if _backend_supports_media_op(cfg, backend, op, config_dir=config_dir):
            return backend
    return preferred


def media_op_ready(cfg: AppConfig, op: str, *, config_dir: Path | None = None) -> bool:
    preferred = preferred_media_backend(cfg, op)
    candidates: list[str] = []
    for backend in (preferred, "comfyui", "higgsfield", "gemini"):
        if backend not in candidates:
            candidates.append(backend)
    return any(
        _backend_supports_media_op(cfg, backend, op, config_dir=config_dir)
        for backend in candidates
    )


def media_ops_ready_map(cfg: AppConfig, *, config_dir: Path | None = None) -> dict[str, bool]:
    return {op: media_op_ready(cfg, op, config_dir=config_dir) for op in WORKFLOW_OPS}


def save_media_gen_settings(config_path: Path, updates: dict) -> MediaGenConfig:
    """Merge media_gen routing settings into config.yaml."""
    raw = _load_raw_config(config_path)
    mg_raw = raw.get("media_gen")
    mg_raw = dict(mg_raw) if isinstance(mg_raw, dict) else {}
    current = MediaGenConfig(**mg_raw)
    merged = current.model_dump()

    if "default_backend" in updates and updates["default_backend"] is not None:
        value = str(updates["default_backend"]).strip()
        if value in ("comfyui", "gemini", "higgsfield"):
            merged["default_backend"] = value

    for op in WORKFLOW_OPS:
        if op in updates and updates[op] is not None:
            value = str(updates[op]).strip()
            if value in ("inherit", "comfyui", "gemini", "higgsfield"):
                merged[op] = value

    raw["media_gen"] = merged
    _write_raw_config(config_path, raw)
    return load(config_path).media_gen


def save_higgsfield_settings(config_path: Path, updates: dict) -> HiggsfieldConfig:
    """Merge Higgsfield credentials / endpoints into config.yaml."""
    raw = _load_raw_config(config_path)
    hf_raw = raw.get("higgsfield")
    hf_raw = dict(hf_raw) if isinstance(hf_raw, dict) else {}
    current = HiggsfieldConfig(**hf_raw)
    merged = current.model_dump()

    for secret_key in ("api_key_id", "api_key_secret"):
        if secret_key in updates and updates[secret_key] is not None:
            stripped = str(updates[secret_key]).strip()
            if stripped:
                merged[secret_key] = stripped
            updates = {k: v for k, v in updates.items() if k != secret_key}

    for key in (
        "base_url",
        "endpoint_text_to_image",
        "endpoint_text_to_video",
        "endpoint_image_to_video",
        "endpoint_upscale_image",
        "endpoint_upscale_video",
        "timeout_s",
        "poll_interval_s",
    ):
        if key in updates and updates[key] is not None:
            merged[key] = updates[key]

    raw["higgsfield"] = merged
    _write_raw_config(config_path, raw)
    return load(config_path).higgsfield


def save_stock_media_settings(config_path: Path, updates: dict) -> StockMediaConfig:
    """Merge stock media settings (Pixabay key, upload sites, etc.) into config.yaml."""
    raw: dict = {}
    if config_path.exists():
        loaded = yaml.safe_load(config_path.read_text())
        raw = loaded if isinstance(loaded, dict) else {}

    sm_raw = raw.get("stock_media")
    sm_raw = dict(sm_raw) if isinstance(sm_raw, dict) else {}
    current = StockMediaConfig(**sm_raw)
    merged = current.model_dump()

    if "timeout_s" in updates and updates["timeout_s"] is not None:
        merged["timeout_s"] = int(updates["timeout_s"])
    if "daily_download_limit" in updates and updates["daily_download_limit"] is not None:
        try:
            merged["daily_download_limit"] = max(0, int(updates["daily_download_limit"]))
        except (TypeError, ValueError):
            pass
    if "pixabay_cache_ttl_hours" in updates and updates["pixabay_cache_ttl_hours"] is not None:
        from .pixabay_cache import normalize_ttl_hours

        merged["pixabay_cache_ttl_hours"] = normalize_ttl_hours(updates["pixabay_cache_ttl_hours"])
    if "pixabay_api_key" in updates and updates["pixabay_api_key"]:
        # Blank keeps existing (same pattern as other secrets).
        merged["pixabay_api_key"] = str(updates["pixabay_api_key"]).strip()

    if "upload_sites" in updates and updates["upload_sites"] is not None:
        merged["upload_sites"] = _merge_upload_sites(
            current.upload_sites,
            updates["upload_sites"],
        )

    raw["stock_media"] = merged
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        yaml.dump(raw, default_flow_style=False, sort_keys=False), encoding="utf-8"
    )
    return load(config_path).stock_media


def _merge_upload_sites(
    existing: list[StockUploadSite],
    incoming: list | dict,
) -> list[dict]:
    """Replace upload site list; blank password / token keep prior secrets by id."""
    by_id = {s.id: s for s in existing}
    if isinstance(incoming, dict):
        incoming = [incoming]
    out: list[dict] = []
    for raw in incoming:
        if not isinstance(raw, dict):
            continue
        site_id = str(raw.get("id") or "").strip() or uuid4().hex[:12]
        prev = by_id.get(site_id)
        data = {
            "id": site_id,
            "name": str(raw.get("name") or (prev.name if prev else "Stock site")).strip()[:80]
            or "Stock site",
            "provider": str(raw.get("provider") or (prev.provider if prev else "package")),
            "enabled": bool(raw.get("enabled", prev.enabled if prev else True)),
            "host": str(raw.get("host") if raw.get("host") is not None else (prev.host if prev else "")).strip(),
            "port": raw.get("port") if raw.get("port") not in (None, "") else (prev.port if prev else None),
            "username": str(
                raw.get("username") if raw.get("username") is not None else (prev.username if prev else "")
            ).strip(),
            "password": (prev.password if prev else ""),
            "remote_path": str(
                raw.get("remote_path")
                if raw.get("remote_path") is not None
                else (prev.remote_path if prev else "/")
            ).strip()
            or "/",
            "private_key_path": str(
                raw.get("private_key_path")
                if raw.get("private_key_path") is not None
                else (prev.private_key_path if prev else "")
            ).strip(),
            "webhook_url": str(
                raw.get("webhook_url")
                if raw.get("webhook_url") is not None
                else (prev.webhook_url if prev else "")
            ).strip(),
            "webhook_token": (prev.webhook_token if prev else ""),
            "portal_url": str(
                raw.get("portal_url")
                if raw.get("portal_url") is not None
                else (prev.portal_url if prev else "")
            ).strip(),
            "notes": str(
                raw.get("notes") if raw.get("notes") is not None else (prev.notes if prev else "")
            ).strip()[:500],
        }
        if raw.get("password"):
            data["password"] = str(raw["password"]).strip()
        if raw.get("webhook_token"):
            data["webhook_token"] = str(raw["webhook_token"]).strip()
        if data["port"] is not None:
            try:
                data["port"] = int(data["port"])
            except (TypeError, ValueError):
                data["port"] = prev.port if prev else None
        # Validate via model
        site = StockUploadSite(**data)
        out.append(site.model_dump())
    return out


def stock_upload_sites_public(cfg: AppConfig) -> list[dict]:
    """Upload sites for API/UI with secrets masked (never return raw passwords)."""
    sites = []
    for s in cfg.stock_media.upload_sites:
        sites.append(
            {
                "id": s.id,
                "name": s.name,
                "provider": s.provider,
                "enabled": s.enabled,
                "host": s.host,
                "port": s.port,
                "username": s.username,
                "password_set": bool(s.password),
                "password_masked": mask_secret(s.password) if s.password else "",
                "remote_path": s.remote_path,
                "private_key_path": s.private_key_path,
                "webhook_url": s.webhook_url,
                "webhook_token_set": bool(s.webhook_token),
                "webhook_token_masked": mask_secret(s.webhook_token) if s.webhook_token else "",
                "portal_url": s.portal_url,
                "notes": s.notes,
                "defaults": provider_defaults(s.provider),
            }
        )
    return sites


def provider_defaults(provider: str) -> dict[str, Any]:
    """Suggested host / portal for known stock agencies."""
    presets: dict[str, dict[str, Any]] = {
        "shutterstock_ftps": {
            "host": "ftps.shutterstock.com",
            "port": 21,
            "portal_url": "https://submit.shutterstock.com/",
            "transport": "ftps",
            "label": "Shutterstock (FTPS)",
        },
        "adobe_stock_sftp": {
            "host": "sftp.contributor.adobestock.com",
            "port": 22,
            "portal_url": "https://contributor.stock.adobe.com/",
            "transport": "sftp",
            "label": "Adobe Stock (SFTP)",
        },
        "generic_ftps": {
            "host": "",
            "port": 21,
            "portal_url": "",
            "transport": "ftps",
            "label": "Generic FTPS",
        },
        "generic_sftp": {
            "host": "",
            "port": 22,
            "portal_url": "",
            "transport": "sftp",
            "label": "Generic SFTP",
        },
        "webhook": {
            "host": "",
            "port": None,
            "portal_url": "",
            "transport": "webhook",
            "label": "Custom webhook",
        },
        "package": {
            "host": "",
            "port": None,
            "portal_url": "",
            "transport": "package",
            "label": "Local submission package",
        },
    }
    return presets.get(provider, presets["package"])


def stock_pixabay_key(cfg: AppConfig) -> str:
    import os

    env = (os.environ.get("PIXABAY_API_KEY") or "").strip()
    if env:
        return env
    return (cfg.stock_media.pixabay_api_key or "").strip()


def vision_llm_ready(cfg: AppConfig) -> bool:
    if cfg.llm.provider == "heuristic_only":
        return False
    if cfg.llm.provider == "ollama":
        return True
    if cfg.llm.provider == "proxy":
        return bool(cfg.llm_proxy.api_key)
    if cfg.llm.provider == "gemini":
        return gemini_llm_ready(cfg)
    return False


def _load_raw_config(config_path: Path) -> dict:
    raw: dict = {}
    if config_path.exists():
        loaded = yaml.safe_load(config_path.read_text())
        raw = loaded if isinstance(loaded, dict) else {}
    return raw


def _write_raw_config(config_path: Path, raw: dict) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        yaml.dump(raw, default_flow_style=False, sort_keys=False), encoding="utf-8"
    )


def save_media_manager_folders(
    config_path: Path, folders: list[dict] | list[MonitoredFolder]
) -> MediaManagerConfig:
    """Replace monitored_folders in config.yaml; keep publish_platforms."""
    raw = _load_raw_config(config_path)
    mm_raw = raw.get("media_manager")
    mm_raw = dict(mm_raw) if isinstance(mm_raw, dict) else {}
    current = MediaManagerConfig(**mm_raw)

    cleaned: list[dict] = []
    for item in folders:
        if isinstance(item, MonitoredFolder):
            data = item.model_dump()
        elif isinstance(item, dict):
            data = dict(item)
        else:
            continue
        folder_id = str(data.get("id") or "").strip() or uuid4().hex[:12]
        label = str(data.get("label") or "Folder").strip()[:80] or "Folder"
        path = str(data.get("path") or "").strip()
        if not path:
            continue
        folder = MonitoredFolder(
            id=folder_id,
            label=label,
            path=path,
            enabled=bool(data.get("enabled", True)),
        )
        cleaned.append(folder.model_dump())

    mm_raw["monitored_folders"] = cleaned
    mm_raw["publish_platforms"] = [p.model_dump() for p in current.publish_platforms]
    raw["media_manager"] = mm_raw
    _write_raw_config(config_path, raw)
    return load(config_path).media_manager


def save_media_manager_platforms(
    config_path: Path, platforms: list[dict] | list[PublishPlatform]
) -> MediaManagerConfig:
    """Replace publish_platforms in config.yaml; keep monitored_folders."""
    raw = _load_raw_config(config_path)
    mm_raw = raw.get("media_manager")
    mm_raw = dict(mm_raw) if isinstance(mm_raw, dict) else {}
    current = MediaManagerConfig(**mm_raw)

    cleaned: list[dict] = []
    for item in platforms:
        if isinstance(item, PublishPlatform):
            data = item.model_dump()
        elif isinstance(item, dict):
            data = dict(item)
        else:
            continue
        platform_id = str(data.get("id") or "").strip() or uuid4().hex[:12]
        label = str(data.get("label") or "Stock platform").strip()[:80] or "Stock platform"
        platform = PublishPlatform(
            id=platform_id,
            label=label,
            enabled=bool(data.get("enabled", True)),
            contributor_url=str(data.get("contributor_url") or "").strip()[:500],
            notes=str(data.get("notes") or "").strip()[:500],
        )
        cleaned.append(platform.model_dump())

    if not cleaned:
        cleaned = [p.model_dump() for p in default_publish_platforms()]

    mm_raw["monitored_folders"] = [f.model_dump() for f in current.monitored_folders]
    mm_raw["publish_platforms"] = cleaned
    raw["media_manager"] = mm_raw
    _write_raw_config(config_path, raw)
    return load(config_path).media_manager


def media_manager_public(cfg: AppConfig) -> dict:
    """Serialize media_manager for API responses."""
    mm = cfg.media_manager
    return {
        "monitored_folders": [f.model_dump() for f in mm.monitored_folders],
        "publish_platforms": [p.model_dump() for p in mm.publish_platforms],
    }