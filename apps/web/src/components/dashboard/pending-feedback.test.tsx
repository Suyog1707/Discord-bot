import { render, screen } from '@testing-library/react';
import type * as ReactDom from 'react-dom';
import { useFormStatus } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';

import { ActionMessage } from './action-message';
import { PendingSubmitButton } from './pending-submit-button';

// useFormStatus only reports pending inside a form mid-submit; stub it so each
// state can be rendered deterministically.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactDom>()),
  useFormStatus: vi.fn(),
}));
const status = (pending: boolean) =>
  vi.mocked(useFormStatus).mockReturnValue({
    pending,
    data: null,
    method: null,
    action: null,
  } as ReturnType<typeof useFormStatus>);

describe('PendingSubmitButton', () => {
  it('shows the resting label when idle', () => {
    status(false);
    render(<PendingSubmitButton pendingLabel="Importing…">Import</PendingSubmitButton>);
    const button = screen.getByRole('button', { name: 'Import' });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-busy', 'false');
  });

  it('shows a spinner, pending label and disabled state when pending', () => {
    status(true);
    const { container } = render(
      <PendingSubmitButton pendingLabel="Importing…">Import</PendingSubmitButton>,
    );
    const button = screen.getByRole('button', { name: 'Importing…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    const spinner = container.querySelector('svg.animate-spin');
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('ActionMessage', () => {
  it('renders a muted success message in a polite live region', () => {
    render(<ActionMessage result={{ status: 'success', message: 'Imported 3 tracks' }} />);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Imported 3 tracks');
    expect(region).toHaveClass('text-muted-foreground');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('renders errors in the destructive colour', () => {
    render(<ActionMessage result={{ status: 'error', message: 'Spotify denied access' }} />);
    expect(screen.getByRole('status')).toHaveClass('text-destructive');
  });

  it('renders an empty live region when idle', () => {
    render(<ActionMessage result={{ status: 'idle' }} />);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});
