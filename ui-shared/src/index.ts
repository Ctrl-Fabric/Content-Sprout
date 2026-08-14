/**
 * Shared UI — build-time source library.
 *
 * Framework-only (Angular + CSS variables) standalone components, directives and
 * services shared across product Angular apps. Consumed at BUILD TIME via a
 * TypeScript path alias (`shared/ui`) — there is no published package and no
 * separate build step; each app compiles this source into its own bundle.
 *
 * Component styling relies on the design-system classes shipped in
 * `ui-shared/src/styles`. Import the styles once in the app's global stylesheet:
 *   @use '../../ui-shared/src/styles/identity-console' as console;
 *
 * Do not hardcode a company / product display name here. Hosts supply it at
 * runtime with {@link provideCompanyContact}.
 */

/* ── Layout / page primitives ───────────────────────────────────────────── */
export { PageContextService } from './services/page-context.service';
export { PageWrapperComponent } from './components/page-wrapper/page-wrapper';
export { FooterComponent } from './components/footer/footer';
export {
  ServiceShellHeaderComponent,
  ServiceConsoleHeaderComponent,
  ServiceTenantChipComponent,
  ServiceSideRailComponent,
  ServiceUserMenuComponent,
  ServiceAccountInfoModalComponent,
  DEFAULT_SERVICE_USER_MENU_ITEMS,
  type ServiceNavChild,
  type ServiceNavItem,
  type ServiceRailBrand,
  type ServiceFooterLink,
  type ServiceUserMenuItem,
  type ServiceAccountInfoKind,
  type ServiceAccountUserInfo,
  type ServiceAccountSessionInfo,
} from './components/service-shell';

/* ── Overlays / dialogs ─────────────────────────────────────────────────── */
export { Modal } from './modal/modal';
export { ModalWrapperComponent } from './components/modal-wrapper/modal-wrapper';
export { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog';
export { PromptDialogComponent } from './components/prompt-dialog/prompt-dialog';
export { DialogHostComponent } from './components/dialog-host/dialog-host';
export {
  DialogService,
  type ConfirmDialogOptions,
  type PromptDialogOptions,
  type DialogSeverity,
} from './services/dialog.service';

/* ── List / detail ──────────────────────────────────────────────────────── */
export {
  ListDetailView,
  type ListDetailConfig,
  type ListItemBadge,
  type ListItemMeta,
  type ListItemAction,
} from './list-detail-view/list-detail-view';
export { ListViewComponent } from './components/list-view/list-view';

/* ── Form controls ──────────────────────────────────────────────────────── */
export { ButtonComponent, type ButtonVariant, type ButtonSize } from './components/button/button';
export { CheckboxComponent } from './components/checkbox/checkbox';
export { ToggleComponent } from './components/toggle/toggle';
export { CustomSelectComponent, type SelectOption } from './components/custom-select/custom-select';
export { MultiSelectComponent, type MultiSelectOption } from './components/multi-select/multi-select';
export { MultiSelectWithBadgesComponent } from './components/multi-select-with-badges/multi-select-with-badges';
export { AutocompleteComponent, type AutocompleteOption } from './components/autocomplete/autocomplete';
export { SearchBarComponent } from './components/search-bar/search-bar';

/* ── Navigation / display ───────────────────────────────────────────────── */
export { PaginationComponent } from './components/pagination/pagination';
export { SegmentedTabBarComponent, type SegmentedTab } from './components/segmented-tab-bar/segmented-tab-bar';
export { ActionMenuComponent, type ActionMenuItem } from './components/action-menu/action-menu';
export {
  InfoGridComponent,
  type InfoGridBadgeVariant,
  type InfoGridBadgeSpec,
  type InfoGridItem,
  type InfoGridSpec,
  type InfoGridVariant,
} from './components/info-grid/info-grid';
export { BadgeComponent, type BadgeVariant, type BadgeSize } from './components/badge/badge';
export { ScopeFlagsBadgesComponent } from './components/scope-flags-badges/scope-flags-badges';

/* ── Schema editors ─────────────────────────────────────────────────────── */
export {
  JsonSchemaEditorComponent,
  type JsonSchema,
  type JsonSchemaProperty,
} from './components/json-schema-editor/json-schema-editor';
export { XmlSchemaEditorComponent } from './components/xml-schema-editor/xml-schema-editor';

/* ── Notifications ──────────────────────────────────────────────────────── */
export { SnackbarComponent } from './components/snackbar/snackbar';
export { SnackbarService, type SnackbarMessage } from './services/snackbar.service';

/* ── Directives ─────────────────────────────────────────────────────────── */
export { ClickOutsideDirective } from './directives/click-outside.directive';

/* ── Utilities ──────────────────────────────────────────────────────────── */
export { copyToClipboard } from './utils/clipboard';
export { storageGet, storageSet, storageRemove } from './utils/legacy-storage';

/* ── Company / legal config ─────────────────────────────────────────────── */
export {
  COMPANY_CONTACT,
  LEGAL_EFFECTIVE_DATE,
  provideCompanyContact,
  type CompanyContact,
  type ProvideCompanyContactOptions,
} from './config/company-contact';
