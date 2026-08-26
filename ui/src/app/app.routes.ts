import { Routes, type RedirectFunction } from '@angular/router';
import { AppShell } from './pages/app-shell/app-shell';
import { MediaStudioPage } from './pages/media-studio/media-studio';
import { PostDetailPage } from './pages/post-detail/post-detail';
import { GlobalResourcesPage } from './pages/global-resources/global-resources';
import { SettingsPage } from './pages/settings/settings';
import { CreatePage } from './pages/create/create';
import { SetupPage } from './pages/setup/setup';

function redirectToCreateTab(tab: 'ai-gen' | 'photo-magic'): RedirectFunction {
  return ({ queryParams }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams || {})) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, String(item));
      } else {
        params.set(key, String(value));
      }
    }
    params.set('tab', tab);
    const q = params.toString();
    return `/create?${q}`;
  };
}

export const routes: Routes = [
  {
    path: '',
    component: AppShell,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'media-studio' },
      { path: 'media-studio', component: MediaStudioPage },
      { path: 'media-studio/posts/:postId', component: PostDetailPage },
      { path: 'personal-media', redirectTo: 'global-resources', pathMatch: 'full' },
      { path: 'global-resources', component: GlobalResourcesPage },
      { path: 'settings', component: SettingsPage },
      { path: 'setup', component: SetupPage },
      { path: 'create', component: CreatePage },
      { path: 'ai-gen', redirectTo: redirectToCreateTab('ai-gen') },
      { path: 'photo-magic', redirectTo: redirectToCreateTab('photo-magic') },
    ],
  },
  { path: '**', redirectTo: 'media-studio' },
];
