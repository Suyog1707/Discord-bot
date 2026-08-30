# Dashboard

Overview, Servers, Player, Queue, Playlists, Favorites, Not like, History,
Analytics, Settings.

**Not like** (`/dashboard/dislikes`) lists the songs the signed-in listener has
rejected, from either surface — the 👎 button in the live player, `/dislike` in
Discord — with when and where each was rejected, and a Remove to undo one. A
rejected song never returns through autoplay; a skip is not a rejection, it only
weights what gets suggested.

The page is a thin server shell (auth + copy) around the `DislikesManager`
client component: it loads fifty rows from `GET /api/user/dislikes`, walks the
cursor with "Load more", and clears a checkbox selection in a single
`POST /api/user/dislikes/remove` behind a two-step confirm (the same arm-then-
commit pattern as History's "Clear all" — the UI kit has no dialog). Rows leave
the list without a refetch, so a removal never scrolls the listener back to page
one. The list is capped at 500 per listener; from 450 the header says so,
because at the cap the next 👎 in Discord fails instead of silently dropping the
oldest row.
