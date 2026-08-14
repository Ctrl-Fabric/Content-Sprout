import { InjectionToken, type Provider } from '@angular/core';

/**
 * Host-supplied company / legal contact. `ui-shared` does not embed a product
 * name — each app must call {@link provideCompanyContact} at bootstrap.
 *
 * Consume via `shared/ui` or `shared/ui/config/company-contact`.
 */
export interface CompanyContact {
  /** Display / legal name shown in footers, Contact Us, and legal copy. */
  legalName: string;
  supportEmail: string;
  supportPhone?: string;
  websiteUrl?: string;
  addressLines?: string[];
}

export const COMPANY_CONTACT = new InjectionToken<CompanyContact>('COMPANY_CONTACT');

export const LEGAL_EFFECTIVE_DATE = new InjectionToken<string>('LEGAL_EFFECTIVE_DATE');

export interface ProvideCompanyContactOptions {
  /** Effective date string for Terms / Privacy / related legal pages. */
  legalEffectiveDate?: string;
}

function normalizeCompanyContact(contact: CompanyContact): Required<CompanyContact> {
  const lines = (contact.addressLines ?? []).map((line) => String(line ?? '').trim());
  while (lines.length < 4) lines.push('');
  return {
    legalName: String(contact.legalName ?? '').trim(),
    supportEmail: String(contact.supportEmail ?? '').trim(),
    supportPhone: String(contact.supportPhone ?? '').trim(),
    websiteUrl: String(contact.websiteUrl ?? '').trim(),
    addressLines: lines.slice(0, Math.max(4, lines.length)),
  };
}

/**
 * Wires company identity into a consuming app's DI.
 *
 * ```ts
 * providers: [
 *   provideCompanyContact({
 *     legalName: 'Acme',
 *     supportEmail: 'support@example.com',
 *     websiteUrl: 'https://example.com',
 *   }, { legalEffectiveDate: 'January 1, 2026' }),
 * ]
 * ```
 */
export function provideCompanyContact(
  contact: CompanyContact,
  options?: ProvideCompanyContactOptions,
): Provider[] {
  const providers: Provider[] = [
    { provide: COMPANY_CONTACT, useValue: normalizeCompanyContact(contact) },
  ];
  const date = options?.legalEffectiveDate?.trim();
  if (date) {
    providers.push({ provide: LEGAL_EFFECTIVE_DATE, useValue: date });
  }
  return providers;
}
