/** GET /api/playlist/:playlistId/export — download the playlist as JSON. */
import { NextResponse } from 'next/server';

import { authedRoute } from '@/lib/api-route';
import { exportPlaylist } from '@/lib/services/playlists';

export const dynamic = 'force-dynamic';

export const GET = authedRoute<{ playlistId: string }>(
  'GET /api/playlist/:playlistId/export',
  'read',
  async ({ user, params }) => {
    const document = await exportPlaylist(user.id, params.playlistId);
    const filename = `${document.name.replaceAll(/[^\w\- ]/gu, '').trim() || 'playlist'}.json`;

    return new NextResponse(JSON.stringify(document, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  },
);
