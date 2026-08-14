import { Injectable, computed, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { storageGet, storageSet, SnackbarService } from 'shared/ui';
import type {
  Asset,
  CreatePostPayload,
  GlobalAssetsResponse,
  LlmSettings,
  LlmSettingsUpdate,
  MediaBrowseResult,
  MediaFileInfo,
  PatchAssetPayload,
  Post,
  PostSummary,
  Project,
  ProjectMediaFolder,
  ProjectSummary,
  PublishPackage,
  PublishPackagePlatform,
  PublishPlatform,
  ProjectLogoKind,
  ProjectSocialAccount,
  SocialAccountCredentialsView,
  SettingsTestResult,
  ComfyWorkflowEntry,
  ComfyWorkflowListResponse,
  StockCapabilities,
  StockSearchItem,
  StockSearchResult,
  StockSettings,
  StorageSettings,
  UploadAssetOptions,
  GenerateTtsAssetOptions,
  SynthesizeTtsOptions,
  TtsVoicesResponse,
  ScriptSummary,
  ScriptDocument,
  ScriptListResponse,
  ScriptMutationResponse,
  CreateScriptPayload,
  UpdateScriptPayload,
  AiScriptGeneratePayload,
  AiScriptGenerateResult,
  AiScriptRefinePayload,
  AiScriptRefineResult,
  ExportJobStatus,
  ExportVariantsResponse,
  PostExportFile,
} from '../models/content-sprout.models';
import { isImageAsset, isVideoAsset } from '../models/content-sprout.models';

@Injectable({ providedIn: 'root' })
export class ContentSproutApiService {
  private static readonly PROJECT_KEY = 'content-sprout.active-project-id';
  private readonly base = environment.apiBase.replace(/\/$/, '');
  /** File/stream URLs (video, audio, thumbs). Falls back to the JSON API origin. */
  private readonly mediaBase = (
    (environment as { mediaBase?: string }).mediaBase || environment.apiBase
  ).replace(/\/$/, '');

  private readonly _projects = signal<ProjectSummary[]>([]);
  private readonly _currentProject = signal<Project | null>(null);
  private readonly _config = signal<Record<string, unknown> | null>(null);
  private readonly _globalAssets = signal<Asset[]>([]);
  private readonly _globalGroups = signal<string[]>([]);
  private readonly _busy = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _llmError = signal<string | null>(null);
  private readonly _availableMemoryBytes = signal<number | null>(null);

  readonly projects = this._projects.asReadonly();
  readonly currentProject = this._currentProject.asReadonly();
  readonly config = this._config.asReadonly();
  readonly globalAssets = this._globalAssets.asReadonly();
  readonly globalGroups = this._globalGroups.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly error = this._error.asReadonly();
  readonly llmError = this._llmError.asReadonly();
  readonly availableMemoryBytes = this._availableMemoryBytes.asReadonly();
  readonly projectName = computed(() => this._currentProject()?.name || 'Select project');
  readonly projectSharedAssets = computed(() =>
    (this._currentProject()?.assets || []).filter((a) => !a.post_id),
  );
  readonly projectPosts = computed(() => this._currentProject()?.posts || []);

  constructor(
    private readonly http: HttpClient,
    private readonly snackbar: SnackbarService,
  ) {}

  // ---- Config / projects -------------------------------------------------

  async loadConfig(): Promise<Record<string, unknown> | null> {
    try {
      const data = await firstValueFrom(this.http.get<Record<string, unknown>>(`${this.base}/config`));
      this._config.set(data);
      this._error.set(null);
      return data;
    } catch (err) {
      this._error.set(this.errMessage(err, 'Failed to reach API'));
      return null;
    }
  }

  async refreshSystemMemory(): Promise<boolean> {
    try {
      const data = await firstValueFrom(
        this.http.get<{ available_bytes?: number }>(`${this.base}/system/memory`),
      );
      const value =
        typeof data?.available_bytes === 'number' && Number.isFinite(data.available_bytes)
          ? Math.max(0, Math.floor(data.available_bytes))
          : null;
      this._availableMemoryBytes.set(value);
      return true;
    } catch {
      return false;
    }
  }

  async loadProjects(): Promise<ProjectSummary[]> {
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.get<{ projects?: ProjectSummary[] }>(`${this.base}/projects`),
      );
      const list = data.projects || [];
      this._projects.set(list);
      this._error.set(null);
      const storedId = this.readStoredProjectId();
      if (storedId && list.some((p) => p.id === storedId)) {
        await this.selectProject(storedId);
      } else if (!this._currentProject() && list.length === 1) {
        await this.selectProject(list[0].id);
      }
      return list;
    } catch (err) {
      this._error.set(this.errMessage(err, 'Failed to load projects'));
      return [];
    } finally {
      this._busy.set(false);
    }
  }

  async createProject(name: string): Promise<Project | null> {
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<{ project?: Project }>(`${this.base}/projects`, { name: name.trim() }),
      );
      const project = data.project || null;
      await this.loadProjects();
      if (project?.id) await this.selectProject(project.id);
      this.snackbar.show(`Created project “${project?.name || name}”`, 'success');
      return project;
    } catch (err) {
      const msg = this.errMessage(err, 'Failed to create project');
      this._error.set(msg);
      this.snackbar.show(msg, 'error');
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  async deleteProject(projectId: string): Promise<boolean> {
    this._busy.set(true);
    try {
      await firstValueFrom(
        this.http.delete(`${this.base}/projects/${encodeURIComponent(projectId)}`),
      );
      if (this._currentProject()?.id === projectId) {
        this.clearProject();
      }
      await this.loadProjects();
      this.snackbar.show('Project deleted', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to delete project'), 'error');
      return false;
    } finally {
      this._busy.set(false);
    }
  }

  async selectProject(projectId: string): Promise<Project | null> {
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.get<{ project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}`,
        ),
      );
      const project = data.project || null;
      this._currentProject.set(project ? this.applyLocalAssetEdits(project) : null);
      if (project?.id) {
        try {
          storageSet(ContentSproutApiService.PROJECT_KEY, project.id);
        } catch {
          /* ignore */
        }
      }
      this._error.set(null);
      return project;
    } catch (err) {
      this._error.set(this.errMessage(err, 'Failed to open project'));
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  async refreshCurrentProject(opts?: { quiet?: boolean }): Promise<Project | null> {
    const id = this._currentProject()?.id;
    if (!id) return null;
    if (!opts?.quiet) return this.selectProject(id);
    try {
      const data = await firstValueFrom(
        this.http.get<{ project?: Project }>(`${this.base}/projects/${encodeURIComponent(id)}`),
      );
      const project = data.project || null;
      if (project) this._currentProject.set(this.applyLocalAssetEdits(project));
      return project;
    } catch {
      return this._currentProject();
    }
  }

  clearProject(): void {
    this._currentProject.set(null);
    try {
      storageSet(ContentSproutApiService.PROJECT_KEY, '');
    } catch {
      /* ignore */
    }
  }

  // ---- Posts -------------------------------------------------------------

  async getPost(postId: string, projectId?: string): Promise<Post | null> {
    const id = projectId || this._currentProject()?.id;
    if (!id) return null;
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.get<{ post?: Post }>(
          `${this.base}/projects/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}`,
        ),
      );
      this._error.set(null);
      return data.post || null;
    } catch (err) {
      this._error.set(this.errMessage(err, 'Failed to load post'));
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  async updatePost(
    post: Post,
    projectId?: string,
    opts?: { quiet?: boolean },
  ): Promise<Post | null> {
    const id = projectId || this._currentProject()?.id;
    if (!id || !post?.id) {
      this.snackbar.show('Select a project first', 'error');
      return null;
    }
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.put<{ post?: Post; project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(id)}/posts/${encodeURIComponent(post.id)}`,
          { post },
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      if (!opts?.quiet) this.snackbar.show('Post saved', 'success');
      return data.post || null;
    } catch (err) {
      const msg = this.errMessage(err, 'Failed to save post');
      this.snackbar.show(msg, 'error');
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  async createPost(payload: CreatePostPayload): Promise<PostSummary | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('Select a project first', 'error');
      return null;
    }
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<{ post?: PostSummary; project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/posts`,
          {
            name: payload.name.trim(),
            type: payload.type,
            target_format: payload.target_format || 'portrait',
            is_reusable: !!payload.is_reusable && payload.type === 'video',
          },
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      else await this.refreshCurrentProject();
      this.snackbar.show(`Created post “${data.post?.name || payload.name}”`, 'success');
      return data.post || null;
    } catch (err) {
      const msg = this.errMessage(err, 'Failed to create post');
      this.snackbar.show(msg, 'error');
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  async deletePost(postId: string): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.delete<{ project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/posts/${encodeURIComponent(postId)}`,
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      else await this.refreshCurrentProject();
      this.snackbar.show('Post deleted', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to delete post'), 'error');
      return false;
    } finally {
      this._busy.set(false);
    }
  }

  // ---- Project assets ----------------------------------------------------

  async uploadProjectAsset(file: File, opts: UploadAssetOptions = {}): Promise<Asset | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('Select a project first', 'error');
      return null;
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('apply_logo', opts.apply_logo ? 'true' : 'false');
    if (opts.group) fd.append('group', opts.group);
    if (opts.post_id) fd.append('post_id', opts.post_id);
    if (opts.asset_type && opts.asset_type !== 'auto') fd.append('asset_type', opts.asset_type);

    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<{ asset?: Asset; project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/assets`,
          fd,
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      else await this.refreshCurrentProject();
      return data.asset || null;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, `Upload failed: ${file.name}`), 'error');
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  async uploadProjectAssets(files: FileList | File[], opts: UploadAssetOptions = {}): Promise<number> {
    const list = Array.from(files);
    let ok = 0;
    for (const f of list) {
      const asset = await this.uploadProjectAsset(f, opts);
      if (asset) ok += 1;
    }
    if (ok) this.snackbar.show(`Uploaded ${ok}/${list.length} asset(s)`, 'success');
    return ok;
  }

  // ---- Text to speech ----------------------------------------------------

  async listTtsVoices(): Promise<TtsVoicesResponse | null> {
    try {
      return await firstValueFrom(this.http.get<TtsVoicesResponse>(`${this.base}/tts/voices`));
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not load voices'), 'error');
      return null;
    }
  }

  async generateTtsAsset(
    opts: GenerateTtsAssetOptions,
  ): Promise<{ asset: Asset; duration_s: number | null } | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('Select a project first', 'error');
      return null;
    }
    const text = String(opts.text || '').trim();
    if (!text) {
      this.snackbar.show('Enter text to speak', 'error');
      return null;
    }
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<{
          asset?: Asset;
          project?: Project;
          duration_s?: number | null;
        }>(`${this.base}/projects/${encodeURIComponent(projectId)}/tts/generate`, {
          text,
          voice: opts.voice || null,
          mood: opts.mood || null,
          pacing: opts.pacing || null,
          name: opts.name || null,
          post_id: opts.post_id || null,
        }),
      );
      if (data.project) this._currentProject.set(data.project);
      else await this.refreshCurrentProject();
      if (!data.asset) {
        this.snackbar.show('Speech generated but no asset returned', 'error');
        return null;
      }
      this.snackbar.show('Speech audio created', 'success');
      return { asset: data.asset, duration_s: data.duration_s ?? null };
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Speech generation failed'), 'error');
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  async synthesizePostTts(
    postId: string,
    opts: SynthesizeTtsOptions,
  ): Promise<Post | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('Select a project first', 'error');
      return null;
    }
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<{ post?: Post; project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/posts/${encodeURIComponent(postId)}/tts/synthesize`,
          {
            post_id: postId,
            scene_id: opts.scene_id,
            layer_id: opts.layer_id,
            text: opts.text ?? null,
            voice: opts.voice ?? null,
            mood: opts.mood ?? null,
            pacing: opts.pacing ?? null,
            volume: opts.volume ?? null,
          },
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      if (!data.post) {
        this.snackbar.show('Speech generated but post was not returned', 'error');
        return null;
      }
      this.snackbar.show('Speech attached to voice layer', 'success');
      return data.post;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Speech generation failed'), 'error');
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  async renameProjectAsset(assetId: string, name: string): Promise<boolean> {
    return this.patchProjectAsset(assetId, { name: name.trim() });
  }

  async patchProjectAsset(
    assetId: string,
    patch: PatchAssetPayload,
    opts?: { quiet?: boolean },
  ): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    try {
      const data = await firstValueFrom(
        this.http.patch<{ asset?: Asset }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
          patch,
        ),
      );
      if (data.asset) this.applyProjectAssetUpdate(data.asset);
      else await this.refreshCurrentProject({ quiet: true });
      if (!opts?.quiet) {
        const renamed = typeof patch.name === 'string' ? patch.name.trim() : '';
        this.snackbar.show(renamed ? `Renamed to “${renamed}”` : 'Asset updated', 'success', 4000);
      }
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not rename asset'), 'error');
      return false;
    }
  }

  async deleteProjectAsset(assetId: string): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    try {
      await firstValueFrom(
        this.http.delete(
          `${this.base}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
        ),
      );
      await this.refreshCurrentProject();
      this.snackbar.show('Asset deleted', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Delete failed'), 'error');
      return false;
    }
  }

  async createAssetGroup(name: string): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    try {
      const data = await firstValueFrom(
        this.http.post<{ project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/asset-groups`,
          { name: name.trim() },
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      else await this.refreshCurrentProject();
      this.snackbar.show('Group created', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not create group'), 'error');
      return false;
    }
  }

  async deleteAssetGroup(name: string): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    try {
      const data = await firstValueFrom(
        this.http.delete<{ project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/asset-groups/${encodeURIComponent(name)}`,
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      else await this.refreshCurrentProject();
      this.snackbar.show('Group deleted', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not delete group'), 'error');
      return false;
    }
  }

  assetDownloadUrl(assetId: string): string | null {
    const projectId = this._currentProject()?.id;
    if (!projectId) return null;
    return `${this.base}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/download`;
  }

  assetsZipUrl(): string | null {
    const projectId = this._currentProject()?.id;
    if (!projectId) return null;
    return `${this.base}/projects/${encodeURIComponent(projectId)}/assets/zip`;
  }

  async reprocessAsset(assetId: string): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    try {
      await firstValueFrom(
        this.http.post(
          `${this.base}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/process`,
          {},
        ),
      );
      await this.refreshCurrentProject();
      this.snackbar.show('Processing started', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Reprocess failed'), 'error');
      return false;
    }
  }

  async generateAssetThumb(assetId: string): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    try {
      await firstValueFrom(
        this.http.post(
          `${this.base}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/thumb`,
          {},
        ),
      );
      await this.refreshCurrentProject();
      this.snackbar.show('Thumbnail updated', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Thumbnail failed'), 'error');
      return false;
    }
  }

  async uploadProjectLogo(kind: ProjectLogoKind, file: File): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    const fd = new FormData();
    fd.append('file', file);
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<{ project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/logos/${encodeURIComponent(kind)}`,
          fd,
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      else await this.refreshCurrentProject();
      this.snackbar.show('Logo uploaded', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Logo upload failed'), 'error');
      return false;
    } finally {
      this._busy.set(false);
    }
  }

  async clearProjectLogo(kind: ProjectLogoKind): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    const body: Record<string, boolean> = {
      clear_dark_short: kind === 'dark_short',
      clear_dark_full: kind === 'dark_full',
      clear_light_short: kind === 'light_short',
      clear_light_full: kind === 'light_full',
    };
    try {
      const data = await firstValueFrom(
        this.http.patch<{ project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/logos`,
          body,
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      else await this.refreshCurrentProject();
      this.snackbar.show('Logo cleared', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not clear logo'), 'error');
      return false;
    }
  }

  // ---- Project social accounts -------------------------------------------

  async listSocialAccounts(projectId?: string): Promise<ProjectSocialAccount[]> {
    const id = projectId || this._currentProject()?.id;
    if (!id) return [];
    try {
      const data = await firstValueFrom(
        this.http.get<{ accounts?: ProjectSocialAccount[] }>(
          `${this.base}/projects/${encodeURIComponent(id)}/social-accounts`,
        ),
      );
      return data.accounts || [];
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not load social accounts'), 'error');
      return [];
    }
  }

  async createSocialAccount(payload: {
    platform: string;
    label?: string;
    handle?: string;
    external_id?: string;
    enabled?: boolean;
    status?: string;
    notes?: string;
  }): Promise<ProjectSocialAccount | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('Select a project first', 'error');
      return null;
    }
    try {
      const data = await firstValueFrom(
        this.http.post<{ account?: ProjectSocialAccount; project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/social-accounts`,
          payload,
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      this.snackbar.show('Social account added', 'success');
      return data.account || null;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not add social account'), 'error');
      return null;
    }
  }

  async updateSocialAccount(
    accountId: string,
    patch: Partial<{
      platform: string;
      label: string;
      handle: string;
      external_id: string;
      enabled: boolean;
      status: string;
      notes: string;
    }>,
  ): Promise<ProjectSocialAccount | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return null;
    try {
      const data = await firstValueFrom(
        this.http.patch<{ account?: ProjectSocialAccount; project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/social-accounts/${encodeURIComponent(accountId)}`,
          patch,
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      this.snackbar.show('Social account updated', 'success');
      return data.account || null;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not update social account'), 'error');
      return null;
    }
  }

  async deleteSocialAccount(accountId: string): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    try {
      const data = await firstValueFrom(
        this.http.delete<{ project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/social-accounts/${encodeURIComponent(accountId)}`,
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      this.snackbar.show('Social account removed', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not remove social account'), 'error');
      return false;
    }
  }

  async getSocialAccountCredentials(accountId: string): Promise<SocialAccountCredentialsView | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return null;
    try {
      return await firstValueFrom(
        this.http.get<SocialAccountCredentialsView>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/social-accounts/${encodeURIComponent(accountId)}/credentials`,
        ),
      );
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not load account credentials'), 'error');
      return null;
    }
  }

  async putSocialAccountCredentials(
    accountId: string,
    updates: Partial<{
      client_id: string;
      client_secret: string;
      oauth_redirect_uri: string;
      privacy_status: string;
      bot_token: string;
      chat_id: string;
      refresh_token: string;
      access_token: string;
      access_token_secret: string;
      page_access_token: string;
      page_id: string;
      ig_user_id: string;
      open_id: string;
      author_urn: string;
      channel_id: string;
    }>,
  ): Promise<SocialAccountCredentialsView | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return null;
    try {
      const data = await firstValueFrom(
        this.http.put<SocialAccountCredentialsView & { project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/social-accounts/${encodeURIComponent(accountId)}/credentials`,
          updates,
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not save account credentials'), 'error');
      return null;
    }
  }

  youtubeOAuthUrl(accountId: string): string {
    const projectId = this._currentProject()?.id || '';
    return `${this.base}/social-publish/youtube/auth?project_id=${encodeURIComponent(projectId)}&account_id=${encodeURIComponent(accountId)}`;
  }

  async publishPost(
    postId: string,
    body: { account_ids: string[]; caption?: string; title?: string },
  ): Promise<{ post?: Post; results?: unknown[]; export_path?: string } | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('Select a project first', 'error');
      return null;
    }
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<{
          post?: Post;
          project?: Project;
          results?: unknown[];
          export_path?: string;
          attempts?: unknown[];
        }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/posts/${encodeURIComponent(postId)}/publish`,
          body,
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      this.snackbar.show('Upload started', 'success');
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Upload failed'), 'error');
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  async suggestHashtags(
    postId: string,
    body: {
      description?: string;
      title?: string;
      platforms?: string[];
      count?: number;
    },
  ): Promise<{ hashtags: string[]; groups?: { label: string; tags: string[] }[]; note?: string } | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('Select a project first', 'error');
      return null;
    }
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<{
          hashtags?: string[];
          groups?: { label: string; tags: string[] }[];
          note?: string;
        }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/posts/${encodeURIComponent(postId)}/ai/hashtags`,
          body,
        ),
      );
      const hashtags = data.hashtags || [];
      if (!hashtags.length) {
        this.snackbar.show('No hashtags suggested — try a richer caption', 'error');
        return null;
      }
      this.snackbar.show(`Suggested ${hashtags.length} hashtags`, 'success');
      return {
        hashtags,
        groups: data.groups || [],
        note: data.note || '',
      };
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Hashtag suggestions failed'), 'error');
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  logoPath(kind: ProjectLogoKind): string | null {
    const p = this._currentProject();
    if (!p) return null;
    const map: Record<ProjectLogoKind, string | null | undefined> = {
      dark_short: p.logo_dark_short_path,
      dark_full: p.logo_dark_full_path,
      light_short: p.logo_light_short_path,
      light_full: p.logo_light_full_path,
    };
    return map[kind] || null;
  }

  async getStockCapabilities(): Promise<StockCapabilities | null> {
    try {
      return await firstValueFrom(
        this.http.get<StockCapabilities>(`${this.base}/stock/capabilities`),
      );
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to load stock capabilities'), 'error');
      return null;
    }
  }

  async searchStock(opts: {
    q: string;
    media_type?: string;
    page?: number;
    page_size?: number;
  }): Promise<StockSearchResult | null> {
    try {
      let params = new HttpParams().set('q', opts.q.trim());
      params = params.set('media_type', opts.media_type || 'all');
      params = params.set('page', String(opts.page || 1));
      params = params.set('page_size', String(opts.page_size || 24));
      return await firstValueFrom(
        this.http.get<StockSearchResult>(`${this.base}/stock/search`, { params }),
      );
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Stock search failed'), 'error');
      return null;
    }
  }

  async importStockAsset(item: StockSearchItem): Promise<Asset | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('Select a project first', 'error');
      return null;
    }
    if (!item.download_url) {
      this.snackbar.show('This item has no download URL', 'error');
      return null;
    }
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<{ asset?: Asset; project?: Project }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/assets/from-stock`,
          {
            download_url: item.download_url,
            title: item.title || 'Stock media',
            type: item.type || 'image',
            kind: item.kind,
            source: item.source || 'stock',
            license: item.license || '',
            creator: item.creator || '',
            attribution: item.attribution || '',
            page_url: item.page_url || '',
          },
        ),
      );
      if (data.project) this._currentProject.set(data.project);
      else await this.refreshCurrentProject();
      this.snackbar.show('Added to project (locked)', 'success');
      return data.asset || null;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Stock import failed'), 'error');
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  /** Query string matching legacy `encodeURIComponent` (HttpParams leaves slashes decoded). */
  private mediaQuery(params: Record<string, string | null | undefined>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
    return parts.length ? `?${parts.join('&')}` : '';
  }

  private mediaCacheToken(asset?: Asset | null): string | null {
    const parsed = Date.parse(String(asset?.updated_at || ''));
    return Number.isFinite(parsed) ? String(parsed) : null;
  }

  projectFileUrl(relPath: string | undefined | null, cacheKey?: string | null): string | null {
    const projectId = this._currentProject()?.id;
    if (!projectId || !relPath) return null;
    const path = String(relPath).replace(/\\/g, '/');
    return `${this.mediaBase}/projects/${encodeURIComponent(projectId)}/file${this.mediaQuery({
      path,
      t: cacheKey || undefined,
    })}`;
  }

  globalFileUrl(asset: Asset, relPath?: string | null): string | null {
    const rel = (relPath || asset?.original_path || '').replace(/\\/g, '/');
    if (!asset?.id || !rel) return null;
    return `${this.mediaBase}/global-assets/${encodeURIComponent(asset.id)}/file${this.mediaQuery({
      path: rel,
      t: this.mediaCacheToken(asset),
    })}`;
  }

  /** Still image for cards — video thumbs are generated JPEGs, not the video file. */
  assetThumbUrl(asset: Asset, isGlobal = false): string | null {
    if (!asset) return null;
    const bust = this.mediaCacheToken(asset);
    if (isImageAsset(asset.type)) {
      const rel =
        asset.status === 'ready'
          ? asset.processed_formats?.['thumb'] ||
            asset.processed_formats?.['portrait'] ||
            asset.original_path
          : asset.original_path || asset.processed_formats?.['thumb'];
      return isGlobal ? this.globalFileUrl(asset, rel) : this.projectFileUrl(rel, bust);
    }
    if (isVideoAsset(asset.type)) {
      const rel = asset.processed_formats?.['thumb'];
      if (!rel) return null;
      return isGlobal ? this.globalFileUrl(asset, rel) : this.projectFileUrl(rel, bust);
    }
    return null;
  }

  /** Original file (full image, video, audio, PDF, SVG). */
  assetOriginalUrl(asset: Asset, isGlobal = false): string | null {
    if (!asset) return null;
    const rel = asset.original_path;
    if (!rel) return this.assetThumbUrl(asset, isGlobal);
    return isGlobal
      ? this.globalFileUrl(asset, rel)
      : this.projectFileUrl(rel, this.mediaCacheToken(asset));
  }

  /** In-app playback URL. Videos prefer a local 720p H.264 proxy when ready. */
  assetPlaybackUrl(asset: Asset, isGlobal = false): string | null {
    if (!asset) return null;
    if (isImageAsset(asset.type)) return this.assetThumbUrl(asset, isGlobal);
    if (isVideoAsset(asset.type)) {
      const rel = asset.processed_formats?.['preview'] || asset.original_path;
      if (!rel) return this.assetOriginalUrl(asset, isGlobal);
      return isGlobal
        ? this.globalFileUrl(asset, rel)
        : this.projectFileUrl(rel, this.mediaCacheToken(asset));
    }
    return this.assetOriginalUrl(asset, isGlobal);
  }

  async ensureVideoPreview(
    asset: Asset,
    opts?: { global?: boolean },
  ): Promise<{ status: string; asset?: Asset } | null> {
    if (!asset?.id || !isVideoAsset(asset.type)) return null;
    const isGlobal = !!opts?.global || !!(asset as Asset & { is_global?: boolean }).is_global;
    const projectId = this._currentProject()?.id;
    try {
      const url = isGlobal
        ? `${this.base}/global-assets/${encodeURIComponent(asset.id)}/preview`
        : projectId
          ? `${this.base}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(asset.id)}/preview`
          : null;
      if (!url) return null;
      const data = await firstValueFrom(
        this.http.post<{ status?: string; asset?: Asset }>(url, {}),
      );
      if (data.asset) {
        if (isGlobal) this.applyGlobalAssetUpdate(data.asset);
        else this.applyProjectAssetUpdate(data.asset);
      }
      return { status: data.status || 'ready', asset: data.asset };
    } catch {
      return null;
    }
  }

  assetPreviewUrl(asset: Asset): string | null {
    if (isVideoAsset(asset.type) || ['audio', 'music', 'sound'].includes(String(asset.type || ''))) {
      return this.assetPlaybackUrl(asset);
    }
    return this.assetThumbUrl(asset) || this.assetPlaybackUrl(asset);
  }

  postAssets(postId: string): Asset[] {
    return (this._currentProject()?.assets || []).filter((a) => a.post_id === postId);
  }

  async renderPostPreview(
    postId: string,
    opts: { scene_id?: string; time_s?: number; abs_time_s?: number } = {},
  ): Promise<string | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return null;
    try {
      const blob = await firstValueFrom(
        this.http.post(
          `${this.base}/projects/${encodeURIComponent(projectId)}/posts/${encodeURIComponent(postId)}/render`,
          {
            post_id: postId,
            scene_id: opts.scene_id ?? null,
            time_s: opts.time_s ?? null,
            abs_time_s: opts.abs_time_s ?? null,
          },
          { responseType: 'blob' },
        ),
      );
      return URL.createObjectURL(blob);
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Preview render failed'), 'error');
      return null;
    }
  }

  async startExportJob(
    postId: string,
    kind: 'image' | 'video',
    formats: string[] = [],
  ): Promise<ExportJobStatus | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return null;
    const path =
      kind === 'video'
        ? `${this.base}/projects/${encodeURIComponent(projectId)}/posts/${encodeURIComponent(postId)}/export/video/jobs`
        : `${this.base}/projects/${encodeURIComponent(projectId)}/posts/${encodeURIComponent(postId)}/export/image/jobs`;
    try {
      return await firstValueFrom(
        this.http.post<ExportJobStatus>(path, kind === 'video' ? { formats } : {}),
      );
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not start export'), 'error');
      return null;
    }
  }

  async getExportJob(jobId: string): Promise<ExportJobStatus | null> {
    try {
      return await firstValueFrom(
        this.http.get<ExportJobStatus>(`${this.base}/export/jobs/${encodeURIComponent(jobId)}`),
      );
    } catch {
      return null;
    }
  }

  async downloadExportJob(jobId: string, fallbackName: string): Promise<boolean> {
    try {
      const resp = await firstValueFrom(
        this.http.get(`${this.base}/export/jobs/${encodeURIComponent(jobId)}/file`, {
          responseType: 'blob',
          observe: 'response',
        }),
      );
      if (!resp.body) throw new Error('Empty export');
      this.downloadBlob(
        resp.body,
        this.filenameFromDisposition(resp.headers.get('Content-Disposition'), fallbackName),
      );
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not download export'), 'error');
      return false;
    }
  }

  async exportPostImage(postId: string, filename = 'post.jpg'): Promise<boolean> {
    return this.runExportJob(postId, 'image', [], filename);
  }

  async exportPostVideo(postId: string, formats: string[] = []): Promise<boolean> {
    const fallback = formats.length > 1 ? 'post_exports.zip' : 'post.mp4';
    return this.runExportJob(postId, 'video', formats, fallback);
  }

  async runExportJob(
    postId: string,
    kind: 'image' | 'video',
    formats: string[],
    fallbackName: string,
    onProgress?: (job: ExportJobStatus) => void,
  ): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    this._busy.set(true);
    try {
      const started = await this.startExportJob(postId, kind, formats);
      if (!started?.id) return false;
      onProgress?.(started);
      let job = started;
      while (job.status === 'queued' || job.status === 'running') {
        await new Promise((r) => setTimeout(r, 400));
        const next = await this.getExportJob(job.id);
        if (!next) break;
        job = next;
        onProgress?.(job);
      }
      if (job.status !== 'done' || !job.ready) {
        this.snackbar.show(job.error || 'Export failed', 'error');
        return false;
      }
      const ok = await this.downloadExportJob(job.id, job.filename || fallbackName);
      if (ok) {
        this.snackbar.show(
          kind === 'video' && formats.length > 1 ? `Exported ${formats.length} sizes` : kind === 'video' ? 'Video exported' : 'Image exported',
          'success',
        );
      }
      return ok;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, kind === 'video' ? 'Video export failed' : 'Image export failed'), 'error');
      return false;
    } finally {
      this._busy.set(false);
    }
  }

  async getExportSize(postId: string): Promise<{ width: number; height: number } | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return null;
    try {
      return await firstValueFrom(
        this.http.get<{ width: number; height: number }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/posts/${encodeURIComponent(postId)}/export-size`,
        ),
      );
    } catch {
      return null;
    }
  }

  async getExportVariants(postId: string): Promise<ExportVariantsResponse | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return null;
    try {
      return await firstValueFrom(
        this.http.get<ExportVariantsResponse>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/posts/${encodeURIComponent(postId)}/export-variants`,
        ),
      );
    } catch {
      return null;
    }
  }

  async listPostExports(postId: string): Promise<PostExportFile[]> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return [];
    try {
      const data = await firstValueFrom(
        this.http.get<{ exports?: PostExportFile[] }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/posts/${encodeURIComponent(postId)}/exports`,
        ),
      );
      return Array.isArray(data?.exports) ? data.exports : [];
    } catch {
      return [];
    }
  }

  exportFileUrl(relPath: string | undefined | null, opts?: { download?: boolean; cacheKey?: string | null }): string | null {
    const projectId = this._currentProject()?.id;
    if (!projectId || !relPath) return null;
    const path = String(relPath).replace(/\\/g, '/');
    return `${this.mediaBase}/projects/${encodeURIComponent(projectId)}/file${this.mediaQuery({
      path,
      download: opts?.download ? 'true' : undefined,
      t: opts?.cacheKey || undefined,
    })}`;
  }

  private filenameFromDisposition(header: string | null, fallback: string): string {
    if (!header) return fallback;
    const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (star?.[1]) {
      try {
        return decodeURIComponent(star[1].trim());
      } catch {
        /* ignore */
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    return plain?.[1]?.trim() || fallback;
  }

  private downloadBlob(blob: Blob, fallbackName: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fallbackName;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Personal media ----------------------------------------------------

  async listMediaFolders(projectId?: string): Promise<ProjectMediaFolder[]> {
    const id = projectId || this._currentProject()?.id;
    if (!id) return [];
    const data = await firstValueFrom(
      this.http.get<{ folders?: ProjectMediaFolder[] }>(
        `${this.base}/projects/${encodeURIComponent(id)}/media/folders`,
      ),
    );
    return data.folders || [];
  }

  async addMediaFolder(label: string, path: string): Promise<ProjectMediaFolder | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('Select a project first', 'error');
      return null;
    }
    try {
      const data = await firstValueFrom(
        this.http.post<{ folder?: ProjectMediaFolder }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/media/folders`,
          { label: label.trim() || 'Folder', path: path.trim(), enabled: true },
        ),
      );
      this.snackbar.show('Folder added', 'success');
      return data.folder || null;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to add folder'), 'error');
      return null;
    }
  }

  async deleteMediaFolder(folderId: string): Promise<boolean> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return false;
    try {
      await firstValueFrom(
        this.http.delete(
          `${this.base}/projects/${encodeURIComponent(projectId)}/media/folders/${encodeURIComponent(folderId)}`,
        ),
      );
      this.snackbar.show('Folder removed', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to remove folder'), 'error');
      return false;
    }
  }

  async listMediaFiles(
    folderId: string,
    opts: { q?: string; media_type?: string } = {},
  ): Promise<MediaFileInfo[]> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return [];
    let params = new HttpParams();
    if (opts.q) params = params.set('q', opts.q);
    params = params.set('media_type', opts.media_type || 'all');
    const data = await firstValueFrom(
      this.http.get<{ files?: MediaFileInfo[] }>(
        `${this.base}/projects/${encodeURIComponent(projectId)}/media/folders/${encodeURIComponent(folderId)}/files`,
        { params },
      ),
    );
    return data.files || [];
  }

  async renameMediaFile(
    folderId: string,
    path: string,
    name: string,
  ): Promise<{ path: string; name: string } | null> {
    const projectId = this._currentProject()?.id;
    if (!projectId) return null;
    try {
      const data = await firstValueFrom(
        this.http.post<{ path?: string; name?: string }>(`${this.base}/media/rename`, {
          project_id: projectId,
          folder_id: folderId,
          path,
          name,
        }),
      );
      this.snackbar.show('File renamed', 'success');
      return { path: data.path || path, name: data.name || name };
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Rename failed'), 'error');
      return null;
    }
  }

  async browseMedia(path = ''): Promise<MediaBrowseResult | null> {
    try {
      const params = path ? new HttpParams().set('path', path) : undefined;
      return await firstValueFrom(
        this.http.get<MediaBrowseResult>(`${this.base}/media/browse`, { params }),
      );
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Browse failed'), 'error');
      return null;
    }
  }

  /** Opens a native OS folder dialog via the local API server. */
  async pickFolderNative(title = 'Select a folder'): Promise<string | null> {
    try {
      const params = new HttpParams().set('title', title);
      const data = await firstValueFrom(
        this.http.post<{ path?: string | null; cancelled?: boolean; name?: string }>(
          `${this.base}/media/pick-folder`,
          {},
          { params },
        ),
      );
      if (data.cancelled || !data.path) return null;
      return data.path;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Folder picker failed'), 'error');
      return null;
    }
  }

  mediaFileUrl(folderId: string, relPath: string): string {
    const projectId = this._currentProject()?.id || '';
    return `${this.mediaBase}/media/file${this.mediaQuery({
      folder_id: folderId,
      path: String(relPath).replace(/\\/g, '/'),
      project_id: projectId || undefined,
    })}`;
  }

  async importMedia(
    folderId: string,
    paths: string[],
    opts: { group?: string; post_id?: string | null } = {},
  ): Promise<number> {
    const projectId = this._currentProject()?.id;
    if (!projectId) {
      this.snackbar.show('Select a project first', 'error');
      return 0;
    }
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<{
          imported_count?: number;
          project?: Project;
          errors?: { path: string; error: string }[];
        }>(`${this.base}/media/import`, {
          project_id: projectId,
          folder_id: folderId,
          paths,
          group: (opts.group || '').trim(),
          post_id: opts.post_id || null,
        }),
      );
      if (data.project) this._currentProject.set(data.project);
      const count = data.imported_count || 0;
      const errCount = data.errors?.length || 0;
      this.snackbar.show(
        errCount > 0 ? `Imported ${count}; ${errCount} failed` : `Imported ${count} file(s)`,
        errCount && !count ? 'error' : 'success',
      );
      return count;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Import failed'), 'error');
      return 0;
    } finally {
      this._busy.set(false);
    }
  }

  async getPublishPlatforms(): Promise<PublishPlatform[]> {
    try {
      const data = await firstValueFrom(
        this.http.get<{ platforms?: PublishPlatform[] }>(`${this.base}/media/publish/platforms`),
      );
      return data.platforms || [];
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to load platforms'), 'error');
      return [];
    }
  }

  async savePublishPlatforms(platforms: PublishPlatform[]): Promise<PublishPlatform[] | null> {
    try {
      const data = await firstValueFrom(
        this.http.put<{ platforms?: PublishPlatform[] }>(`${this.base}/media/publish/platforms`, {
          platforms,
        }),
      );
      this.snackbar.show('Platforms saved', 'success');
      return data.platforms || platforms;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to save platforms'), 'error');
      return null;
    }
  }

  async listPublishPackages(): Promise<PublishPackage[]> {
    try {
      const data = await firstValueFrom(
        this.http.get<{ packages?: PublishPackage[] }>(`${this.base}/media/publish/packages`),
      );
      return data.packages || [];
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to load packages'), 'error');
      return [];
    }
  }

  async createPublishPackage(body: {
    folder_id: string;
    paths: string[];
    platform_ids: string[];
    title?: string;
    description?: string;
    tags?: string[];
  }): Promise<PublishPackage | null> {
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<{ package?: PublishPackage }>(`${this.base}/media/publish/packages`, body),
      );
      this.snackbar.show('Package created', 'success');
      return data.package || null;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not create package'), 'error');
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  async openPublishPackage(
    packageId: string,
  ): Promise<{ package: PublishPackage; contributor_urls: PublishPackagePlatform[] } | null> {
    try {
      return await firstValueFrom(
        this.http.post<{ package: PublishPackage; contributor_urls: PublishPackagePlatform[] }>(
          `${this.base}/media/publish/packages/${encodeURIComponent(packageId)}/open`,
          {},
        ),
      );
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not open package'), 'error');
      return null;
    }
  }

  async markPublishPackageSubmitted(packageId: string): Promise<PublishPackage | null> {
    try {
      const data = await firstValueFrom(
        this.http.post<{ package?: PublishPackage }>(
          `${this.base}/media/publish/packages/${encodeURIComponent(packageId)}/mark-submitted`,
          {},
        ),
      );
      this.snackbar.show('Marked as submitted', 'success');
      return data.package || null;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not update package'), 'error');
      return null;
    }
  }

  // ---- Global resources --------------------------------------------------

  async loadGlobalAssets(): Promise<Asset[]> {
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.get<GlobalAssetsResponse>(`${this.base}/global-assets`),
      );
      this._globalAssets.set(data.assets || []);
      this._globalGroups.set(data.groups || []);
      this._error.set(null);
      return data.assets || [];
    } catch (err) {
      this._error.set(this.errMessage(err, 'Failed to load global assets'));
      return [];
    } finally {
      this._busy.set(false);
    }
  }

  async uploadGlobalAsset(
    file: File,
    opts: { group?: string; name?: string; asset_type?: string } = {},
  ): Promise<Asset | null> {
    const fd = new FormData();
    fd.append('file', file);
    if (opts.group) fd.append('group', opts.group);
    if (opts.name) fd.append('name', opts.name);
    if (opts.asset_type && opts.asset_type !== 'auto') fd.append('asset_type', opts.asset_type);
    this._busy.set(true);
    try {
      const data = await firstValueFrom(
        this.http.post<GlobalAssetsResponse & { asset?: Asset }>(`${this.base}/global-assets`, fd),
      );
      this._globalAssets.set(data.assets || []);
      this._globalGroups.set(data.groups || []);
      return data.asset || null;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, `Upload failed: ${file.name}`), 'error');
      return null;
    } finally {
      this._busy.set(false);
    }
  }

  async uploadGlobalAssets(
    files: FileList | File[],
    opts: { group?: string; asset_type?: string } = {},
  ): Promise<number> {
    const list = Array.from(files);
    let ok = 0;
    for (const f of list) {
      const asset = await this.uploadGlobalAsset(f, opts);
      if (asset) ok += 1;
    }
    if (ok) this.snackbar.show(`Uploaded ${ok}/${list.length} global asset(s)`, 'success');
    return ok;
  }

  async renameGlobalAsset(assetId: string, name: string): Promise<boolean> {
    return this.patchGlobalAsset(assetId, { name: name.trim() });
  }

  async patchGlobalAsset(
    assetId: string,
    patch: { name?: string; group?: string; description?: string; tags?: string[] },
    opts?: { quiet?: boolean },
  ): Promise<boolean> {
    try {
      const data = await firstValueFrom(
        this.http.patch<{ asset?: Asset }>(
          `${this.base}/global-assets/${encodeURIComponent(assetId)}`,
          patch,
        ),
      );
      if (data.asset) this.applyGlobalAssetUpdate(data.asset);
      else await this.loadGlobalAssets();
      if (!opts?.quiet) {
        const renamed = typeof patch.name === 'string' ? patch.name.trim() : '';
        this.snackbar.show(renamed ? `Renamed to “${renamed}”` : 'Asset updated', 'success', 4000);
      }
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Could not rename asset'), 'error');
      return false;
    }
  }

  async deleteGlobalAsset(assetId: string): Promise<boolean> {
    try {
      const data = await firstValueFrom(
        this.http.delete<GlobalAssetsResponse>(
          `${this.base}/global-assets/${encodeURIComponent(assetId)}`,
        ),
      );
      this._globalAssets.set(data.assets || []);
      this._globalGroups.set(data.groups || []);
      this.snackbar.show('Asset deleted', 'success');
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Delete failed'), 'error');
      return false;
    }
  }

  globalPreviewUrl(asset: Asset): string | null {
    if (isVideoAsset(asset.type) || ['audio', 'music', 'sound'].includes(String(asset.type || ''))) {
      return this.assetPlaybackUrl(asset, true);
    }
    return this.assetThumbUrl(asset, true) || this.assetPlaybackUrl(asset, true);
  }

  globalDownloadUrl(assetId: string): string {
    return `${this.base}/global-assets/${encodeURIComponent(assetId)}/download`;
  }

  // ---- Settings ----------------------------------------------------------

  async getStorageSettings(): Promise<StorageSettings | null> {
    try {
      return await firstValueFrom(this.http.get<StorageSettings>(`${this.base}/settings/storage`));
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to load storage settings'), 'error');
      return null;
    }
  }

  async saveStorageSettings(payload: Partial<StorageSettings>): Promise<StorageSettings | null> {
    try {
      return await firstValueFrom(
        this.http.put<StorageSettings>(`${this.base}/settings/storage`, payload),
      );
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to save storage settings'), 'error');
      return null;
    }
  }

  async getLlmSettings(): Promise<LlmSettings | null> {
    try {
      return await firstValueFrom(this.http.get<LlmSettings>(`${this.base}/llm/settings`));
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to load AI settings'), 'error');
      return null;
    }
  }

  async saveLlmSettings(payload: LlmSettingsUpdate): Promise<boolean> {
    try {
      await firstValueFrom(this.http.put(`${this.base}/llm/settings`, payload));
      return true;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to save AI settings'), 'error');
      return false;
    }
  }

  async testLlmSettings(): Promise<SettingsTestResult | null> {
    try {
      const result = await firstValueFrom(
        this.http.post<SettingsTestResult>(`${this.base}/llm/settings/test`, {}),
      );
      if (result?.ok) this.clearLlmError();
      else if (result) {
        const detail =
          result.checks?.find((c) => !c.ok)?.detail || result.detail || 'LLM connection test failed';
        this.reportLlmError(detail);
      }
      return result;
    } catch (err) {
      this.reportLlmError(err, 'Could not test the LLM connection');
      return null;
    }
  }

  async testComfyuiSettings(): Promise<SettingsTestResult | null> {
    try {
      return await firstValueFrom(
        this.http.post<SettingsTestResult>(`${this.base}/comfyui/settings/test`, {}),
      );
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'ComfyUI test failed'), 'error');
      return null;
    }
  }

  async listComfyuiWorkflows(): Promise<ComfyWorkflowListResponse | null> {
    try {
      return await firstValueFrom(
        this.http.get<ComfyWorkflowListResponse>(`${this.base}/comfyui/workflows`),
      );
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to load ComfyUI workflows'), 'error');
      return null;
    }
  }

  async uploadComfyuiWorkflow(
    file: File,
    assignOp = '',
  ): Promise<ComfyWorkflowListResponse | null> {
    try {
      const form = new FormData();
      form.append('file', file);
      if (assignOp.trim()) form.append('assign_op', assignOp.trim());
      const result = await firstValueFrom(
        this.http.post<{
          workflow: ComfyWorkflowEntry;
          workflows_dir?: string;
          workflows: ComfyWorkflowEntry[];
        }>(`${this.base}/comfyui/workflows`, form),
      );
      if (!result?.workflows) return null;
      return {
        workflows_dir: result.workflows_dir || '',
        workflows: result.workflows,
      };
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Workflow upload failed'), 'error');
      return null;
    }
  }

  async deleteComfyuiWorkflow(filename: string): Promise<ComfyWorkflowEntry[] | null> {
    try {
      const result = await firstValueFrom(
        this.http.delete<{
          deleted: string;
          workflows: ComfyWorkflowEntry[];
        }>(`${this.base}/comfyui/workflows/${encodeURIComponent(filename)}`),
      );
      return result?.workflows ?? null;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to delete workflow'), 'error');
      return null;
    }
  }

  async getStockSettings(): Promise<StockSettings | null> {
    try {
      return await firstValueFrom(this.http.get<StockSettings>(`${this.base}/stock/settings`));
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to load stock settings'), 'error');
      return null;
    }
  }

  async saveStockSettings(payload: Record<string, unknown>): Promise<StockSettings | null> {
    try {
      return await firstValueFrom(
        this.http.put<StockSettings>(`${this.base}/stock/settings`, payload),
      );
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to save stock settings'), 'error');
      return null;
    }
  }

  // ---- Scripts -----------------------------------------------------------

  private scriptsBase(postId: string, projectId?: string): string | null {
    const id = projectId || this._currentProject()?.id;
    if (!id || !postId) return null;
    return `${this.base}/projects/${encodeURIComponent(id)}/posts/${encodeURIComponent(postId)}/scripts`;
  }

  async listScripts(postId: string, projectId?: string): Promise<ScriptListResponse | null> {
    const url = this.scriptsBase(postId, projectId);
    if (!url) return null;
    try {
      const data = await firstValueFrom(this.http.get<ScriptListResponse>(url));
      if (data.post) this.mergePostIntoProject(data.post);
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to load scripts'), 'error');
      return null;
    }
  }

  async getScript(
    postId: string,
    scriptId: string,
    projectId?: string,
  ): Promise<{ script: ScriptDocument; active_script_id?: string | null } | null> {
    const url = this.scriptsBase(postId, projectId);
    if (!url) return null;
    try {
      return await firstValueFrom(
        this.http.get<{ script: ScriptDocument; active_script_id?: string | null }>(
          `${url}/${encodeURIComponent(scriptId)}`,
        ),
      );
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to load script'), 'error');
      return null;
    }
  }

  async createScript(
    postId: string,
    payload: CreateScriptPayload,
    projectId?: string,
  ): Promise<ScriptMutationResponse | null> {
    const url = this.scriptsBase(postId, projectId);
    if (!url) return null;
    try {
      const data = await firstValueFrom(
        this.http.post<ScriptMutationResponse>(url, payload),
      );
      if (data.post) this.mergePostIntoProject(data.post);
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to create script'), 'error');
      return null;
    }
  }

  async updateScript(
    postId: string,
    scriptId: string,
    payload: UpdateScriptPayload,
    projectId?: string,
    opts?: { quiet?: boolean },
  ): Promise<ScriptMutationResponse | null> {
    const url = this.scriptsBase(postId, projectId);
    if (!url) return null;
    try {
      const data = await firstValueFrom(
        this.http.put<ScriptMutationResponse>(
          `${url}/${encodeURIComponent(scriptId)}`,
          payload,
        ),
      );
      if (data.post) this.mergePostIntoProject(data.post);
      if (!opts?.quiet) this.snackbar.show('Script saved', 'success');
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to save script'), 'error');
      return null;
    }
  }

  async activateScript(
    postId: string,
    scriptId: string,
    active = true,
    projectId?: string,
  ): Promise<ScriptMutationResponse | null> {
    const url = this.scriptsBase(postId, projectId);
    if (!url) return null;
    try {
      const data = await firstValueFrom(
        this.http.post<ScriptMutationResponse>(
          `${url}/${encodeURIComponent(scriptId)}/activate`,
          { active },
        ),
      );
      if (data.post) this.mergePostIntoProject(data.post);
      this.snackbar.show(active ? 'Script set active' : 'Script deactivated', 'success');
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to activate script'), 'error');
      return null;
    }
  }

  async deleteScript(
    postId: string,
    scriptId: string,
    projectId?: string,
  ): Promise<{ deleted: boolean; active_script_id?: string | null; post?: Post } | null> {
    const url = this.scriptsBase(postId, projectId);
    if (!url) return null;
    try {
      const data = await firstValueFrom(
        this.http.delete<{ deleted: boolean; active_script_id?: string | null; post?: Post }>(
          `${url}/${encodeURIComponent(scriptId)}`,
        ),
      );
      if (data.post) this.mergePostIntoProject(data.post);
      this.snackbar.show('Draft deleted', 'success');
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to delete script'), 'error');
      return null;
    }
  }

  async clearScripts(
    postId: string,
    projectId?: string,
  ): Promise<{ deleted: number; active_script_id?: null; post?: Post } | null> {
    const url = this.scriptsBase(postId, projectId);
    if (!url) return null;
    try {
      const data = await firstValueFrom(
        this.http.delete<{ deleted: number; active_script_id?: null; post?: Post }>(url),
      );
      if (data.post) this.mergePostIntoProject(data.post);
      this.snackbar.show('All drafts cleared', 'success');
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Failed to clear scripts'), 'error');
      return null;
    }
  }

  async getAiCapabilities(): Promise<{
    vision_llm?: boolean;
    script_generate?: boolean;
    model?: string;
    video_gen?: boolean;
    text_to_image?: boolean;
    text_to_video?: boolean;
    image_to_video?: boolean;
    upscale_image?: boolean;
    upscale_video?: boolean;
    comfyui_ops?: Record<string, boolean>;
  } | null> {
    try {
      return await firstValueFrom(
        this.http.get<{
          vision_llm?: boolean;
          script_generate?: boolean;
          model?: string;
          video_gen?: boolean;
          text_to_image?: boolean;
          text_to_video?: boolean;
          image_to_video?: boolean;
          upscale_image?: boolean;
          upscale_video?: boolean;
          comfyui_ops?: Record<string, boolean>;
        }>(`${this.base}/ai/capabilities`),
      );
    } catch {
      return null;
    }
  }

  async generateProjectImage(
    projectId: string,
    body: {
      prompt: string;
      width?: number;
      height?: number;
      name?: string;
      post_id?: string;
      negative_prompt?: string;
    },
  ): Promise<{ asset?: Asset; queued?: boolean } | null> {
    try {
      const data = await firstValueFrom(
        this.http.post<{ project?: unknown; asset?: Asset; queued?: boolean }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/image/generate`,
          body,
        ),
      );
      await this.refreshCurrentProject();
      this.snackbar.show('Image generation queued', 'success');
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Image generation failed'), 'error');
      return null;
    }
  }

  async generateProjectVideo(
    projectId: string,
    body: {
      prompt: string;
      width?: number;
      height?: number;
      name?: string;
      post_id?: string;
      negative_prompt?: string;
      frames?: number;
      fps?: number;
    },
  ): Promise<{ asset?: Asset; queued?: boolean } | null> {
    try {
      const data = await firstValueFrom(
        this.http.post<{ project?: unknown; asset?: Asset; queued?: boolean }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/video/generate`,
          body,
        ),
      );
      await this.refreshCurrentProject();
      this.snackbar.show('Video generation queued', 'success');
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Video generation failed'), 'error');
      return null;
    }
  }

  async generateProjectVideoFromImage(
    projectId: string,
    body: {
      prompt: string;
      image_asset_id: string;
      width?: number;
      height?: number;
      name?: string;
      post_id?: string;
      negative_prompt?: string;
    },
  ): Promise<{ asset?: Asset; queued?: boolean } | null> {
    try {
      const data = await firstValueFrom(
        this.http.post<{ project?: unknown; asset?: Asset; queued?: boolean }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/video/generate-from-image`,
          body,
        ),
      );
      await this.refreshCurrentProject();
      this.snackbar.show('Video generation queued', 'success');
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Video generation failed'), 'error');
      return null;
    }
  }

  async upscaleProjectAsset(
    projectId: string,
    assetId: string,
    body: { scale: number; name?: string; post_id?: string },
  ): Promise<{ asset?: Asset; queued?: boolean } | null> {
    try {
      const data = await firstValueFrom(
        this.http.post<{ project?: unknown; asset?: Asset; queued?: boolean }>(
          `${this.base}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/upscale`,
          body,
        ),
      );
      await this.refreshCurrentProject();
      this.snackbar.show('Upscale queued', 'success');
      return data;
    } catch (err) {
      this.snackbar.show(this.errMessage(err, 'Upscale failed'), 'error');
      return null;
    }
  }

  async generateScript(payload: AiScriptGeneratePayload): Promise<AiScriptGenerateResult | null> {
    try {
      const data = await firstValueFrom(
        this.http.post<AiScriptGenerateResult>(`${this.base}/ai/script/generate`, payload),
      );
      this.clearLlmError();
      return data;
    } catch (err) {
      this.reportLlmError(err, 'Script generation failed');
      return null;
    }
  }

  async refineScript(payload: AiScriptRefinePayload): Promise<AiScriptRefineResult | null> {
    try {
      const data = await firstValueFrom(
        this.http.post<AiScriptRefineResult>(`${this.base}/ai/script/refine`, payload),
      );
      this.clearLlmError();
      return data;
    } catch (err) {
      this.reportLlmError(err, 'Script refine failed');
      return null;
    }
  }

  private mergePostIntoProject(post: Post): void {
    const project = this._currentProject();
    if (!project?.posts || !post?.id) return;
    const posts = project.posts.map((p) => (p.id === post.id ? { ...p, ...post } : p));
    this._currentProject.set({ ...project, posts });
  }

  // ---- helpers -----------------------------------------------------------

  private readonly localAssetEdits = new Map<
    string,
    { name: string; group?: string; description?: string; tags?: string[] }
  >();

  private rememberAssetEdit(asset: Asset): void {
    if (!asset?.id) return;
    this.localAssetEdits.set(asset.id, {
      name: asset.name,
      group: asset.group,
      description: asset.description,
      tags: asset.tags,
    });
  }

  private applyLocalAssetEdits(project: Project): Project {
    if (!this.localAssetEdits.size || !project.assets?.length) return project;
    let changed = false;
    const assets = project.assets.map((a) => {
      const edit = this.localAssetEdits.get(a.id);
      if (!edit) return a;
      const tagsMatch =
        JSON.stringify(a.tags || []) === JSON.stringify(edit.tags || []);
      if (
        a.name === edit.name &&
        (a.group || '') === (edit.group || '') &&
        (a.description || '') === (edit.description || '') &&
        tagsMatch
      ) {
        this.localAssetEdits.delete(a.id);
        return a;
      }
      changed = true;
      return { ...a, ...edit };
    });
    return changed ? { ...project, assets } : project;
  }

  private applyProjectAssetUpdate(asset: Asset): void {
    const project = this._currentProject();
    if (!asset?.id) return;
    this.rememberAssetEdit(asset);
    if (!project?.assets?.length) return;
    const assets = project.assets.map((a) => (a.id === asset.id ? { ...a, ...asset } : a));
    this._currentProject.set({ ...project, assets });
  }

  private applyGlobalAssetUpdate(asset: Asset): void {
    if (!asset?.id) return;
    this._globalAssets.update((list) => list.map((a) => (a.id === asset.id ? { ...a, ...asset } : a)));
  }

  private readStoredProjectId(): string | null {
    try {
      const id = storageGet(ContentSproutApiService.PROJECT_KEY);
      return id?.trim() || null;
    } catch {
      return null;
    }
  }

  clearLlmError(): void {
    this._llmError.set(null);
  }

  formatError(err: unknown, fallback: string): string {
    return this.errMessage(err, fallback);
  }

  private reportLlmError(err: unknown, fallback?: string): void {
    const message =
      typeof err === 'string' && err.trim()
        ? err.trim()
        : this.errMessage(err, fallback || 'LLM request failed');
    this._llmError.set(message);
    this.snackbar.show(message, 'error', 10000);
  }

  private errMessage(err: unknown, fallback: string): string {
    const pick = (value: unknown): string | null => {
      const text = String(value ?? '').trim();
      if (!text) return null;
      if (/^Http failure response for /i.test(text)) return null;
      return text;
    };
    const fromBody = (body: unknown): string | null => {
      if (typeof body === 'string') {
        const trimmed = body.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            return fromBody(JSON.parse(trimmed));
          } catch {
            return pick(trimmed);
          }
        }
        return pick(trimmed);
      }
      if (!body || typeof body !== 'object') return null;
      const detail = (body as { detail?: unknown; error?: unknown; message?: unknown }).detail;
      if (typeof detail === 'string') return pick(detail);
      if (Array.isArray(detail) && detail[0]) {
        const first = detail[0] as { msg?: string; message?: string };
        return pick(first.msg || first.message || first);
      }
      if (detail && typeof detail === 'object') {
        const nested = detail as { msg?: string; message?: string };
        return pick(nested.msg || nested.message || JSON.stringify(detail));
      }
      const nestedError = (body as { error?: unknown }).error;
      if (nestedError && nestedError !== body) return fromBody(nestedError);
      return pick((body as { message?: string }).message);
    };

    if (err && typeof err === 'object') {
      const http = err as { status?: number; error?: unknown; message?: string };
      const bodyMsg = fromBody(http.error);
      if (bodyMsg) return bodyMsg;
      if (http.status === 0) {
        return 'Could not reach the Content-Sprout API. Check that the app is running.';
      }
      if (http.status === 502 || http.status === 503 || http.status === 504) {
        return fallback.includes('LLM') || fallback.includes('Script') || fallback.includes('AI')
          ? `${fallback}. The language model did not respond — check Settings → LLM.`
          : fallback;
      }
      const text = pick(http.message);
      if (text) return text;
    }
    if (typeof err === 'string') {
      const text = pick(err);
      if (text) return text;
    }
    return fallback;
  }
}
