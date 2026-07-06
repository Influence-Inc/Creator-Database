/**
 * Reusable prompt assets for Claude extraction. Centralised here so the exact
 * instructions and output contract are versioned in one place and can be unit
 * tested independently of the API call.
 */

/** Minimal message shape needed to render a thread for the model. */
export interface PromptMessage {
  sender?: string | null;
  recipient?: string | null;
  subject?: string | null;
  timestamp?: Date | null;
  rawEmail?: string | null;
}

/**
 * System prompt. It pins the output contract hard: a single JSON object, no
 * markdown, no prose, null for anything missing — and teaches the model to read
 * natural negotiation language ("2 reels for 40k" → accepted_rate 40000,
 * reels 2).
 */
export const EXTRACTION_SYSTEM_PROMPT = `You are a data-extraction engine for an influencer-marketing CRM.
You read an email thread between a brand/agency and a content creator and extract structured deal information.

Return ONLY a single JSON object matching EXACTLY this schema (same keys, same nesting):

{
  "name": string | null,
  "instagram": string | null,
  "email": string | null,
  "deadline": string | null,
  "campaign": string | null,
  "accepted_rate": number | null,
  "currency": string | null,
  "guaranteed_views": number | null,
  "deliverables": { "videos": number | null, "stories": number | null, "reels": number | null },
  "notes": string | null,
  "status": "Pending" | "Negotiating" | "Accepted" | "Rejected" | "Completed" | null
}

STRICT OUTPUT RULES:
- Output JSON only. No markdown, no code fences, no commentary, no explanation.
- If a value is not present or cannot be determined, use null. Never guess or invent values.
- "email" is the creator's email address, not the brand's/agency's.
- "instagram" is the creator's handle WITHOUT the leading @ (e.g. "janedoe").
- All monetary and view values must be plain integers with NO currency symbols,
  commas, or suffixes. Expand shorthand: "40k" -> 40000, "1.2m" -> 1200000, "2M" -> 2000000.
- "currency" is the 3-letter ISO code implied by the conversation (e.g. "USD", "GBP", "EUR").
  Infer from symbols ($ -> USD, £ -> GBP, € -> EUR) when stated; otherwise null.
- "deadline" is an ISO date "YYYY-MM-DD". Resolve relative/partial dates against the
  latest email date in the thread. If only a month/day is given, choose the nearest upcoming date.
- deliverables counts are integers; use null (not 0) when a deliverable type is not mentioned.
- "status" reflects the negotiation state from the creator's perspective in the latest messages.

INTERPRETATION EXAMPLES:
- "We can do 2 reels for 40k"    -> accepted_rate: 40000, deliverables.reels: 2
- "Deadline works for July 18"   -> deadline: "<year>-07-18"
- "We guarantee 2M views"        -> guaranteed_views: 2000000
- "We'll do 3 videos"            -> deliverables.videos: 3
- "Happy to move forward"        -> status: "Accepted"
- "Let me think about the rate"  -> status: "Negotiating"

Respond with the JSON object and nothing else.`;

/** Render an ordered thread into a single plain-text prompt body. */
export function buildThreadText(messages: PromptMessage[]): string {
  if (messages.length === 0) return 'No messages in this thread.';

  const parts = messages.map((m, index) => {
    const header = [
      `--- Message ${index + 1} ---`,
      m.timestamp ? `Date: ${m.timestamp.toISOString()}` : null,
      m.sender ? `From: ${m.sender}` : null,
      m.recipient ? `To: ${m.recipient}` : null,
      m.subject ? `Subject: ${m.subject}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    const body = (m.rawEmail ?? '').trim();
    return `${header}\n\n${body}`;
  });

  return `Email thread (oldest first):\n\n${parts.join('\n\n')}`;
}
