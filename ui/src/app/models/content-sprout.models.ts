export type AssetType =
  | 'image'
  | 'photo'
  | 'illustration'
  | 'vector'
  | 'video'
  | 'audio'
  | 'music'
  | 'sound'
  | 'model';

export type PostType = 'image' | 'video';

export interface ProjectSummary {
  id: string;
  name: string;
  created_at?: string;
  updated_at?: string;
  asset_count?: number;
  post_count?: number;
  has_project_logos?: boolean;
}

export interface Asset {
  id: string;
  name: string;
  type: AssetType | string;
  group?: string;
  post_id?: string | null;
  apply_logo?: boolean;
  status?: string;
  original_filename?: string;
  original_path?: string;
  locked?: boolean;
  source?: string;
  processed_formats?: Record<string, string>;
  description?: string;
  error?: string | null;
  duration_s?: number | null;
  width?: number | null;
  height?: number | null;
  file_size_bytes?: number | null;
  job_message?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PostSummary {
  id: string;
  name: string;
  type: PostType | string;
  created_at?: string;
  updated_at?: string;
  target_format?: string;
  video_format?: string;
  is_reusable?: boolean;
}

export interface IdeationReference {
  id?: string;
  kind?: 'url' | 'image' | 'video' | 'file' | 'text' | string;
  title?: string;
  url?: string;
  asset_id?: string | null;
  note?: string;
  created_at?: string;
}

/** Timed transparency hole; x/y/w/h are % of the parent layer box. Timing is layer-local. */
export interface LayerMask {
  id: string;
  type?: 'rect' | string;
  kind?: 'transparency' | string;
  title?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  start_s?: number;
  duration_s?: number | null;
}

export type TransitionKind = 'none' | 'fade-in' | 'fade-out' | 'fly-in' | 'fly-out';
export type TransitionDirection = 'N' | 'S' | 'W' | 'E' | 'NE' | 'NW' | 'SE' | 'SW';

/** Layer / scene kept loose — canvas editor owns full fidelity later. */
export interface Layer {
  id: string;
  type?: string;
  title?: string;
  /** When false, ignored in preview/export (still shown on the timeline). */
  enabled?: boolean;
  /** True when created from script → timeline (subtitle / voice source). */
  from_script?: boolean;
  asset_id?: string | null;
  text?: string;
  start_s?: number;
  duration_s?: number | null;
  source_start_s?: number;
  /** Video playback speed (0.5–20). Timeline length is source duration ÷ rate. */
  playback_rate?: number;
  clip_group_id?: string | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  z_index?: number;
  opacity?: number;
  transition_in?: TransitionKind | string;
  transition_out?: TransitionKind | string;
  transition_in_direction?: TransitionDirection | null;
  transition_out_direction?: TransitionDirection | null;
  transition_in_duration_s?: number | null;
  transition_out_duration_s?: number | null;
  mute_audio?: boolean;
  font_size?: number;
  color?: string;
  font_weight?: string;
  icon_set?: string;
  icon_name?: string;
  tts_volume?: number;
  show_caption?: boolean;
  /** Nested reusable video post when type === 'ref'. */
  ref_post_id?: string | null;
  masks?: LayerMask[];
  [key: string]: unknown;
}

export interface Scene {
  id: string;
  name?: string;
  duration_s?: number;
  gap_before_s?: number;
  /** When false, skipped in preview/export timing (still editable). */
  enabled?: boolean;
  background_asset_id?: string | null;
  background_format?: string;
  background_color?: string | null;
  /** When true, Asset Manager offers a Scene visual plate for this scene. */
  allow_background_visual?: boolean;
  layers?: Layer[];
  /** @deprecated Prefer a layer with type 'ref'. Migrated on save. */
  ref_post_id?: string | null;
  [key: string]: unknown;
}

export interface Post extends PostSummary {
  ideation_notes?: string;
  ideation_references?: IdeationReference[];
  platforms?: string[];
  video_format?: string;
  default_tts_voice?: string | null;
  active_script_id?: string | null;
  background_asset_id?: string | null;
  background_format?: string;
  background_color?: string | null;
  layers?: Layer[];
  scenes?: Scene[];
  music_asset_id?: string | null;
  music_volume?: number;
  publish_attempts?: PublishAttempt[];
}

export type ScriptSource = 'generated' | 'refined' | 'edited' | 'manual';

export interface ScriptBrief {
  topic?: string;
  tone?: string;
  length?: string;
  duration_s?: number | null;
  audience?: string;
  language?: string;
  notes?: string;
  platforms?: string[];
  platform?: string;
  format?: string;
  orientation?: string;
}

export interface ScriptChatTurn {
  role: string;
  content: string;
}

export interface ScriptMarker {
  id?: string;
  name: string;
  time_s?: number;
}

export interface ScriptSummary {
  id: string;
  title: string;
  summary?: string;
  source?: ScriptSource | string;
  frozen?: boolean;
  word_count?: number;
  createdAt?: string;
  updatedAt?: string;
  preview?: string;
  active?: boolean;
}

export interface ScriptDocument extends ScriptSummary {
  script: string;
  chat?: ScriptChatTurn[];
  brief?: ScriptBrief;
  markers?: ScriptMarker[];
}

export interface ScriptListResponse {
  scripts: ScriptSummary[];
  active_script_id?: string | null;
  post?: Post;
}

export interface ScriptMutationResponse {
  script: ScriptDocument;
  active_script_id?: string | null;
  post?: Post;
}

export interface CreateScriptPayload {
  title?: string;
  summary?: string;
  script?: string;
  chat?: ScriptChatTurn[];
  brief?: ScriptBrief;
  markers?: ScriptMarker[];
  source?: ScriptSource;
  frozen?: boolean;
  activate?: boolean;
}

export interface UpdateScriptPayload {
  title?: string;
  summary?: string;
  script?: string;
  chat?: ScriptChatTurn[];
  brief?: ScriptBrief;
  markers?: ScriptMarker[];
  source?: ScriptSource;
  frozen?: boolean;
  activate?: boolean;
}

export interface AiScriptGeneratePayload {
  topic: string;
  tone?: string;
  length?: string;
  duration_s?: number | null;
  audience?: string;
  language?: string;
  notes?: string;
  ideation_notes?: string;
  platforms?: string[];
  format?: string;
  orientation?: string;
}

export interface AiScriptGenerateResult {
  title: string;
  summary: string;
  script: string;
}

export interface AiScriptRefinePayload {
  script: string;
  message: string;
  history?: ScriptChatTurn[];
  topic?: string;
  tone?: string;
  ideation_notes?: string;
}

export interface AiScriptRefineResult {
  reply: string;
  summary: string;
  script: string;
}

export interface Project extends ProjectSummary {
  assets?: Asset[];
  posts?: Post[];
  asset_groups?: string[];
  monitored_folders?: ProjectMediaFolder[];
  social_accounts?: ProjectSocialAccount[];
  logo_dark_short_asset_id?: string | null;
  logo_dark_short_path?: string | null;
  logo_dark_full_asset_id?: string | null;
  logo_dark_full_path?: string | null;
  logo_light_short_asset_id?: string | null;
  logo_light_short_path?: string | null;
  logo_light_full_asset_id?: string | null;
  logo_light_full_path?: string | null;
}

export interface CreatePostPayload {
  name: string;
  type: PostType;
  target_format?: string;
  is_reusable?: boolean;
}

export interface UploadAssetOptions {
  group?: string;
  apply_logo?: boolean;
  post_id?: string | null;
  asset_type?: string;
}

export interface TtsVoiceInfo {
  id: string;
  name: string;
  locale?: string;
  region?: string;
  region_label?: string;
  engine?: string;
  sample?: string;
}

export interface TtsChoice {
  id: string;
  label: string;
}

export interface TtsVoicesResponse {
  engines?: string[];
  default_voice?: string | null;
  voices?: TtsVoiceInfo[];
  regions?: { id: string; label: string }[];
  moods?: Array<string | TtsChoice>;
  pacings?: Array<string | TtsChoice>;
  available?: boolean;
}

export interface GenerateTtsAssetOptions {
  text: string;
  voice?: string | null;
  mood?: string | null;
  pacing?: string | null;
  name?: string | null;
  post_id?: string | null;
}

export interface SynthesizeTtsOptions {
  scene_id: string;
  layer_id: string;
  text?: string | null;
  voice?: string | null;
  mood?: string | null;
  pacing?: string | null;
  volume?: number | null;
}

export interface PatchAssetPayload {
  name?: string;
  group?: string;
  description?: string;
  apply_logo?: boolean;
  /** `null` / `''` promotes to project-shared when sent. */
  post_id?: string | null;
}

export interface ProjectMediaFolder {
  id: string;
  label: string;
  path: string;
  enabled: boolean;
}

export interface MediaFileInfo {
  path: string;
  name: string;
  type: string;
  size: number;
  size_human?: string;
  modified?: string;
  suffix?: string;
}

export interface MediaBrowseResult {
  path: string;
  name: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  roots?: { label: string; path: string }[];
}

export interface PublishPlatform {
  id: string;
  label: string;
  enabled: boolean;
  contributor_url: string;
  notes?: string;
}

export interface PublishPackagePlatform {
  id?: string;
  label?: string;
  contributor_url?: string;
}

export interface PublishPackage {
  id: string;
  status: 'draft' | 'opened' | 'submitted' | string;
  title?: string;
  description?: string;
  tags?: string[];
  folder_id?: string;
  platforms?: PublishPackagePlatform[];
  file_count?: number;
  files?: string[];
  created_at?: string;
  updated_at?: string;
  package_dir?: string;
}

export interface GlobalAssetsResponse {
  assets: Asset[];
  groups: string[];
}

export interface StorageSettings {
  config_path?: string;
  projects_dir?: string;
  cache_dir?: string;
  input_dir?: string;
  output_dir?: string;
  scripts_dir?: string;
  projects_dir_resolved?: string;
  cache_dir_resolved?: string;
  scripts_dir_resolved?: string;
}

export interface LlmSettings {
  provider?: 'ollama' | 'proxy' | 'gemini' | 'heuristic_only' | string;
  ollama?: {
    host?: string;
    model?: string;
    timeout_s?: number;
  };
  proxy?: {
    base_url?: string;
    api_key_set?: boolean;
    api_key_masked?: string;
    model?: string;
    timeout_s?: number;
    portkey_provider?: string;
    portkey_virtual_key_set?: boolean;
    portkey_virtual_key_masked?: string;
  };
  gemini?: {
    api_key_set?: boolean;
    api_key_masked?: string;
    model?: string;
    vision_model?: string;
    timeout_s?: number;
    image_model?: string;
    image_timeout_s?: number;
    ready?: boolean;
    image_ready?: boolean;
  };
  image_gen?: {
    provider?: 'off' | 'local' | 'proxy' | string;
    enabled?: boolean;
    base_url?: string;
    api_key_set?: boolean;
    api_key_masked?: string;
    model?: string;
    timeout_s?: number;
    portkey_provider?: string;
    portkey_virtual_key_set?: boolean;
    portkey_virtual_key_masked?: string;
    ready?: boolean;
  };
  comfyui?: {
    provider?: 'off' | 'local' | 'proxy' | string;
    enabled?: boolean;
    base_url?: string;
    api_key_set?: boolean;
    api_key_masked?: string;
    timeout_s?: number;
    poll_interval_s?: number;
    workflow_path?: string;
    workflows_dir?: string;
    workflow_text_to_image?: string;
    workflow_text_to_video?: string;
    workflow_image_to_video?: string;
    workflow_upscale_image?: string;
    workflow_upscale_video?: string;
    diffusion_model?: string;
    clip_name?: string;
    vae_name?: string;
    width?: number;
    height?: number;
    frames?: number;
    fps?: number;
    steps?: number;
    cfg?: number;
    negative_prompt?: string;
    gateway_base_url?: string;
    gateway_api_key_set?: boolean;
    gateway_api_key_masked?: string;
    gateway_model?: string;
    gateway_timeout_s?: number;
    portkey_provider?: string;
    portkey_virtual_key_set?: boolean;
    portkey_virtual_key_masked?: string;
    uses_gateway?: boolean;
    ready?: boolean;
    ops?: Record<string, boolean>;
  };
  media_gen?: {
    default_backend?: 'comfyui' | 'gemini' | 'higgsfield' | string;
    text_to_image?: string;
    text_to_video?: string;
    image_to_video?: string;
    upscale_image?: string;
    upscale_video?: string;
    ops?: Record<string, boolean>;
  };
  higgsfield?: {
    api_key_id_set?: boolean;
    api_key_id_masked?: string;
    api_key_secret_set?: boolean;
    api_key_secret_masked?: string;
    base_url?: string;
    endpoint_text_to_image?: string;
    endpoint_text_to_video?: string;
    endpoint_image_to_video?: string;
    endpoint_upscale_image?: string;
    endpoint_upscale_video?: string;
    timeout_s?: number;
    poll_interval_s?: number;
    ready?: boolean;
  };
}

/** Flat PUT body for `/api/llm/settings` — only set fields you want to change. */
export type LlmSettingsUpdate = Record<string, string | number | boolean | null | undefined>;

export interface SettingsTestCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SettingsTestResult {
  ok: boolean;
  provider?: string;
  detail?: string;
  checks?: SettingsTestCheck[];
  base_url?: string;
  workflow?: string;
}

export interface ComfyWorkflowEntry {
  stem: string;
  filename: string;
  source: 'user' | 'package' | string;
}

export interface ComfyWorkflowListResponse {
  workflows_dir: string;
  workflows: ComfyWorkflowEntry[];
}

export interface StockSettings {
  timeout_s?: number;
  daily_download_limit?: number;
  pixabay_configured?: boolean;
  pixabay_api_key_set?: boolean;
  pixabay_api_key_masked?: string;
  downloads_used_today?: number;
  downloads_remaining_today?: number | null;
}

export type ProjectLogoKind = 'dark_short' | 'dark_full' | 'light_short' | 'light_full';

export const PROJECT_LOGO_SLOTS: { kind: ProjectLogoKind; label: string }[] = [
  { kind: 'dark_short', label: 'Dark · short' },
  { kind: 'dark_full', label: 'Dark · full' },
  { kind: 'light_short', label: 'Light · short' },
  { kind: 'light_full', label: 'Light · full' },
];

export interface StockCapabilities {
  openverse?: { enabled?: boolean; media_types?: string[]; note?: string };
  pixabay?: {
    enabled?: boolean;
    media_types?: string[];
    note?: string;
    unsupported_via_api?: string[];
  };
  daily_download_limit?: number;
  downloads_used_today?: number;
  downloads_remaining_today?: number | null;
  [key: string]: unknown;
}

export interface StockSearchItem {
  id: string;
  source?: string;
  type?: string;
  kind?: string;
  title?: string;
  thumb_url?: string;
  preview_url?: string;
  download_url?: string;
  page_url?: string;
  license?: string;
  creator?: string;
  attribution?: string;
  width?: number | null;
  height?: number | null;
  duration_s?: number | null;
}

export interface StockSearchResult {
  query?: string;
  media_type?: string;
  page?: number;
  page_size?: number;
  approximate_total?: number;
  sources_used?: string[];
  results?: StockSearchItem[];
  note?: string;
  capabilities?: StockCapabilities;
}

export const EDITOR_PLATFORMS = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x', label: 'X' },
  { id: 'other', label: 'Other' },
] as const;

export interface ProjectSocialAccount {
  id: string;
  platform: string;
  label?: string;
  handle?: string;
  external_id?: string;
  enabled?: boolean;
  status?: string;
  notes?: string;
  created_at?: string;
  updated_at?: string;
  publish_ready?: boolean;
  has_credentials?: boolean;
  has_app_credentials?: boolean;
  publish_mode?: string;
}

export interface SocialAccountCredentialField {
  key: string;
  set?: boolean;
  secret?: boolean;
  value?: string;
  masked?: string;
}

export interface SocialAccountCredentialsView {
  platform?: string;
  has_credentials?: boolean;
  has_app_credentials?: boolean;
  fields?: SocialAccountCredentialField[];
  help?: string;
  account?: ProjectSocialAccount;
}

export interface PublishAttempt {
  id: string;
  account_id?: string;
  platform?: string;
  account_label?: string;
  status?: string;
  message?: string;
  export_path?: string;
  remote_url?: string;
  caption?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ExportVariant {
  key: string;
  label: string;
  width: number;
  height: number;
  master?: boolean;
}

export interface ExportVariantsResponse {
  variants?: ExportVariant[];
  target_format?: string;
  video_format?: string;
  type?: string;
}

export interface PostExportFile {
  name: string;
  path: string;
  size_bytes?: number;
  modified_at?: string;
  kind?: 'video' | 'image' | 'archive' | string;
}

export interface ExportJobStatus {
  id: string;
  project_id?: string;
  post_id?: string;
  kind?: 'image' | 'video' | string;
  status: 'queued' | 'running' | 'done' | 'error' | string;
  percent?: number;
  message?: string;
  error?: string | null;
  filename?: string | null;
  ready?: boolean;
}

export function platformIcon(id: string): string {
  const icons: Record<string, string> = {
    youtube: 'smart_display',
    facebook: 'groups',
    instagram: 'photo_camera',
    tiktok: 'music_note',
    telegram: 'send',
    linkedin: 'work',
    x: 'chat',
    other: 'more_horiz',
  };
  return icons[id] || 'public';
}

export function platformLabel(id: string): string {
  return EDITOR_PLATFORMS.find((p) => p.id === id)?.label || id;
}

export function isImageAsset(type: string | undefined): boolean {
  return ['image', 'photo', 'illustration', 'vector'].includes(String(type || ''));
}

export function isVideoAsset(type: string | undefined): boolean {
  return String(type || '') === 'video';
}

export function isAudioAsset(type: string | undefined): boolean {
  return ['audio', 'music', 'sound'].includes(String(type || ''));
}

export function assetTypeLabel(type: string | undefined): string {
  const t = String(type || '');
  const map: Record<string, string> = {
    photo: 'Photo',
    illustration: 'Illustration',
    vector: 'Vector',
    image: 'Image',
    video: 'Video',
    music: 'Music',
    sound: 'SFX',
    audio: 'Audio',
    model: '3D',
    icon: 'Icon',
  };
  return map[t] || t || 'Asset';
}

export function assetTypeIcon(type: string | undefined): string {
  const t = String(type || '').toLowerCase();
  if (t === 'video') return 'movie';
  if (t === 'audio' || t === 'music' || t === 'sound') return 'audiotrack';
  if (t === 'model') return 'view_in_ar';
  if (t === 'icon') return 'emoji_symbols';
  if (isImageAsset(t)) return 'image';
  return 'draft';
}

/** Normalize legacy types for library / palette filters. */
export function assetMatchesTypeFilter(
  assetType: string | undefined,
  filter: string,
): boolean {
  if (!filter || filter === 'all') return true;
  const t = String(assetType || '').toLowerCase();
  if (filter === 'photo') return t === 'photo' || t === 'image';
  if (filter === 'music') return t === 'music' || t === 'audio';
  return t === filter;
}

export const ASSET_TYPE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'photo', label: 'Photos' },
  { id: 'illustration', label: 'Illustrations' },
  { id: 'vector', label: 'Vectors' },
  { id: 'video', label: 'Videos' },
  { id: 'music', label: 'Music' },
  { id: 'sound', label: 'SFX' },
  { id: 'model', label: '3D' },
] as const;
