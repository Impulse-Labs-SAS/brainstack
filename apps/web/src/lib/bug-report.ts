export type ReportKind = 'bug' | 'idea' | 'other';

export interface BugReport {
  kind: ReportKind;
  summary: string;
  details: string;
  /** Which part of the app: the first path segment, never a note's name. */
  area: string;
  userAgent: string;
}

const ISSUES = 'https://github.com/Impulse-Labs-SAS/brainstack/issues/new';

/**
 * Where a report goes: a new issue on the project's public tracker, filled in
 * and left for the person to read and submit. The dialog used to call a stub
 * and then say "Thanks for the report" — nothing was ever sent. A self-hosted
 * instance has nowhere else to send one that someone who can fix it will read.
 */
export function issueUrl(report: BugReport): string {
  const label = report.kind === 'bug' ? 'Bug' : report.kind === 'idea' ? 'Idea' : 'Feedback';
  const body = [
    report.details || '_No details given._',
    '',
    '---',
    `Area: ${report.area}`,
    `Browser: ${report.userAgent}`,
  ].join('\n');
  const params = new URLSearchParams({ title: `${label}: ${report.summary}`, body });
  return `${ISSUES}?${params.toString()}`;
}
