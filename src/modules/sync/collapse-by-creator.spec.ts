import { collapseByCreator, mergeInputs, RankedRow } from './collapse-by-creator';

const row = (
  input: RankedRow<string>['input'],
  rank: number,
  tiebreak: string,
): RankedRow<string> => ({ input, rank, tiebreak, item: tiebreak });

describe('collapseByCreator', () => {
  it('folds one creator across campaigns into a single upsert; most recent campaign wins', () => {
    const groups = collapseByCreator([
      row(
        {
          email: 'a@x.co',
          campaignName: 'Old',
          campaignId: 'c-old',
          latestEmailDate: new Date('2026-01-01'),
        },
        new Date('2026-01-01').getTime(),
        'Old',
      ),
      row(
        {
          email: 'a@x.co',
          campaignName: 'New',
          campaignId: 'c-new',
          latestEmailDate: new Date('2026-03-01'),
        },
        new Date('2026-03-01').getTime(),
        'New',
      ),
      row({ email: 'b@x.co', campaignName: 'Old' }, 0, 'Old'),
    ]);

    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.input.email === 'a@x.co')!;
    expect(a.input.campaignName).toBe('New');
    expect(a.input.campaignId).toBe('c-new');
    expect(a.rows.map((r) => r.item)).toEqual(['New', 'Old']);
  });

  it('gives the same winner regardless of input order (no flip-flopping between runs)', () => {
    const rows = [
      row({ email: 'a@x.co', campaignName: 'Beta' }, 0, 'Beta'),
      row({ email: 'a@x.co', campaignName: 'Alpha' }, 0, 'Alpha'),
      row({ email: 'a@x.co', campaignName: 'Gamma' }, 0, 'Gamma'),
    ];
    const forward = collapseByCreator(rows)[0].input.campaignName;
    const reversed = collapseByCreator([...rows].reverse())[0].input.campaignName;
    expect(forward).toBe('Alpha');
    expect(reversed).toBe('Alpha');
  });

  it('links rows that share an email or a handle, transitively', () => {
    const groups = collapseByCreator([
      row({ email: 'a@x.co' }, 0, '1'),
      row({ email: 'a@x.co', instagramUsername: 'alice' }, 0, '2'),
      row({ instagramUsername: 'alice', averageViews: 500 }, 0, '3'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].input).toMatchObject({
      email: 'a@x.co',
      instagramUsername: 'alice',
      averageViews: 500,
    });
  });

  it('drops rows with no identity at all', () => {
    expect(collapseByCreator([row({ campaignName: 'X' }, 0, 'X')])).toEqual([]);
  });
});

describe('mergeInputs', () => {
  it('lets lower-ranked rows fill gaps but never override, and keeps the newest dates', () => {
    const merged = mergeInputs([
      { email: 'a@x.co', cpm: 10, latestEmailDate: new Date('2026-01-01') },
      { email: 'a@x.co', cpm: 99, followers: 1000, latestEmailDate: new Date('2026-02-01') },
    ]);
    expect(merged.cpm).toBe(10);
    expect(merged.followers).toBe(1000);
    expect(merged.latestEmailDate).toEqual(new Date('2026-02-01'));
  });
});
