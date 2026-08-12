import { Routes } from '@angular/router';
import { AppShell } from './pages/app-shell/app-shell';
import { MediaStudioPage } from './pages/media-studio/media-studio';
import { PostDetailPage } from './pages/post-detail/post-detail';
import { PersonalMediaPage } from './pages/personal-media/personal-media';
import { GlobalResourcesPage } from './pages/global-resources/global-resources';
import { SettingsPage } from './pages/settings/settings';
import { AiGenPage } from './pages/ai-gen/ai-gen';

export const routes: Routes = [
  {
    path: '',
    component: AppShell,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'media-studio' },
      { path: 'media-studio', component: MediaStudioPage },
      { path: 'media-studio/posts/:postId', component: PostDetailPage },
      { path: 'personal-media', component: PersonalMediaPage },
      { path: 'global-resources', component: GlobalResourcesPage },
      { path: 'settings', component: SettingsPage },
      { path: 'ai-gen', component: AiGenPage },
    ],
  },
  { path: '**', redirectTo: 'media-studio' },
];
