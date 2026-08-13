import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ModalWrapperComponent } from 'shared/ui';

type HelpSection = 'overview' | 'projects' | 'hub' | 'editor';
type InfoDialog = 'help' | 'about' | 'credits' | null;

@Component({
  selector: 'app-footer-info-dialogs',
  standalone: true,
  imports: [CommonModule, ModalWrapperComponent],
  changeDetection: ChangeDetectionStrategy.Default,
  template: `
    <app-modal-wrapper
      [isOpen]="open() === 'help'"
      title="Content-sprout walkthrough"
      subtitle="A guided tour of how the app fits together — jump to the section for the screen you are on."
      icon="menu_book"
      size="large"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="close()"
    >
      <div class="cs-help-tabs" role="tablist" aria-label="Walkthrough sections">
        <button
          type="button"
          role="tab"
          [class.active]="helpSection() === 'overview'"
          (click)="helpSection.set('overview')"
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          [class.active]="helpSection() === 'projects'"
          (click)="helpSection.set('projects')"
        >
          Projects
        </button>
        <button
          type="button"
          role="tab"
          [class.active]="helpSection() === 'hub'"
          (click)="helpSection.set('hub')"
        >
          Assets &amp; posts
        </button>
        <button
          type="button"
          role="tab"
          [class.active]="helpSection() === 'editor'"
          (click)="helpSection.set('editor')"
        >
          Editor
        </button>
      </div>

      <div class="cs-help-body">
        @switch (helpSection()) {
          @case ('overview') {
            <ol>
              <li>
                <strong>Projects</strong> — pick or create a project from the header (shared by all
                tools).
              </li>
              <li>
                <strong>Media Studio</strong> — upload photos/videos/audio, manage project assets,
                then create image or video posts.
              </li>
              <li>
                <strong>Editor</strong> — open a post for ideation, assets, canvas/timeline, then
                export.
              </li>
            </ol>
            <p class="meta cs-help-note">
              Everything stays on this computer. Use the side menu for
              <strong>Personal Media</strong> and <strong>Global Resources</strong>, and
              <strong>Settings</strong> for LLM / ComfyUI options.
            </p>
          }
          @case ('projects') {
            <h4>Projects (header)</h4>
            <ol>
              <li>
                Use the <strong>project control in the header</strong> to select or switch projects —
                it applies to every tool.
              </li>
              <li>Click <strong>Browse projects</strong> / the project chip to open the project browser.</li>
              <li>Create a project for a brand, campaign, or client.</li>
              <li>
                Delete a project only when you are sure — assets and posts inside it are removed from
                this machine.
              </li>
            </ol>
          }
          @case ('hub') {
            <h4>Project details</h4>
            <ol>
              <li>
                Use the <strong>Posts</strong> / <strong>Assets</strong> tabs in Media Studio for the
                open project.
              </li>
            </ol>
            <h4>Assets</h4>
            <ol>
              <li>Upload project-shared photos, videos, or audio from Media Studio.</li>
              <li>
                Use <strong>Personal Media</strong> to browse monitored folders and import into the
                project.
              </li>
              <li>
                <strong>Global Resources</strong> holds shared SFX, logos, and stills available to
                every project.
              </li>
            </ol>
            <h4>Posts</h4>
            <ol>
              <li>Create an image or video post, then open it for detail and editing.</li>
              <li>Post-private assets can be uploaded from the post detail view.</li>
            </ol>
          }
          @case ('editor') {
            <h4>Workflow by post type</h4>
            <ol>
              <li>
                <strong>Image</strong>: Ideation → Assets → Canvas → Export → Upload → Monitor.
              </li>
              <li>
                <strong>Video</strong>: Ideation → Script → Assets → Timeline → Export → Upload →
                Monitor. Script is optional — skip to Timeline anytime.
              </li>
            </ol>
            <h4>Shared steps</h4>
            <ol>
              <li>
                <strong>Ideation</strong>: set format and orientation, plus notes and references.
              </li>
              <li>
                <strong>Assets</strong>: pick project media or upload files private to this post.
              </li>
              <li>
                <strong>Timeline / Canvas</strong>: place media and preview.
              </li>
              <li>
                <strong>Export</strong>: download the chosen size plus a few downscaled versions.
              </li>
              <li>
                <strong>Upload</strong>: pick target platforms. Publishing accounts are not connected
                yet.
              </li>
              <li>
                <strong>Monitor</strong>: see upload status per platform.
              </li>
            </ol>
          }
        }
        <p class="meta">{{ helpHint() }}</p>
      </div>

      <ng-template #footerActions>
        <button type="button" class="primary" (click)="close()">Close</button>
      </ng-template>
    </app-modal-wrapper>

    <app-modal-wrapper
      [isOpen]="open() === 'about'"
      title="About Content-sprout"
      subtitle="What it does, where your files live, and how AI is used."
      icon="info"
      size="medium"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="close()"
    >
      <div class="cs-info-body">
        <section>
          <h4>What this is</h4>
          <p>
            <strong>Content-sprout</strong> helps you turn photos and videos into ready-to-share
            posts. Create projects for image or video posts, add assets, place text and image layers,
            build multi-scene reels, and export the result.
          </p>
        </section>
        <section>
          <h4>Your files stay on this computer</h4>
          <ul>
            <li>
              Projects, uploads, processed images, and exports are stored
              <strong>locally</strong> — nothing is uploaded to a remote server.
            </li>
            <li>
              Desktop app data lives under your user library folder; when you run from source, files
              stay in the project folders on disk.
            </li>
            <li>
              Deleting a project or asset removes it from your machine. There is no cloud backup from
              this app.
            </li>
          </ul>
        </section>
        <section>
          <h4>AI &amp; logo placement</h4>
          <ul>
            <li>
              When logo placement is uncertain, the app can ask an AI vision model for help. You
              control this under <strong>Settings</strong>.
            </li>
            <li>
              <strong>Built-in placement</strong> — works fully offline; no AI service is contacted.
            </li>
            <li>
              <strong>Ollama</strong> — connect to models you host locally on this machine or your
              network.
            </li>
            <li>
              <strong>LLM proxy</strong> — route requests through OpenAI-compatible gateways. Your API
              key and traffic go only to that provider.
            </li>
            <li>
              <strong>Text to voice</strong> — on video posts, voice layers can use local speech to
              create audio for export.
            </li>
            <li>
              <strong>Text to video</strong> — optional ComfyUI connection generates clips on your
              machine; nothing leaves this computer.
            </li>
          </ul>
        </section>
        <section>
          <h4>Things to know</h4>
          <ul>
            <li>
              <strong>Video export</strong> needs <code>ffmpeg</code> installed
              (<code>brew install ffmpeg</code>).
            </li>
            <li>
              The editor runs in your browser against a local server on this machine. Keep this window
              open while you work.
            </li>
            <li>
              This is a local-first creative tool — treat your machine as the source of truth for
              projects and media.
            </li>
          </ul>
        </section>
        <p class="meta">Content-sprout · open source (MIT)</p>
      </div>
      <ng-template #footerActions>
        <button type="button" (click)="openSettings()">Open Settings</button>
        <button type="button" class="primary" (click)="close()">Got it</button>
      </ng-template>
    </app-modal-wrapper>

    <app-modal-wrapper
      [isOpen]="open() === 'credits'"
      title="Credits"
      subtitle="Open-source project · community software"
      icon="favorite"
      size="small"
      customClass="cs-console-modal"
      closeButtonPosition="header"
      (close)="close()"
    >
      <div class="cs-info-body">
        <p>
          <strong>Content-sprout</strong> is free, <strong>open-source software</strong> under the MIT
          license. Anyone may use, modify, and share it.
        </p>
        <p>
          Your projects and media stay on this computer. Optional cloud AI you configure goes to
          <em>your</em> providers — not through a Content-sprout cloud.
        </p>
        <p class="meta">MIT licensed · open source</p>
      </div>
      <ng-template #footerActions>
        <button type="button" class="primary" (click)="close()">Close</button>
      </ng-template>
    </app-modal-wrapper>
  `,
})
export class FooterInfoDialogsComponent {
  @Input() currentPath = '/media-studio';

  readonly open = signal<InfoDialog>(null);
  readonly helpSection = signal<HelpSection>('overview');

  constructor(private router: Router) {}

  show(action: string): void {
    if (action === 'help') {
      this.helpSection.set(this.sectionForPath(this.currentPath));
      this.open.set('help');
      return;
    }
    if (action === 'about' || action === 'credits') {
      this.open.set(action);
    }
  }

  close(): void {
    this.open.set(null);
  }

  openSettings(): void {
    this.close();
    void this.router.navigateByUrl('/settings');
  }

  helpHint(): string {
    const hints: Record<HelpSection, string> = {
      overview: 'Start here for the big picture, then pick a section.',
      projects: 'Projects live in the header — select, create, or browse anytime.',
      hub: 'Assets library, logos, and posts list.',
      editor: 'Ideation → Script → Assets → Timeline workflow, preview, and export.',
    };
    return hints[this.helpSection()];
  }

  private sectionForPath(path: string): HelpSection {
    if (path.startsWith('/media-studio/posts/')) return 'editor';
    if (path.startsWith('/media-studio')) return 'hub';
    if (path.startsWith('/personal-media') || path.startsWith('/global-resources')) return 'overview';
    if (path.startsWith('/settings')) return 'overview';
    return 'overview';
  }
}
