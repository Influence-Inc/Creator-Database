import { Injectable, NotFoundException } from '@nestjs/common';
import { Contract, Creator } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Renders a stored signed {@link Contract} as a self-contained, print-ready
 * legal document — a "Creator Services Agreement" — that an admin can view in the
 * browser or download and save as PDF.
 *
 * The document deliberately EXCLUDES the creator's bank / payout details
 * (`Contract.paymentDetails`): account numbers, IBANs, routing / IFSC / SWIFT
 * codes and tax IDs never appear in the agreement. Banking information is
 * collected and stored separately (the payment-of-record view), and a clause in
 * the compensation section makes that separation explicit. Everything else that
 * belongs in the executed agreement — parties, deliverables, timeline, usage
 * rights, exclusivity, compensation terms, the signer's identity + mailing
 * address and the drawn signature — is included.
 *
 * All creator-supplied values are HTML-escaped before they reach the output, so
 * a malicious deliverables / notes string can't inject script into the admin's
 * browser when the document is viewed.
 */
@Injectable()
export class ContractDocumentService {
  /** The contracting party the platform acts as (the agency of record). */
  private static readonly COMPANY_NAME = 'Mighty Crew (operating as Influence)';

  /** The Company's registered address, shown in the parties block. */
  private static readonly COMPANY_ADDRESS =
    'SF, Flat No. 207, Venkatadri Residency, Concord Layout, Rajarajeshwari Nagar, Bengaluru, Bengaluru Urban, Karnataka, 560098, India';

  /** The person who countersigns on the Company's behalf. */
  private static readonly COMPANY_SIGNATORY = 'Tharun R';

  // The authorised signatory's signature, referenced by URL. The image is loaded
  // by the viewer's browser when the document is opened or printed.
  private static readonly COMPANY_SIGNATURE_URL =
    'https://ik.imagekit.io/ry8a2dca0h/Tharun%20Signature%20-%20Govt%20Proofs.jpg?updatedAt=1765977839681';

  private static readonly CURRENCY_SYMBOL: Record<string, string> = {
    USD: '$',
    EUR: '€',
    GBP: '£',
    INR: '₹',
    CAD: 'C$',
    AUD: 'A$',
  };

  // The INFLUENCE wordmark (same artwork as the admin console / signing page),
  // embedded so the document stays self-contained when downloaded.
  private static readonly WORDMARK =
    '<svg viewBox="0 0 793 70" role="img" aria-label="INFLUENCE" fill="currentColor"><path d="M20.01 68.6729H1.35348e-05V1.03334H20.01V68.6729ZM126.221 69.8941L55.1993 29.4044V68.6729H42.5169V-4.03086e-05L113.538 40.3018V1.03334H126.221V69.8941ZM209.764 44.2475H168.992V68.6729H148.794V1.03334H219.816V11.9308H169.086V33.35H209.764V44.2475ZM306.528 68.6729H236.54V1.03334H256.738V57.7754H306.528V68.6729ZM389.07 34.6652V1.03334H401.847V34.6652C401.847 40.8029 400.813 46.1577 398.747 50.7296C396.742 55.3015 393.861 58.934 390.104 61.6271C386.409 64.3201 382.15 66.3243 377.327 67.6395C372.505 68.9547 367.119 69.6123 361.169 69.6123C348.706 69.6123 338.81 66.7627 331.483 61.0634C324.218 55.3642 320.585 46.6274 320.585 34.8531V1.03334H341.065V34.6652C341.065 38.8614 341.754 42.4939 343.132 45.5627C344.51 48.6315 346.357 51.0114 348.675 52.7024C351.054 54.3934 353.591 55.646 356.284 56.4602C359.04 57.2117 361.983 57.5875 365.115 57.5875C368.246 57.5875 371.158 57.2117 373.851 56.4602C376.607 55.646 379.144 54.3934 381.461 52.7024C383.841 51.0114 385.688 48.6315 387.004 45.5627C388.381 42.4939 389.07 38.8614 389.07 34.6652ZM494.814 68.6729H423.041V1.03334H494.814V11.9308H443.238V28.7468H484.386V39.6442H443.238V57.7754H494.814V68.6729ZM596.325 69.8941L525.303 29.4044V68.6729H512.621V-4.03086e-05L583.643 40.3018V1.03334H596.325V69.8941ZM702.321 52.6085V63.7878C692.989 67.796 681.778 69.8002 668.689 69.8002C657.917 69.8002 648.428 68.4536 640.224 65.7606C632.082 63.0049 625.694 58.9653 621.059 53.6418C616.425 48.3184 614.108 42.0555 614.108 34.8531C614.108 24.0809 619.087 15.6259 629.045 9.48828C639.003 3.28799 652.217 0.187845 668.689 0.187845C681.966 0.187845 693.177 2.19198 702.321 6.20025V18.5069C693.302 13.4965 682.78 10.9914 670.756 10.9914C659.545 10.9914 650.84 13.246 644.639 17.7553C638.439 22.202 635.339 27.9013 635.339 34.8531C635.339 41.8676 638.439 47.6294 644.639 52.1387C650.902 56.648 659.796 58.9027 671.319 58.9027C682.029 58.9027 692.363 56.8046 702.321 52.6085ZM792.821 68.6729H721.048V1.03334H792.821V11.9308H741.246V28.7468H782.393V39.6442H741.246V57.7754H792.821V68.6729Z"/></svg>';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Load a creator's contract and render the legal document for it. Throws
   * NotFound if the creator or the contract (scoped to that creator) is missing.
   */
  async render(creatorId: string, contractId: string): Promise<{ filename: string; html: string }> {
    const creator = await this.prisma.creator.findUnique({ where: { id: creatorId } });
    if (!creator) throw new NotFoundException(`Creator ${creatorId} not found`);

    // Scope the lookup to the creator so one creator's id can't fetch another's
    // contract by guessing a contract id.
    const contract = await this.prisma.contract.findFirst({
      where: { id: contractId, creatorId },
    });
    if (!contract) {
      throw new NotFoundException(`Contract ${contractId} not found for creator ${creatorId}`);
    }

    return { filename: this.filename(creator, contract), html: this.renderHtml(creator, contract) };
  }

  // -------------------------------------------------------------------------
  // Formatting helpers
  // -------------------------------------------------------------------------

  private esc(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (c) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string;
    });
  }

  private fmtDate(value: Date | null | undefined): string {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }

  private fmtNumber(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) return '';
    return Number(value).toLocaleString('en-US');
  }

  private fmtMoney(amount: number | null | undefined, currency: string | null | undefined): string {
    if (amount === null || amount === undefined || Number.isNaN(amount)) return '';
    const cur = (currency || 'USD').toUpperCase();
    const sym = ContractDocumentService.CURRENCY_SYMBOL[cur] ?? '';
    const num = Number(amount).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${sym}${num} ${cur}`;
  }

  /** Use `value` when it has content, otherwise `fallback`. Escapes `value`. */
  private orText(value: string | null | undefined, fallback: string): string {
    const v = value && value.trim() ? value.trim() : '';
    return v ? this.esc(v) : fallback;
  }

  private filename(creator: Creator, contract: Contract): string {
    const who =
      creator.creatorName || contract.signerName || creator.instagramUsername || 'creator';
    const ref = contract.campaignName || contract.contractRef || 'agreement';
    const raw = `Creator-Services-Agreement-${who}-${ref}`;
    const safe = raw
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return `${safe || 'Creator-Services-Agreement'}.html`;
  }

  // -------------------------------------------------------------------------
  // Document sections
  // -------------------------------------------------------------------------

  /** The two parties and their identifying details. */
  private partiesBlock(creator: Creator, contract: Contract): string {
    const creatorName =
      contract.signerName || creator.creatorName || creator.instagramUsername || 'the Creator';
    const email = contract.signerEmail || creator.email || '';
    const phone = contract.signerPhone || creator.phoneNumber || '';
    const handle = creator.instagramUsername ? `@${creator.instagramUsername}` : '';

    const addr = [
      contract.addressLine1 ?? creator.addressLine1,
      contract.addressLine2 ?? creator.addressLine2,
      contract.addressCity ?? creator.addressCity,
      contract.addressState ?? creator.addressState,
      contract.addressPostalCode ?? creator.addressPostalCode,
      contract.addressCountry ?? creator.addressCountry,
    ]
      .filter((p) => p && String(p).trim())
      .map((p) => this.esc(p))
      .join(', ');

    const brand = contract.brandName ? this.esc(contract.brandName) : null;

    const detail = (label: string, value: string): string =>
      value
        ? `<div class="pd-row"><span class="pd-k">${label}</span><span class="pd-v">${value}</span></div>`
        : '';

    const companyParty =
      `<div class="party">` +
      `<div class="party-role">The Company</div>` +
      `<div class="party-name">${this.esc(ContractDocumentService.COMPANY_NAME)}</div>` +
      detail('Address', this.esc(ContractDocumentService.COMPANY_ADDRESS)) +
      detail(
        'Acting for',
        brand
          ? `${brand} (the &ldquo;Brand&rdquo;)`
          : 'the applicable brand client (the &ldquo;Brand&rdquo;)',
      ) +
      `</div>`;

    const creatorParty =
      `<div class="party">` +
      `<div class="party-role">The Creator</div>` +
      `<div class="party-name">${this.esc(creatorName)}</div>` +
      detail('Handle', handle ? `<span class="mono">${this.esc(handle)}</span>` : '') +
      detail('Email', email ? `<span class="mono">${this.esc(email)}</span>` : '') +
      detail('Phone', phone ? `<span class="mono">${this.esc(phone)}</span>` : '') +
      detail('Address', addr) +
      `</div>`;

    return `<div class="parties">${companyParty}${creatorParty}</div>`;
  }

  /** Build the ordered list of substantive clauses. */
  private clauses(creator: Creator, contract: Contract): Array<{ title: string; body: string }> {
    const brand = contract.brandName ? this.esc(contract.brandName) : 'the Brand';
    const campaign = contract.campaignName
      ? `the &ldquo;${this.esc(contract.campaignName)}&rdquo; campaign`
      : 'the applicable campaign';

    // Scope-of-services wording: the campaign name and the Creator's country of
    // performance (from the signer/creator address). Both fall back gracefully.
    const scopeCampaign = contract.campaignName
      ? `${this.esc(contract.campaignName)} campaign`
      : 'applicable campaign';
    const country = contract.addressCountry || creator.addressCountry;
    const scopeCountry = country
      ? this.esc(country)
      : 'the Creator&rsquo;s country of residence (outside India)';

    const deliverables = this.orText(
      contract.deliverables,
      'the content deliverables described in the applicable campaign brief',
    );
    const count =
      contract.numberOfDeliverables != null
        ? ` The total number of deliverables shall be ${this.esc(String(contract.numberOfDeliverables))}.`
        : '';
    const platform = contract.platform
      ? ` The Content shall be published on the ${this.esc(contract.platform)} platform(s).`
      : '';

    const timeline = this.orText(
      contract.timeline,
      'the schedule communicated by the Company to the Creator',
    );
    const deadline = contract.deadline
      ? ` The Creator shall publish all final deliverables no later than <strong>${this.fmtDate(contract.deadline)}</strong> (the &ldquo;Deadline&rdquo;), unless extended by the Company in writing.`
      : ' Final deliverables shall be published by the date(s) communicated by the Company in writing.';

    const usage = this.orText(
      contract.usageRights,
      'The Company and the Brand may use, reproduce, distribute, display and repurpose the Content across the Brand&rsquo;s owned and operated channels in connection with the campaign.',
    );

    const exclusivity = contract.exclusivity
      ? this.esc(contract.exclusivity)
      : 'The Creator is not subject to category exclusivity under this Agreement except as may be separately agreed by the parties in writing.';

    const guaranteed =
      contract.guaranteedViews != null
        ? ` The parties have agreed a performance target of <strong>${this.fmtNumber(contract.guaranteedViews)}</strong> views across the deliverables. The Creator shall use commercially reasonable efforts to meet this target; where the Content materially underperforms, the parties shall discuss make-good deliverables in good faith.`
        : '';

    const compensation =
      contract.compensation != null
        ? `a total fee of <strong>${this.fmtMoney(contract.compensation, contract.currency)}</strong>`
        : 'the fee agreed between the parties for this campaign';
    const paymentTerms = this.orText(
      contract.paymentTerms,
      'within thirty (30) days of the Company&rsquo;s approval of the published deliverables',
    );

    const clauses: Array<{ title: string; body: string }> = [
      {
        title: 'Engagement',
        body:
          `<p>The Company engages the Creator, and the Creator accepts the engagement, to create and publish the ` +
          `content described in this Agreement (the &ldquo;Content&rdquo;) in connection with ${campaign} for ${brand}. ` +
          `The Creator shall perform the Services with reasonable skill and care and in a professional manner.</p>`,
      },
      {
        title: 'Scope of Services',
        body:
          `<p>The Creator shall create short-form video content as part of the ${scopeCampaign}, including ` +
          `ideation, filming, editing, and publishing of such content.</p>` +
          `<p>All services under this Agreement shall be performed entirely outside India, from ${scopeCountry}.</p>`,
      },
      {
        title: 'Deliverables & Content',
        body:
          `<p>The Creator shall produce and deliver: ${deliverables}.${count}${platform} ` +
          `All Content shall comply with the campaign brief, the Brand&rsquo;s reasonable guidelines, and applicable ` +
          `platform terms of service.</p>`,
      },
      {
        title: 'Timeline & Deadlines',
        body: `<p>The Creator shall perform the Services in accordance with ${timeline}.${deadline}</p>`,
      },
      {
        title: 'Content Usage Rights & Licence',
        body:
          `<p>${usage}</p>` +
          `<p>The Creator grants the Company and the Brand a non-exclusive, worldwide, royalty-free licence to use, ` +
          `host, reproduce and display the Content for the purposes described above for the term of the campaign and ` +
          `any usage period agreed above. Any paid media, boosting or extended usage beyond the scope stated here shall ` +
          `be agreed separately in writing.</p>`,
      },
      {
        title: 'Exclusivity',
        body: `<p>${exclusivity}</p>`,
      },
      {
        title: 'Performance',
        body:
          `<p>The Creator shall use commercially reasonable efforts to maximise the reach and engagement of the Content.` +
          `${guaranteed}</p>`,
      },
      {
        title: 'Compensation & Payment',
        body:
          `<p>In full consideration for the Services and the rights granted under this Agreement, the Company shall pay ` +
          `the Creator ${compensation}, payable ${paymentTerms}.</p>` +
          `<p>Payment shall be remitted to the account designated by the Creator. The Creator&rsquo;s banking and payout ` +
          `information is collected and held separately and confidentially by the Company and does not form part of this ` +
          `Agreement. The Creator is responsible for all taxes arising from the compensation received hereunder.</p>`,
      },
      {
        title: 'Independent Contractor',
        body:
          `<p>The Creator is engaged as an independent contractor. Nothing in this Agreement creates an employment, ` +
          `partnership, joint venture or agency relationship between the parties. The Creator is responsible for the ` +
          `manner and means of performing the Services and for the Creator&rsquo;s own taxes, insurance and expenses.</p>`,
      },
      {
        title: 'Representations & Warranties',
        body:
          `<p>The Creator represents and warrants that: (a) the Content is original to the Creator or the Creator has ` +
          `secured all necessary rights and clearances; (b) the Content does not infringe the intellectual property, ` +
          `privacy or other rights of any third party; (c) the Content does not contain unlawful, defamatory or ` +
          `misleading material; and (d) the Creator has full authority to enter into and perform this Agreement.</p>`,
      },
      {
        title: 'Advertising Disclosure & Compliance',
        body:
          `<p>The Creator shall clearly and conspicuously disclose the commercial nature of the Content in accordance ` +
          `with applicable law and platform policy (for example, using &ldquo;#ad&rdquo; or the platform&rsquo;s paid-partnership ` +
          `label). The Creator shall comply with all applicable advertising standards and consumer-protection ` +
          `regulations, including as relevant the U.S. FTC Endorsement Guides and equivalent local rules.</p>`,
      },
      {
        title: 'Intellectual Property',
        body:
          `<p>Except for the licence granted above, the Creator retains ownership of the Content the Creator authors. ` +
          `The Brand retains all rights in its trademarks, logos and campaign materials, which the Creator may use only ` +
          `as necessary to perform the Services and in accordance with the Brand&rsquo;s guidelines.</p>`,
      },
      {
        title: 'Confidentiality',
        body:
          `<p>Each party shall keep confidential all non-public information disclosed by the other party in connection ` +
          `with this Agreement, including campaign details, rates and business information, and shall use such ` +
          `information solely to perform this Agreement.</p>`,
      },
      {
        title: 'Term & Termination',
        body:
          `<p>This Agreement takes effect on the Effective Date and continues until the Services and any agreed usage ` +
          `period are complete, unless terminated earlier. Either party may terminate for the other party&rsquo;s material ` +
          `breach that remains uncured for ten (10) days after written notice. Provisions relating to usage rights, ` +
          `confidentiality, warranties, indemnity and payment for Services already performed survive termination.</p>`,
      },
      {
        title: 'Indemnification',
        body:
          `<p>Each party shall indemnify and hold the other harmless from third-party claims, damages and reasonable ` +
          `expenses arising out of that party&rsquo;s breach of this Agreement, negligence or wilful misconduct, or, in the ` +
          `case of the Creator, any breach of the representations and warranties above.</p>`,
      },
      {
        title: 'Limitation of Liability',
        body:
          `<p>Except for a party&rsquo;s indemnity obligations, breach of confidentiality, or the Creator&rsquo;s warranty ` +
          `breaches, neither party shall be liable for indirect or consequential losses, and each party&rsquo;s aggregate ` +
          `liability under this Agreement shall not exceed the total compensation payable to the Creator hereunder.</p>`,
      },
      {
        title: 'Governing Law & Disputes',
        body:
          `<p>This Agreement is governed by the laws of the jurisdiction in which the Company is established, without ` +
          `regard to its conflict-of-laws rules. The parties shall attempt to resolve any dispute in good faith before ` +
          `resorting to formal proceedings in the competent courts of that jurisdiction.</p>`,
      },
      {
        title: 'General Provisions',
        body:
          `<p>This Agreement, together with the applicable campaign brief, constitutes the entire agreement between the ` +
          `parties and supersedes all prior discussions. It may be amended only in writing signed by both parties. If ` +
          `any provision is held unenforceable, the remainder stays in effect. The Creator may not assign this ` +
          `Agreement without the Company&rsquo;s prior written consent. This Agreement may be executed electronically and ` +
          `in counterparts, each of which is deemed an original.</p>`,
      },
    ];

    // Optional special provisions — only when the contract carries them.
    const special = this.specialProvisions(contract);
    if (special) {
      clauses.push({ title: 'Special Provisions', body: special });
    }

    return clauses;
  }

  private specialProvisions(contract: Contract): string | null {
    const parts: string[] = [];
    if (contract.specialNotes && contract.specialNotes.trim()) {
      parts.push(`<p>${this.esc(contract.specialNotes.trim())}</p>`);
    }
    const extra = contract.additionalTerms;
    if (Array.isArray(extra)) {
      const items = extra
        .filter((t) => t != null && String(t).trim())
        .map((t) => `<li>${this.esc(String(t).trim())}</li>`)
        .join('');
      if (items) parts.push(`<ul>${items}</ul>`);
    }
    return parts.length ? parts.join('') : null;
  }

  /** Signature block: the Creator's drawn signature (if any) + a Company line. */
  private signatureBlock(creator: Creator, contract: Contract): string {
    const creatorName =
      contract.signerName || creator.creatorName || creator.instagramUsername || '';
    const signedDate = contract.signedAt || contract.signerSignedDate;

    // Only embed a signature image that matches the expected data-URL shape;
    // it's rendered inside <img> (no script execution) and never as markup.
    const validSig =
      contract.signatureImage &&
      /^data:image\/(png|jpeg|jpg|svg\+xml);base64,/.test(contract.signatureImage)
        ? contract.signatureImage
        : null;

    const creatorSig = validSig
      ? `<img class="sig-img" src="${this.esc(validSig)}" alt="Creator signature">`
      : `<div class="sig-line-fill"></div>`;

    return (
      `<div class="signatures">` +
      `<div class="sig-block">` +
      `<div class="sig-mark">${creatorSig}</div>` +
      `<div class="sig-rule"></div>` +
      `<div class="sig-role">The Creator</div>` +
      `<div class="sig-name">${this.esc(creatorName)}</div>` +
      (signedDate ? `<div class="sig-date">Date: ${this.fmtDate(signedDate)}</div>` : '') +
      `</div>` +
      `<div class="sig-block">` +
      `<div class="sig-mark"><img class="sig-img" src="${this.esc(ContractDocumentService.COMPANY_SIGNATURE_URL)}" alt="Company signature"></div>` +
      `<div class="sig-rule"></div>` +
      `<div class="sig-role">The Company</div>` +
      `<div class="sig-name">${this.esc(ContractDocumentService.COMPANY_NAME)}</div>` +
      `<div class="sig-signatory">By: ${this.esc(ContractDocumentService.COMPANY_SIGNATORY)}, Authorised Signatory</div>` +
      `<div class="sig-date">Date: ${signedDate ? this.fmtDate(signedDate) : '______________________'}</div>` +
      `</div>` +
      `</div>`
    );
  }

  // -------------------------------------------------------------------------
  // Document assembly
  // -------------------------------------------------------------------------

  private renderHtml(creator: Creator, contract: Contract): string {
    const effectiveDate =
      contract.signedAt || contract.signerSignedDate || contract.createdAt || null;
    const statusLabel =
      contract.status === 'COMPLETED'
        ? 'Completed'
        : contract.status === 'SIGNED'
          ? 'Signed'
          : 'Pending';

    const clauses = this.clauses(creator, contract);
    const clauseHtml = clauses
      .map(
        (c, i) =>
          `<section class="clause">` +
          `<h2><span class="clause-no">${i + 1}.</span> ${this.esc(c.title)}</h2>` +
          `${c.body}` +
          `</section>`,
      )
      .join('');

    const recital =
      `<p>This Creator Services Agreement (the &ldquo;Agreement&rdquo;) is made and entered into as of ` +
      `<strong>${this.fmtDate(effectiveDate) || '____________________'}</strong> (the &ldquo;Effective Date&rdquo;) by and ` +
      `between the parties identified below. The parties agree as follows:</p>`;

    const refLine = [
      contract.contractRef ? `Reference: ${this.esc(contract.contractRef)}` : '',
      `Status: ${this.esc(statusLabel)}`,
      effectiveDate ? `Executed: ${this.fmtDate(effectiveDate)}` : '',
    ]
      .filter(Boolean)
      .join(' &nbsp;·&nbsp; ');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Creator Services Agreement${contract.contractRef ? ' · ' + this.esc(contract.contractRef) : ''}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: #f4f4f5;
    color: #18181b;
    font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
    font-size: 15px;
    line-height: 1.65;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .mono { font-family: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: 0.92em; }

  /* Screen-only action bar. */
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 12px 20px;
    background: #111113; color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
  }
  .toolbar .t-title { font-weight: 600; letter-spacing: .02em; }
  .toolbar button {
    font: inherit; font-weight: 600; cursor: pointer;
    border: 0; border-radius: 8px; padding: 8px 16px;
    background: #6d5efc; color: #fff;
  }
  .toolbar button:hover { background: #5b4ce0; }

  .sheet {
    max-width: 8.5in; margin: 24px auto; padding: 0.9in 0.85in 0.7in;
    background: #fff; border: 1px solid #e4e4e7; border-radius: 4px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08);
  }

  header.doc-head { text-align: center; border-bottom: 2px solid #18181b; padding-bottom: 18px; margin-bottom: 24px; }
  .wordmark { height: 20px; margin: 0 auto 14px; color: #18181b; }
  .wordmark svg { height: 20px; width: auto; display: block; margin: 0 auto; }
  h1 { font-size: 22px; letter-spacing: .04em; text-transform: uppercase; margin: 4px 0 8px; }
  .doc-meta { font-size: 12px; color: #52525b; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

  .recital { margin: 0 0 22px; }

  .parties { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 0 0 26px; }
  .party { border: 1px solid #e4e4e7; border-radius: 6px; padding: 14px 16px; background: #fafafa; }
  .party-role { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #71717a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin-bottom: 4px; }
  .party-name { font-size: 16px; font-weight: 700; margin-bottom: 8px; }
  .pd-row { display: flex; gap: 8px; font-size: 13px; margin-top: 3px; }
  .pd-k { flex: 0 0 64px; color: #71717a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 12px; }
  .pd-v { flex: 1; }

  .clause { margin: 0 0 16px; }
  .clause h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .03em; margin: 0 0 6px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .clause-no { color: #18181b; margin-right: 4px; }
  .clause p { margin: 0 0 8px; text-align: justify; }
  .clause ul { margin: 6px 0 8px; padding-left: 22px; }
  .clause li { margin: 3px 0; }

  .signatures { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 40px; page-break-inside: avoid; }
  .sig-block { }
  .sig-mark { height: 64px; display: flex; align-items: flex-end; }
  .sig-img { max-height: 64px; max-width: 100%; }
  .sig-line-fill { height: 64px; }
  .sig-rule { border-top: 1px solid #18181b; margin-top: 2px; }
  .sig-role { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #71717a; margin-top: 6px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .sig-name { font-weight: 700; font-size: 15px; margin-top: 2px; }
  .sig-signatory { font-size: 12px; color: #18181b; font-weight: 500; margin-top: 2px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .sig-date { font-size: 12px; color: #52525b; margin-top: 3px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

  footer.doc-foot { margin-top: 32px; padding-top: 14px; border-top: 1px solid #e4e4e7;
    font-size: 11px; color: #a1a1aa; text-align: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

  @media (max-width: 640px) {
    .parties, .signatures { grid-template-columns: 1fr; }
  }

  @media print {
    body { background: #fff; }
    .toolbar { display: none; }
    .sheet { max-width: none; margin: 0; padding: 0; border: 0; border-radius: 0; box-shadow: none; }
    .clause { page-break-inside: avoid; }
  }
  @page { size: letter; margin: 1in; }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="t-title">Creator Services Agreement</span>
    <button type="button" onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="sheet">
    <header class="doc-head">
      <div class="wordmark">${ContractDocumentService.WORDMARK}</div>
      <h1>Creator Services Agreement</h1>
      <div class="doc-meta">${refLine}</div>
    </header>
    <div class="recital">${recital}</div>
    ${this.partiesBlock(creator, contract)}
    ${clauseHtml}
    ${this.signatureBlock(creator, contract)}
    <footer class="doc-foot">
      Confidential — for internal and party use only.
    </footer>
  </div>
</body>
</html>`;
  }
}
