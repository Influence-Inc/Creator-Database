/** A single field-level change to record in the audit log. */
export interface ActivityChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}
