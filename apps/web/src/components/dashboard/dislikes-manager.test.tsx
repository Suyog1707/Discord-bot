import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DislikesManager, formatDislikedAt } from './dislikes-manager';

const ROW_A = {
  trackKey: 'alpha::1',
  title: 'Alpha',
  author: 'Artist A',
  isrc: null,
  source: 'button',
  createdAt: '2026-01-02T03:04:05.000Z',
};
const ROW_B = { ...ROW_A, trackKey: 'beta::2', title: 'Beta', author: 'Artist B' };
const ROW_C = { ...ROW_A, trackKey: 'gamma::3', title: 'Gamma', author: 'Artist C' };

const PAGE_ONE = { items: [ROW_A, ROW_B], nextCursor: 'cursor-2', total: 3 };
const PAGE_TWO = { items: [ROW_C], nextCursor: null };

/** Only the two members the component touches — enough for a `Response`. */
function response(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}
const success = (data: unknown) => response({ success: true, data });
const failure = (message: string) => response({ success: false, error: { code: 'X', message } });

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

/** The whole fetch surface of the component, per test overridable. */
let routes: {
  page: (url: string) => Promise<Response>;
  bulk: () => Promise<Response>;
  remove: () => Promise<Response>;
};

/** Every call the component made with this HTTP method. */
function callsWithMethod(method: string) {
  return fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method);
}

beforeEach(() => {
  routes = {
    page: (url) => Promise.resolve(success(url.includes('cursor=') ? PAGE_TWO : PAGE_ONE)),
    bulk: () => Promise.resolve(success({ removed: 2 })),
    remove: () => Promise.resolve(success({ removed: true })),
  };

  fetchMock.mockImplementation((input, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST') return routes.bulk();
    if (method === 'DELETE') return routes.remove();
    return routes.page(input);
  });

  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('formatDislikedAt', () => {
  it('shows a clock for today and a date for anything older', () => {
    expect(formatDislikedAt(new Date().toISOString())).toContain(':');
    expect(formatDislikedAt('2020-03-04T05:06:07.000Z')).not.toContain(':');
    expect(formatDislikedAt('not a date')).toBe('');
  });
});

describe('DislikesManager', () => {
  it('renders the first page once it arrives', async () => {
    render(<DislikesManager />);

    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('2 of 3 rejected tracks')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/user/dislikes?limit=50');
  });

  it('appends the next page and drops "Load more" at the end', async () => {
    render(<DislikesManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Gamma')).toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('3 of 3 rejected tracks')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/user/dislikes?cursor=cursor-2&limit=50');
  });

  it('removes a selection with one bulk request', async () => {
    render(<DislikesManager />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha by Artist A' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Beta by Artist B' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove selected \(2\)/ }));
    fireEvent.click(screen.getByRole('button', { name: /Yes, remove 2/ }));

    await waitFor(() => {
      expect(screen.queryByText('Alpha')).toBeNull();
    });
    expect(screen.queryByText('Beta')).toBeNull();

    const posts = callsWithMethod('POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[0]).toBe('/api/user/dislikes/remove');
    expect(JSON.parse(posts[0]?.[1]?.body as string)).toEqual({
      trackKeys: ['alpha::1', 'beta::2'],
    });
  });

  it('keeps the rows and shows the error when a bulk removal fails', async () => {
    routes.bulk = () => Promise.resolve(failure('Too many at once.'));
    render(<DislikesManager />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alpha by Artist A' }));
    fireEvent.click(screen.getByRole('button', { name: /Remove selected \(1\)/ }));
    fireEvent.click(screen.getByRole('button', { name: /Yes, remove 1/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many at once.');
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('removes a single row through the DELETE route', async () => {
    render(<DislikesManager />);
    await screen.findByText('Alpha');

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);

    await waitFor(() => {
      expect(screen.queryByText('Alpha')).toBeNull();
    });
    expect(screen.getByText('Beta')).toBeInTheDocument();

    const deletes = callsWithMethod('DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.[0]).toBe('/api/user/dislikes/alpha%3A%3A1');
    expect(screen.getByText('1 of 2 rejected tracks')).toBeInTheDocument();
  });
});
