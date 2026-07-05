/**
 * Loose typings for the subset of the Instantly v2 API this service consumes.
 *
 * Instantly's response field names vary across versions and endpoints, so these
 * interfaces intentionally allow index access and treat most fields as
 * optional. The mapper (instantly.mapper.ts) reads defensively from known
 * aliases rather than assuming an exact shape.
 */

/** Generic list envelope. Different endpoints use `items` or `data`. */
export interface InstantlyListResponse<T> {
  items?: T[];
  data?: T[];
  next_starting_after?: string | null;
  next_cursor?: string | null;
  [key: string]: unknown;
}

export interface InstantlyCampaign {
  id?: string;
  name?: string;
  campaign_name?: string;
  brand_name?: string;
  brandName?: string;
  [key: string]: unknown;
}

export interface InstantlyLead {
  id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  campaign?: string;
  campaign_id?: string;
  status?: number | string;
  /** Custom variables configured on the campaign live here in v2. */
  payload?: Record<string, unknown>;
  timestamp_last_contact?: string;
  [key: string]: unknown;
}

export interface InstantlyEmailBody {
  text?: string;
  html?: string;
}

export interface InstantlyEmail {
  id?: string;
  message_id?: string;
  thread_id?: string;
  from_address_email?: string;
  from?: string;
  to_address_email_list?: string;
  to?: string;
  subject?: string;
  timestamp_email?: string;
  timestamp?: string;
  body?: InstantlyEmailBody | string;
  content_preview?: string;
  eaccount?: string;
  [key: string]: unknown;
}
