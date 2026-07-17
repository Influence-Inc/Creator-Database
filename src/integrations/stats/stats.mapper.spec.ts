import { mapStatsToCreator, mapStatsToSnapshot } from './stats.mapper';
import { StatsCampaign, StatsCreator } from './stats.types';

describe('stats.mapper', () => {
  const creator: StatsCreator = {
    id: 'cr1',
    username: '@tharun.fyi',
    email: 'Tharun@Example.com',
    deadline: '2026-04-22',
    deliverables: {
      minViews: 200000,
      minVideos: 2,
      actualViews: 5700740,
      actualVideos: 3,
      allComplete: true,
    },
    videos: [
      {
        id: 'v1',
        title: 'Post 1',
        hasLinks: true,
        links: { instagram: 'https://instagram.com/reel/x', tiktok: 'https://tiktok.com/y' },
        views: { instagram: 67173, tiktok: 10100 },
        likes: { instagram: 4000, tiktok: 100 },
        comments: { instagram: 50, tiktok: 5 },
        totalViews: 77273,
        totalLikes: 4100,
        totalComments: 55,
      },
    ],
    totalViews: 5700740,
    totalLikes: 200000,
    totalComments: 4000,
    totalVideosPosted: 3,
    platforms: ['IG', 'TT'],
    commercials: {
      creatorAsk: 1800,
      budget: 1500,
      grossPay: 1500,
      bookedCpm: 30,
      realizedCpm: 0.26,
      risk: 'Low',
      paidAdRights: 'Included',
    },
  };

  const campaign: StatsCampaign = {
    id: 'camp1',
    name: 'Reve Features',
    brandName: 'Reve',
    slug: 'reve/reve-features',
  };

  describe('mapStatsToCreator', () => {
    it('folds identity, risk, cpm and derived engagement into the master record', () => {
      const input = mapStatsToCreator(creator);

      expect(input.email).toBe('tharun@example.com');
      expect(input.instagramUsername).toBe('tharun.fyi');
      expect(input.riskLevel).toBe('Low');
      // realized CPM wins over booked when > 0
      expect(input.cpm).toBe(0.26);
      // averages per posted video
      expect(input.averageViews).toBe(Math.round(5700740 / 3));
      expect(input.averageLikes).toBe(Math.round(200000 / 3));
      // engagement = (likes + comments) / views
      expect(input.engagementRate).toBeCloseTo((200000 + 4000) / 5700740, 4);
    });

    it('falls back to booked CPM when realized is missing', () => {
      const input = mapStatsToCreator({
        ...creator,
        commercials: { bookedCpm: 30, risk: 'High' },
      });
      expect(input.cpm).toBe(30);
      expect(input.riskLevel).toBe('High');
    });

    it('produces no identity when username and email are absent', () => {
      const input = mapStatsToCreator({ totalViews: 100 });
      expect(input.email).toBeUndefined();
      expect(input.instagramUsername).toBeUndefined();
    });
  });

  describe('mapStatsToSnapshot', () => {
    it('captures combined totals, commercials, deliverables and per-post detail', () => {
      const snap = mapStatsToSnapshot(creator, campaign)!;

      expect(snap.statsCampaignId).toBe('camp1');
      expect(snap.campaignName).toBe('Reve Features');
      expect(snap.brandName).toBe('Reve');
      expect(snap.platforms).toBe('IG, TT');
      expect(snap.totalViews).toBe(5700740);
      expect(snap.videosPosted).toBe(3);
      expect(snap.postCount).toBe(1);
      expect(snap.riskLevel).toBe('Low');
      expect(snap.bookedCpm).toBe(30);
      expect(snap.realizedCpm).toBe(0.26);
      expect(snap.minViews).toBe(200000);
      expect(snap.deliverablesComplete).toBe(true);
      expect(snap.deadline).toBeInstanceOf(Date);

      const videos = snap.videos as Array<{ totalViews: number; views: Record<string, number> }>;
      expect(videos).toHaveLength(1);
      expect(videos[0].totalViews).toBe(77273);
      expect(videos[0].views.instagram).toBe(67173);
    });

    it('returns null when the campaign has no id', () => {
      expect(mapStatsToSnapshot(creator, { name: 'x' })).toBeNull();
    });
  });
});
